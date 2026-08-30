'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Shield,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

type VpnTab = 'overview' | 'wireguard' | 'openvpn' | 'vpngate' | 'warp';
type VpnSummary = {
  status: 'off' | 'connecting' | 'connected' | 'error';
  type: 'off' | 'wireguard' | 'openvpn' | 'warp';
  profileId: string | null;
  profileName: string | null;
  connectedSince: string | null;
  publicIp: string | null;
  country: string | null;
  lastError: string | null;
  isBusy: boolean;
};
type WireguardProfile = { id: string; name: string; address: string | null; endpoint: string | null; enabled: number };
type OpenvpnProfile = { id: string; name: string; remotes: string[]; proto: string | null; source: 'uploaded' | 'vpngate'; enabled: number };
type VpnGateServer = { id: string; ip: string; hostname: string; countryLong: string; countryShort: string; ping: number; speed: number; score: number; sessions: number; uptime: number };
type WarpStatus = { installed: boolean; daemonRunning: boolean; registered: boolean; connected: boolean; mode?: string; accountType?: string; deviceId?: string; details: string };
type SpeedResult = { downloadMbps: number; uploadMbps: number; testedAt: string };
type ProfileEditor = {
  kind: 'wireguard' | 'openvpn';
  id: string | null;
  name: string;
  config: string;
  username: string;
  password: string;
  enabled: boolean;
  source?: 'uploaded' | 'vpngate';
};

const UI_BASE = process.env.NEXT_PUBLIC_UI_BASE_PATH || '/ui';
const apiPath = (path: string) => `${UI_BASE}${path}`;
const PAGE_SIZE = 10;

async function readJson(res: Response) {
  try { return await res.json(); } catch { return { success: false, error: `HTTP ${res.status}` }; }
}

export default function VpnPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [tab, setTab] = useState<VpnTab>('overview');
  const [summary, setSummary] = useState<VpnSummary | null>(null);
  const [wg, setWg] = useState<WireguardProfile[]>([]);
  const [ovpn, setOvpn] = useState<OpenvpnProfile[]>([]);
  const [gate, setGate] = useState<VpnGateServer[]>([]);
  const [warp, setWarp] = useState<WarpStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [gatePage, setGatePage] = useState(1);
  const [gateRefreshing, setGateRefreshing] = useState(false);
  const [editor, setEditor] = useState<ProfileEditor | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  const [speedBusy, setSpeedBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    const r = await fetch(apiPath('/api/vpn/status'), { cache: 'no-store' });
    if (r.status === 401) { router.replace('/login'); return; }
    const b = await readJson(r);
    if (r.ok && b.success) setSummary(b.data);
  }, [router]);

  const loadWg = useCallback(async () => {
    const r = await fetch(apiPath('/api/vpn/wireguard'), { cache: 'no-store' });
    const b = await readJson(r);
    if (r.ok && b.success) setWg(b.data);
  }, []);

  const loadOvpn = useCallback(async () => {
    const r = await fetch(apiPath('/api/vpn/openvpn'), { cache: 'no-store' });
    const b = await readJson(r);
    if (r.ok && b.success) setOvpn(b.data);
  }, []);

  const loadWarp = useCallback(async () => {
    const r = await fetch(apiPath('/api/vpn/warp'), { cache: 'no-store' });
    const b = await readJson(r);
    if (r.ok && b.success) setWarp(b.data);
  }, []);

  const loadGate = useCallback(async (refresh = false) => {
    if (refresh) setGateRefreshing(true);
    try {
      const r = await fetch(apiPath(`/api/vpn/vpngate?refresh=${refresh}`), { cache: 'no-store' });
      const b = await readJson(r);
      if (!r.ok || !b.success) throw new Error(b.error || 'Failed to load VPNGate');
      setGate(b.data);
      setGatePage(1);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (refresh) setGateRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void (async () => {
      const a = await fetch(apiPath('/api/auth/me'), { cache: 'no-store' });
      const b = await readJson(a);
      if (a.status === 401) { router.replace('/login'); return; }
      if (b.user) setUser(b.user);
      await loadStatus();
    })();
    const timer = setInterval(() => void loadStatus(), 4000);
    return () => clearInterval(timer);
  }, [loadStatus, router]);

  useEffect(() => {
    if (tab === 'wireguard') void loadWg();
    if (tab === 'openvpn') void loadOvpn();
    if (tab === 'vpngate') void loadGate(false);
    if (tab === 'warp') void loadWarp();
  }, [tab, loadWg, loadOvpn, loadGate, loadWarp]);

  useEffect(() => { setGatePage(1); }, [search]);

  const action = useCallback(async (label: string, fn: () => Promise<Response>, after?: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      const r = await fn();
      const b = await readJson(r);
      if (!r.ok || !b.success) throw new Error(b.error || `${label} failed`);
      if (after) await after();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await loadStatus().catch(() => undefined);
      setBusy(null);
    }
  }, [loadStatus]);

  const operationBusy = Boolean(busy) || Boolean(summary?.isBusy) || summary?.status === 'connecting';
  const active = summary?.status === 'connected';
  const canConnect = !operationBusy && !active && (summary?.status === 'off' || summary?.status === 'error' || !summary);
  const canDisconnect = !operationBusy && Boolean(active);
  const currentLabel = summary?.profileName || summary?.type || 'None';

  const connect = (type: 'wireguard' | 'openvpn', profileId: string) => action(
    `Connecting ${type}`,
    () => fetch(apiPath('/api/vpn/connect'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, profileId }) })
  );
  const disconnect = () => action('Disconnecting VPN', () => fetch(apiPath('/api/vpn/disconnect'), { method: 'POST' }));
  const gateConnect = (s: VpnGateServer) => action(
    `Connecting VPNGate ${s.countryShort}`,
    () => fetch(apiPath('/api/vpn/vpngate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'connect', serverId: s.id }) })
  );
  const gateSave = (s: VpnGateServer) => action(
    'Saving VPNGate profile',
    () => fetch(apiPath('/api/vpn/vpngate'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'save', serverId: s.id }) }),
    loadOvpn
  );
  const warpAction = (a: 'register' | 'connect' | 'disconnect' | 'rotate') => action(
    `WARP ${a}`,
    () => fetch(apiPath('/api/vpn/warp'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: a }) }),
    loadWarp
  );

  const runSpeedTest = async () => {
    setSpeedBusy(true);
    setError(null);
    try {
      const r = await fetch(apiPath('/api/vpn/speedtest'), { method: 'POST' });
      const b = await readJson(r);
      if (!r.ok || !b.success) throw new Error(b.error || 'Speed test failed');
      setSpeed(b.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSpeedBusy(false);
    }
  };

  const closeEditor = () => {
    setEditor(null);
    setEditorError(null);
  };

  const openCreate = (kind: 'wireguard' | 'openvpn') => {
    setEditorError(null);
    setEditor({ kind, id: null, name: '', config: '', username: '', password: '', enabled: true, source: kind === 'openvpn' ? 'uploaded' : undefined });
  };

  const openEdit = async (kind: 'wireguard' | 'openvpn', id: string) => {
    setBusy(`Loading ${kind} profile`);
    setError(null);
    setEditorError(null);
    try {
      const r = await fetch(apiPath(`/api/vpn/${kind}/${id}`), { cache: 'no-store' });
      const b = await readJson(r);
      if (!r.ok || !b.success) throw new Error(b.error || 'Unable to load profile');
      setEditor({
        kind,
        id,
        name: b.data.name || '',
        config: b.data.config || '',
        username: b.data.username || '',
        password: b.data.password || '',
        enabled: Boolean(b.data.enabled),
        source: b.data.source,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const saveProfile = async () => {
    if (!editor) return;
    setEditorSaving(true);
    setEditorError(null);
    try {
      const isEdit = Boolean(editor.id);
      const endpoint = isEdit ? `/api/vpn/${editor.kind}/${editor.id}` : `/api/vpn/${editor.kind}`;
      const payload = editor.kind === 'wireguard'
        ? { name: editor.name, config: editor.config, ...(isEdit ? { enabled: editor.enabled } : {}) }
        : { name: editor.name, config: editor.config, username: editor.username || null, password: editor.password || null, ...(isEdit ? { enabled: editor.enabled } : { source: 'uploaded' }) };
      const r = await fetch(apiPath(endpoint), { method: isEdit ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const b = await readJson(r);
      if (!r.ok || !b.success) throw new Error(b.error || 'Failed to save profile');
      closeEditor();
      if (editor.kind === 'wireguard') await loadWg(); else await loadOvpn();
    } catch (e) {
      setEditorError(e instanceof Error ? e.message : String(e));
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteProfile = async (kind: 'wireguard' | 'openvpn', id: string, name: string) => {
    if (!window.confirm(`Delete ${name}?`)) return;
    await action(
      `Deleting ${kind} profile`,
      () => fetch(apiPath(`/api/vpn/${kind}/${id}`), { method: 'DELETE' }),
      kind === 'wireguard' ? loadWg : loadOvpn
    );
  };

  const filteredGate = useMemo(() => gate.filter((s) => !search || `${s.countryLong} ${s.countryShort} ${s.ip} ${s.hostname}`.toLowerCase().includes(search.toLowerCase())), [gate, search]);
  const gatePages = Math.max(1, Math.ceil(filteredGate.length / PAGE_SIZE));
  const page = Math.min(gatePage, gatePages);
  const visibleGate = filteredGate.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const tabs: VpnTab[] = ['overview', 'wireguard', 'openvpn', 'vpngate', 'warp'];

  return (
    <div className="flex h-screen overflow-hidden bg-black font-mono text-neutral-200">
      <Sidebar user={user} onLogout={() => router.push('/login')} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />
        <main className="max-w-7xl space-y-5 p-4 sm:p-6 lg:p-8">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-800 pb-4">
            <div>
              <h1 className="flex items-center gap-2 text-base font-bold uppercase text-white"><Shield className="h-5 w-5" />VPN Management</h1>
              <p className="mt-1 text-xs text-neutral-500">One active tunnel at a time. WARP may rotate its own registration while connected.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void loadStatus()} className="border border-neutral-700 px-3 py-2 text-xs uppercase">Refresh</button>
              {active && <button disabled={!canDisconnect} onClick={() => void disconnect()} className="flex items-center gap-1 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black disabled:opacity-40"><Square className="h-3 w-3" />Disconnect</button>}
            </div>
          </div>

          {error && <div className="flex gap-2 border border-neutral-700 p-3 text-xs text-white"><AlertTriangle className="h-4 w-4 shrink-0" />{error}</div>}
          {busy && <div className="flex items-center gap-2 border border-neutral-800 p-3 text-xs"><RefreshCw className="h-4 w-4 animate-spin" />{busy}…</div>}
          {active && <div className="border border-neutral-700 bg-neutral-950 p-3 text-xs"><strong className="text-white">ACTIVE VPN:</strong> <span className="text-neutral-300">{currentLabel}. Disconnect before connecting a different tunnel.</span></div>}

          <div className="flex overflow-x-auto border-b border-neutral-800">
            {tabs.map((t) => <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 text-xs font-bold uppercase ${tab === t ? 'border-b-2 border-white text-white' : 'text-neutral-500'}`}>{t === 'vpngate' ? 'VPNGate' : t === 'warp' ? 'Cloudflare WARP' : t}</button>)}
          </div>

          {tab === 'overview' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="border border-neutral-800 bg-neutral-950 p-5 text-xs">
                <h2 className="mb-3 font-bold uppercase text-white">Current State</h2>
                {[
                  ['Status', summary?.status || 'off'], ['Type', summary?.type || 'off'], ['Profile / Server', currentLabel],
                  ['Public IP', summary?.publicIp || 'Unknown'], ['Country', summary?.country || 'Unknown'],
                  ['Connected Since', summary?.connectedSince ? new Date(summary.connectedSince).toLocaleString() : 'N/A'],
                ].map(([k, v]) => <div key={k} className="flex justify-between border-b border-neutral-900 py-2"><span className="text-neutral-500">{k}</span><span className="text-white">{v}</span></div>)}
                {summary?.lastError && <div className="mt-3 border border-neutral-700 p-3 text-neutral-300">{summary.lastError}</div>}
              </section>
              <section className="border border-neutral-800 bg-neutral-950 p-5 text-xs">
                <div className="mb-4 flex items-center justify-between gap-3"><h2 className="flex items-center gap-2 font-bold uppercase text-white"><Gauge className="h-4 w-4" />Egress Speed Test</h2><button disabled={speedBusy} onClick={() => void runSpeedTest()} className="flex items-center gap-2 border border-neutral-700 px-3 py-1.5 uppercase disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${speedBusy ? 'animate-spin' : ''}`} />{speedBusy ? 'Testing…' : 'Run Speed Test'}</button></div>
                <p className="mb-4 text-[10px] text-neutral-500">Measures the container&apos;s current outbound route, including the active VPN if connected. Runs only when requested.</p>
                <div className="grid grid-cols-2 gap-3">
                  <div className="border border-neutral-800 bg-black p-4"><div className="text-[10px] uppercase text-neutral-500">Download</div><div className="mt-1 text-xl font-bold text-white">{speed ? speed.downloadMbps.toFixed(2) : '—'} <span className="text-xs font-normal text-neutral-500">Mbps</span></div></div>
                  <div className="border border-neutral-800 bg-black p-4"><div className="text-[10px] uppercase text-neutral-500">Upload</div><div className="mt-1 text-xl font-bold text-white">{speed ? speed.uploadMbps.toFixed(2) : '—'} <span className="text-xs font-normal text-neutral-500">Mbps</span></div></div>
                </div>
                {speed && <div className="mt-3 text-[10px] text-neutral-600">Last test: {new Date(speed.testedAt).toLocaleString()}</div>}
              </section>
            </div>
          )}

          {tab === 'wireguard' && (
            <section className="border border-neutral-800 bg-neutral-950">
              <div className="flex items-center justify-between border-b border-neutral-800 p-4"><span className="text-xs font-bold uppercase text-white">WireGuard Profiles</span><button onClick={() => openCreate('wireguard')} className="flex items-center gap-1 border border-white bg-white px-3 py-1.5 text-xs font-bold uppercase text-black"><Plus className="h-3 w-3" />Add</button></div>
              {wg.map((p) => { const isActive = active && summary?.type === 'wireguard' && summary.profileId === p.id; return <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 p-4 text-xs"><div><div className="font-bold text-white">{p.name}</div><div className="text-neutral-500">{p.endpoint || 'Configured'} · {p.enabled ? 'enabled' : 'disabled'}</div></div><div className="flex gap-2"><button disabled={!canConnect || isActive || !p.enabled} onClick={() => void connect('wireguard', p.id)} className="border border-white bg-white px-3 py-1.5 font-bold uppercase text-black disabled:opacity-30">{isActive ? 'Connected' : 'Connect'}</button><button disabled={isActive || operationBusy} onClick={() => void openEdit('wireguard', p.id)} className="border border-neutral-700 p-1.5 disabled:opacity-30" title="Edit"><Pencil className="h-3.5 w-3.5" /></button><button disabled={isActive || operationBusy} onClick={() => void deleteProfile('wireguard', p.id, p.name)} className="border border-neutral-700 p-1.5 disabled:opacity-30" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button></div></div>; })}
              {!wg.length && <div className="p-6 text-xs text-neutral-500">No WireGuard profiles.</div>}
            </section>
          )}

          {tab === 'openvpn' && (
            <section className="border border-neutral-800 bg-neutral-950">
              <div className="flex items-center justify-between border-b border-neutral-800 p-4"><span className="text-xs font-bold uppercase text-white">OpenVPN Profiles</span><button onClick={() => openCreate('openvpn')} className="flex items-center gap-1 border border-white bg-white px-3 py-1.5 text-xs font-bold uppercase text-black"><Plus className="h-3 w-3" />Add</button></div>
              {ovpn.map((p) => { const isActive = active && summary?.type === 'openvpn' && summary.profileId === p.id; return <div key={p.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 p-4 text-xs"><div><div className="flex items-center gap-2 font-bold text-white"><span>{p.name}</span>{p.source === 'vpngate' && <span className="border border-neutral-700 px-1.5 py-0.5 text-[9px] font-normal uppercase text-neutral-400">Saved VPNGate</span>}</div><div className="text-neutral-500">{p.remotes?.[0] || 'Configured'} · {p.enabled ? 'enabled' : 'disabled'}</div></div><div className="flex gap-2"><button disabled={!canConnect || isActive || !p.enabled} onClick={() => void connect('openvpn', p.id)} className="border border-white bg-white px-3 py-1.5 font-bold uppercase text-black disabled:opacity-30">{isActive ? 'Connected' : 'Connect'}</button><button disabled={isActive || operationBusy} onClick={() => void openEdit('openvpn', p.id)} className="border border-neutral-700 p-1.5 disabled:opacity-30" title="Edit"><Pencil className="h-3.5 w-3.5" /></button><button disabled={isActive || operationBusy} onClick={() => void deleteProfile('openvpn', p.id, p.name)} className="border border-neutral-700 p-1.5 disabled:opacity-30" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button></div></div>; })}
              {!ovpn.length && <div className="p-6 text-xs text-neutral-500">No OpenVPN profiles.</div>}
            </section>
          )}

          {tab === 'vpngate' && (
            <section className="space-y-3">
              <div className="flex gap-2"><div className="relative flex-1"><Search className="absolute left-3 top-2.5 h-4 w-4 text-neutral-500" /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search country, IP, host" className="w-full border border-neutral-800 bg-black py-2 pl-9 pr-3 text-xs text-white" /></div><button disabled={gateRefreshing} onClick={() => void loadGate(true)} className="flex min-w-28 items-center justify-center gap-2 border border-neutral-700 px-3 text-xs uppercase disabled:cursor-wait disabled:opacity-60"><RefreshCw className={`h-3.5 w-3.5 ${gateRefreshing ? 'animate-spin' : ''}`} />{gateRefreshing ? 'Refreshing…' : 'Refresh'}</button></div>
              <div className="flex items-center justify-between text-[10px] text-neutral-500"><span>{filteredGate.length} relays · showing {visibleGate.length} per page</span><span>Page {page} / {gatePages}</span></div>
              <div className="border border-neutral-800 bg-neutral-950">
                {visibleGate.map((s) => { const isActive = active && summary?.profileId === `vpngate:${s.id}`; return <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-900 p-3 text-xs"><div><strong className="text-white">{s.countryLong} ({s.countryShort})</strong> <span className="text-neutral-400">{s.ip}</span><div className="text-[10px] text-neutral-500">{s.ping || 'N/A'} ms · {(s.speed / 1_000_000).toFixed(1)} Mbps · {s.sessions} sessions</div></div><div className="flex gap-2"><button disabled={!canConnect || isActive} onClick={() => void gateConnect(s)} className="flex items-center gap-1 border border-white bg-white px-2 py-1 font-bold uppercase text-black disabled:opacity-30"><Play className="h-3 w-3" />{isActive ? 'Connected' : 'Connect'}</button><button disabled={operationBusy} onClick={() => void gateSave(s)} className="flex items-center gap-1 border border-neutral-700 px-2 py-1 uppercase disabled:opacity-30"><Save className="h-3 w-3" />Save</button></div></div>; })}
                {!visibleGate.length && <div className="p-8 text-center text-xs text-neutral-500">No VPNGate relays match your search.</div>}
              </div>
              <div className="flex justify-end gap-2"><button disabled={page <= 1} onClick={() => setGatePage((p) => Math.max(1, p - 1))} className="flex items-center gap-1 border border-neutral-700 px-3 py-1.5 text-xs uppercase disabled:opacity-30"><ChevronLeft className="h-3 w-3" />Previous</button><button disabled={page >= gatePages} onClick={() => setGatePage((p) => Math.min(gatePages, p + 1))} className="flex items-center gap-1 border border-neutral-700 px-3 py-1.5 text-xs uppercase disabled:opacity-30">Next<ChevronRight className="h-3 w-3" /></button></div>
            </section>
          )}

          {tab === 'warp' && (
            <section className="grid gap-4 lg:grid-cols-2">
              <div className="border border-neutral-800 bg-neutral-950 p-5 text-xs">{[['Installed', warp?.installed ? 'YES' : 'NO'], ['Service', warp?.daemonRunning ? 'RUNNING' : 'STOPPED'], ['Registered', warp?.registered ? 'YES' : 'NO'], ['Connected', warp?.connected ? 'YES' : 'NO'], ['Mode', warp?.mode || 'Unknown'], ['Account', warp?.accountType || 'Unknown'], ['Device', warp?.deviceId || 'Unknown']].map(([k, v]) => <div key={k} className="flex justify-between gap-4 border-b border-neutral-900 py-2"><span className="text-neutral-500">{k}</span><span className="max-w-[60%] truncate text-white">{v}</span></div>)}</div>
              <div className="border border-neutral-800 bg-neutral-950 p-5"><h2 className="mb-3 text-xs font-bold uppercase text-white">WARP Actions</h2><div className="grid grid-cols-2 gap-2 text-xs"><button disabled={operationBusy || active || !warp?.installed || Boolean(warp?.registered)} onClick={() => void warpAction('register')} className="border border-neutral-700 p-2 uppercase disabled:opacity-30">Register</button><button disabled={!canConnect || !warp?.installed || !warp?.registered || Boolean(warp?.connected)} onClick={() => void warpAction('connect')} className="border border-white bg-white p-2 font-bold uppercase text-black disabled:opacity-30">Connect</button><button disabled={operationBusy || !active || summary?.type !== 'warp'} onClick={() => void warpAction('disconnect')} className="border border-neutral-700 p-2 uppercase disabled:opacity-30">Disconnect</button><button disabled={operationBusy || !warp?.installed || !warp?.registered || (active && summary?.type !== 'warp')} onClick={() => void warpAction('rotate')} className="border border-neutral-700 p-2 uppercase disabled:opacity-30">Rotate</button></div><p className="mt-3 text-[10px] text-neutral-500">Rotate creates a new WARP registration. If WARP is currently connected, it disconnects briefly, rotates, and reconnects automatically.</p><div className="mt-3 whitespace-pre-wrap break-words border border-neutral-900 bg-black p-3 text-[10px] text-neutral-500">{warp?.details || 'No WARP status loaded.'}</div></div>
            </section>
          )}
        </main>
      </div>

      {editor && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 p-4">
          <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto border border-neutral-700 bg-neutral-950 p-5">
            <div className="mb-4 flex items-center justify-between"><div><h2 className="text-sm font-bold uppercase text-white">{editor.id ? 'Edit' : 'Add'} {editor.kind === 'wireguard' ? 'WireGuard' : 'OpenVPN'} Profile</h2>{editor.source === 'vpngate' && <p className="mt-1 text-[10px] uppercase text-neutral-500">Saved from VPNGate</p>}</div><button onClick={closeEditor} className="border border-neutral-700 p-1.5"><X className="h-4 w-4" /></button></div>
            <div className="space-y-4 text-xs">
              {editorError && <div className="flex items-start gap-2 border border-rose-800 bg-rose-950/30 p-3 text-rose-200"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><div><div className="font-bold uppercase">Validation error</div><div className="mt-1 break-words text-[11px] leading-relaxed">{editorError}</div></div></div>}
              <label className="block"><span className="mb-1 block text-neutral-500">Name</span><input value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} className="w-full border border-neutral-800 bg-black p-2 text-white" /></label>
              <label className="block"><span className="mb-1 block text-neutral-500">Configuration</span><textarea value={editor.config} onChange={(e) => setEditor({ ...editor, config: e.target.value })} rows={14} spellCheck={false} className="w-full border border-neutral-800 bg-black p-2 font-mono text-[11px] text-white" /></label>
              {editor.kind === 'openvpn' && <div className="grid gap-3 sm:grid-cols-2"><label><span className="mb-1 block text-neutral-500">Username</span><input value={editor.username} onChange={(e) => setEditor({ ...editor, username: e.target.value })} className="w-full border border-neutral-800 bg-black p-2 text-white" /></label><label><span className="mb-1 block text-neutral-500">Password</span><input type="password" value={editor.password} onChange={(e) => setEditor({ ...editor, password: e.target.value })} className="w-full border border-neutral-800 bg-black p-2 text-white" /></label></div>}
              {editor.id && <label className="flex items-center gap-2 text-neutral-400"><input type="checkbox" checked={editor.enabled} onChange={(e) => setEditor({ ...editor, enabled: e.target.checked })} />Enabled</label>}
              <div className="flex justify-end gap-2"><button onClick={closeEditor} className="border border-neutral-700 px-4 py-2 uppercase">Cancel</button><button disabled={editorSaving || !editor.name.trim() || !editor.config.trim()} onClick={() => void saveProfile()} className="flex items-center gap-2 border border-white bg-white px-4 py-2 font-bold uppercase text-black disabled:opacity-40"><Save className="h-3.5 w-3.5" />{editorSaving ? 'Saving…' : 'Save'}</button></div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}