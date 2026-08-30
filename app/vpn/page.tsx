'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  CheckCircle2,
  FileUp,
  Globe2,
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

type WireguardProfile = {
  id: string;
  name: string;
  address: string | null;
  endpoint: string | null;
  enabled: number;
  created_at: string;
  updated_at: string;
};

type OpenvpnProfile = {
  id: string;
  name: string;
  remotes: string[];
  proto: string | null;
  dev: string | null;
  hasCredentials: boolean;
  source: 'uploaded' | 'vpngate';
  enabled: number;
  created_at: string;
  updated_at: string;
};

type VpnGateServer = {
  id: string;
  ip: string;
  hostname: string;
  countryLong: string;
  countryShort: string;
  ping: number;
  speed: number;
  score: number;
  sessions: number;
  uptime: number;
};

type WarpStatus = {
  installed: boolean;
  daemonRunning: boolean;
  registered: boolean;
  connected: boolean;
  mode?: string;
  accountType?: string;
  deviceId?: string;
  details: string;
};

const tabLabels: Array<[VpnTab, string]> = [
  ['overview', 'Overview'],
  ['wireguard', 'WireGuard'],
  ['openvpn', 'OpenVPN'],
  ['vpngate', 'VPNGate'],
  ['warp', 'Cloudflare WARP'],
];

function formatSpeed(bitsPerSecond: number): string {
  if (!Number.isFinite(bitsPerSecond) || bitsPerSecond <= 0) return '0 Mbps';
  return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
}

function formatUptime(milliseconds: number): string {
  if (!milliseconds) return 'N/A';
  const hours = Math.floor(milliseconds / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

async function responseJson(res: Response): Promise<{ success?: boolean; error?: string; data?: unknown }> {
  try {
    return await res.json();
  } catch {
    return { success: false, error: `Server returned HTTP ${res.status}.` };
  }
}

export default function VpnPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [activeTab, setActiveTab] = useState<VpnTab>('overview');
  const [summary, setSummary] = useState<VpnSummary | null>(null);
  const [wireguardProfiles, setWireguardProfiles] = useState<WireguardProfile[]>([]);
  const [openvpnProfiles, setOpenvpnProfiles] = useState<OpenvpnProfile[]>([]);
  const [vpnGateServers, setVpnGateServers] = useState<VpnGateServer[]>([]);
  const [warpStatus, setWarpStatus] = useState<WarpStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [wgModal, setWgModal] = useState(false);
  const [wgName, setWgName] = useState('');
  const [wgConfig, setWgConfig] = useState('');

  const [ovpnModal, setOvpnModal] = useState(false);
  const [ovpnName, setOvpnName] = useState('');
  const [ovpnConfig, setOvpnConfig] = useState('');
  const [ovpnUsername, setOvpnUsername] = useState('');
  const [ovpnPassword, setOvpnPassword] = useState('');

  const [vpnGateLoading, setVpnGateLoading] = useState(false);
  const [vpnGateSearch, setVpnGateSearch] = useState('');
  const [vpnGateCountry, setVpnGateCountry] = useState('ALL');
  const [vpnGateMaxPing, setVpnGateMaxPing] = useState(300);
  const [vpnGateMinSpeed, setVpnGateMinSpeed] = useState(0);
  const [vpnGateSort, setVpnGateSort] = useState<'score' | 'ping' | 'speed'>('score');

  const loadStatus = useCallback(async () => {
    const res = await fetch('/api/vpn/status', { cache: 'no-store' });
    if (res.status === 401) {
      router.replace('/login');
      return;
    }
    const body = await responseJson(res);
    if (res.ok && body.success) setSummary(body.data as VpnSummary);
  }, [router]);

  const loadWireGuard = useCallback(async () => {
    const res = await fetch('/api/vpn/wireguard', { cache: 'no-store' });
    const body = await responseJson(res);
    if (res.ok && body.success) setWireguardProfiles(body.data as WireguardProfile[]);
  }, []);

  const loadOpenVpn = useCallback(async () => {
    const res = await fetch('/api/vpn/openvpn', { cache: 'no-store' });
    const body = await responseJson(res);
    if (res.ok && body.success) setOpenvpnProfiles(body.data as OpenvpnProfile[]);
  }, []);

  const loadWarp = useCallback(async () => {
    const res = await fetch('/api/vpn/warp', { cache: 'no-store' });
    const body = await responseJson(res);
    if (res.ok && body.success) setWarpStatus(body.data as WarpStatus);
  }, []);

  const loadVpnGate = useCallback(async (refresh = false) => {
    setVpnGateLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/vpn/vpngate?refresh=${refresh ? 'true' : 'false'}`, { cache: 'no-store' });
      const body = await responseJson(res);
      if (!res.ok || !body.success) throw new Error(body.error || 'Unable to load VPNGate servers.');
      setVpnGateServers(body.data as VpnGateServer[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setVpnGateLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const authRes = await fetch('/api/auth/me', { cache: 'no-store' });
        const auth = await responseJson(authRes);
        if (authRes.status === 401) {
          router.replace('/login');
          return;
        }
        if (!cancelled && authRes.ok) {
          const data = auth as { authenticated?: boolean; user?: { username: string } };
          if (data.authenticated && data.user) setUser(data.user);
        }
        await loadStatus();
      } catch (caught) {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    const timer = setInterval(() => void loadStatus(), 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [loadStatus, router]);

  useEffect(() => {
    if (activeTab === 'wireguard') void loadWireGuard();
    if (activeTab === 'openvpn') void loadOpenVpn();
    if (activeTab === 'vpngate') void loadVpnGate(false);
    if (activeTab === 'warp') void loadWarp();
  }, [activeTab, loadOpenVpn, loadVpnGate, loadWarp, loadWireGuard]);

  const runAction = useCallback(
    async (label: string, request: () => Promise<Response>, refresh?: () => Promise<void>) => {
      setError(null);
      setBusy(label);
      try {
        const res = await request();
        const body = await responseJson(res);
        if (!res.ok || !body.success) throw new Error(body.error || `${label} failed.`);
        await loadStatus();
        if (refresh) await refresh();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(null);
      }
    },
    [loadStatus]
  );

  const connectProfile = async (type: 'wireguard' | 'openvpn', profileId: string) => {
    await runAction(`Connecting ${type}`, () =>
      fetch('/api/vpn/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, profileId }),
      })
    );
  };

  const disconnect = async () => {
    await runAction('Disconnecting VPN', () => fetch('/api/vpn/disconnect', { method: 'POST' }));
  };

  const saveWireGuard = async (event: React.FormEvent) => {
    event.preventDefault();
    await runAction(
      'Saving WireGuard profile',
      () =>
        fetch('/api/vpn/wireguard', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: wgName, config: wgConfig }),
        }),
      loadWireGuard
    );
    if (!error) {
      setWgModal(false);
      setWgName('');
      setWgConfig('');
    }
  };

  const saveOpenVpn = async (event: React.FormEvent) => {
    event.preventDefault();
    await runAction(
      'Saving OpenVPN profile',
      () =>
        fetch('/api/vpn/openvpn', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: ovpnName,
            config: ovpnConfig,
            username: ovpnUsername || null,
            password: ovpnPassword || null,
            source: 'uploaded',
          }),
        }),
      loadOpenVpn
    );
    setOvpnModal(false);
    setOvpnName('');
    setOvpnConfig('');
    setOvpnUsername('');
    setOvpnPassword('');
  };

  const renameProfile = async (type: 'wireguard' | 'openvpn', id: string, currentName: string) => {
    const name = window.prompt('New profile name', currentName)?.trim();
    if (!name || name === currentName) return;
    await runAction(
      `Renaming ${type} profile`,
      () =>
        fetch(`/api/vpn/${type}/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      type === 'wireguard' ? loadWireGuard : loadOpenVpn
    );
  };

  const deleteProfile = async (type: 'wireguard' | 'openvpn', id: string, name: string) => {
    if (!window.confirm(`Delete ${type} profile "${name}"?`)) return;
    await runAction(
      `Deleting ${type} profile`,
      () => fetch(`/api/vpn/${type}/${id}`, { method: 'DELETE' }),
      type === 'wireguard' ? loadWireGuard : loadOpenVpn
    );
  };

  const vpnGateAction = async (server: VpnGateServer, action: 'connect' | 'save') => {
    await runAction(
      action === 'connect' ? `Connecting VPNGate ${server.countryShort}` : 'Saving VPNGate profile',
      () =>
        fetch('/api/vpn/vpngate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, serverId: server.id }),
        }),
      action === 'save' ? loadOpenVpn : undefined
    );
  };

  const warpAction = async (action: 'register' | 'connect' | 'disconnect' | 'reset') => {
    await runAction(
      `WARP ${action}`,
      () =>
        fetch('/api/vpn/warp', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        }),
      loadWarp
    );
  };

  const countries = useMemo(
    () => Array.from(new Set(vpnGateServers.map((server) => server.countryShort))).sort(),
    [vpnGateServers]
  );

  const filteredVpnGate = useMemo(() => {
    const search = vpnGateSearch.trim().toLowerCase();
    const result = vpnGateServers.filter((server) => {
      const matchSearch =
        !search ||
        server.countryLong.toLowerCase().includes(search) ||
        server.countryShort.toLowerCase().includes(search) ||
        server.ip.includes(search) ||
        server.hostname.toLowerCase().includes(search);
      const matchCountry = vpnGateCountry === 'ALL' || server.countryShort === vpnGateCountry;
      const matchPing = server.ping === 0 || server.ping <= vpnGateMaxPing;
      const matchSpeed = server.speed / 1_000_000 >= vpnGateMinSpeed;
      return matchSearch && matchCountry && matchPing && matchSpeed;
    });

    return result.sort((a, b) => {
      if (vpnGateSort === 'ping') return (a.ping || Number.MAX_SAFE_INTEGER) - (b.ping || Number.MAX_SAFE_INTEGER);
      if (vpnGateSort === 'speed') return b.speed - a.speed;
      return b.score - a.score;
    });
  }, [vpnGateCountry, vpnGateMaxPing, vpnGateMinSpeed, vpnGateSearch, vpnGateServers, vpnGateSort]);

  const disabled = Boolean(busy) || summary?.isBusy || summary?.status === 'connecting';

  return (
    <div className="flex h-screen overflow-hidden bg-black font-mono text-neutral-200">
      <Sidebar user={user} onLogout={() => router.push('/login')} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />
        <main className="max-w-7xl space-y-6 p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col justify-between gap-4 border-b border-neutral-800 pb-4 sm:flex-row sm:items-center">
            <div>
              <h1 className="flex items-center gap-2 text-base font-bold uppercase tracking-tight text-white sm:text-lg">
                <Shield className="h-5 w-5" /> VPN Management
              </h1>
              <p className="text-xs text-neutral-500">One active tunnel at a time. WireGuard, OpenVPN, VPNGate, or Cloudflare WARP.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => void loadStatus()}
                disabled={disabled}
                className="flex items-center gap-2 border border-neutral-800 bg-neutral-950 px-3 py-2 text-xs uppercase text-neutral-300 hover:border-neutral-600 hover:text-white disabled:opacity-50"
              >
                <RefreshCw className="h-3.5 w-3.5" /> Refresh
              </button>
              {summary?.status !== 'off' && (
                <button
                  type="button"
                  onClick={() => void disconnect()}
                  disabled={disabled}
                  className="flex items-center gap-2 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black hover:bg-neutral-200 disabled:opacity-50"
                >
                  <Square className="h-3.5 w-3.5" /> Disconnect
                </button>
              )}
            </div>
          </div>

          {error && (
            <div className="flex items-start gap-2 border border-neutral-700 bg-neutral-950 p-3 text-xs text-white">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <span className="flex-1 break-words">{error}</span>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X className="h-4 w-4" /></button>
            </div>
          )}
          {busy && (
            <div className="flex items-center gap-2 border border-neutral-800 bg-neutral-950 p-3 text-xs text-neutral-300">
              <RefreshCw className="h-4 w-4 animate-spin" /> {busy}…
            </div>
          )}

          <div className="overflow-x-auto border-b border-neutral-800">
            <div className="flex min-w-max">
              {tabLabels.map(([tab, label]) => (
                <button
                  type="button"
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={`border-b-2 px-4 py-2.5 text-xs font-bold uppercase tracking-wide ${
                    activeTab === tab ? 'border-white bg-neutral-950 text-white' : 'border-transparent text-neutral-500 hover:text-white'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {activeTab === 'overview' && (
            <div className="grid gap-4 lg:grid-cols-2">
              <section className="border border-neutral-800 bg-neutral-950 p-5">
                <h2 className="mb-4 border-b border-neutral-800 pb-3 text-xs font-bold uppercase text-white">Current Tunnel</h2>
                {loading ? (
                  <div className="text-xs text-neutral-500">Loading status…</div>
                ) : (
                  <div className="space-y-2 text-xs">
                    {[
                      ['Status', summary?.status || 'off'],
                      ['Type', summary?.type || 'off'],
                      ['Profile / Server', summary?.profileName || 'None'],
                      ['Public IP', summary?.publicIp || 'Direct / unknown'],
                      ['Country', summary?.country || 'Unknown'],
                      ['Connected Since', summary?.connectedSince ? new Date(summary.connectedSince).toLocaleString() : 'N/A'],
                    ].map(([label, value]) => (
                      <div key={label} className="flex justify-between gap-4 border-b border-neutral-900 py-2 last:border-0">
                        <span className="text-neutral-500">{label}</span>
                        <span className="text-right text-white">{value}</span>
                      </div>
                    ))}
                  </div>
                )}
                {summary?.lastError && (
                  <div className="mt-4 border border-neutral-700 bg-black p-3 text-[11px] text-neutral-300">
                    <strong className="block pb-1 uppercase text-white">Last VPN Error</strong>
                    <span className="break-words">{summary.lastError}</span>
                  </div>
                )}
              </section>

              <section className="border border-neutral-800 bg-neutral-950 p-5 text-xs text-neutral-400">
                <h2 className="mb-4 border-b border-neutral-800 pb-3 font-bold uppercase text-white">Routing Policy</h2>
                <div className="space-y-3 leading-relaxed">
                  <p>Only one tunnel is allowed. Starting another tunnel first shuts down WireGuard, OpenVPN, and WARP, then establishes the selected connection.</p>
                  <p>Port-based policy routes preserve replies from the admin UI on port 3000 and the future Go proxy on port 8080, while normal outbound provider traffic can follow the VPN default route.</p>
                  <p>A tunnel is not marked connected only because a process started. The service checks the interface/process state and verifies external connectivity before persisting the connected state.</p>
                </div>
              </section>
            </div>
          )}

          {activeTab === 'wireguard' && (
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xs font-bold uppercase text-white">WireGuard Profiles</h2>
                  <p className="text-[11px] text-neutral-500">Private keys stay server-side and are never returned by the profile list API.</p>
                </div>
                <button type="button" onClick={() => setWgModal(true)} className="flex items-center gap-1.5 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black">
                  <Plus className="h-3.5 w-3.5" /> Add Profile
                </button>
              </div>
              <div className="overflow-x-auto border border-neutral-800 bg-neutral-950">
                <table className="w-full min-w-[720px] text-left text-xs">
                  <thead className="border-b border-neutral-800 bg-neutral-900 text-[10px] uppercase text-neutral-400">
                    <tr><th className="p-3">Name</th><th className="p-3">Address</th><th className="p-3">Endpoint</th><th className="p-3">State</th><th className="p-3 text-right">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-900">
                    {wireguardProfiles.map((profile) => {
                      const active = summary?.type === 'wireguard' && summary.profileId === profile.id && summary.status === 'connected';
                      return (
                        <tr key={profile.id}>
                          <td className="p-3 font-semibold text-white">{profile.name}</td>
                          <td className="p-3 text-neutral-400">{profile.address || 'Configured'}</td>
                          <td className="p-3 text-neutral-400">{profile.endpoint || 'Configured'}</td>
                          <td className="p-3">{active ? <span className="font-bold text-white">CONNECTED</span> : <span className="text-neutral-500">INACTIVE</span>}</td>
                          <td className="p-3"><div className="flex justify-end gap-2">
                            <button type="button" disabled={disabled || active} onClick={() => void connectProfile('wireguard', profile.id)} className="border border-white bg-white px-2 py-1 font-bold uppercase text-black disabled:opacity-40">Connect</button>
                            <button type="button" disabled={disabled} onClick={() => void renameProfile('wireguard', profile.id, profile.name)} className="border border-neutral-700 px-2 py-1 uppercase text-neutral-300">Rename</button>
                            <button type="button" disabled={disabled || active} onClick={() => void deleteProfile('wireguard', profile.id, profile.name)} className="border border-neutral-700 p-1 text-neutral-400"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div></td>
                        </tr>
                      );
                    })}
                    {!wireguardProfiles.length && <tr><td colSpan={5} className="p-8 text-center text-neutral-500">No WireGuard profiles saved.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'openvpn' && (
            <section className="space-y-4">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="text-xs font-bold uppercase text-white">OpenVPN Profiles</h2>
                  <p className="text-[11px] text-neutral-500">Configuration and passwords remain server-side. Potential command/plugin directives are rejected.</p>
                </div>
                <button type="button" onClick={() => setOvpnModal(true)} className="flex items-center gap-1.5 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black">
                  <Plus className="h-3.5 w-3.5" /> Add Profile
                </button>
              </div>
              <div className="overflow-x-auto border border-neutral-800 bg-neutral-950">
                <table className="w-full min-w-[760px] text-left text-xs">
                  <thead className="border-b border-neutral-800 bg-neutral-900 text-[10px] uppercase text-neutral-400">
                    <tr><th className="p-3">Name</th><th className="p-3">Remote</th><th className="p-3">Protocol</th><th className="p-3">Source</th><th className="p-3">State</th><th className="p-3 text-right">Actions</th></tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-900">
                    {openvpnProfiles.map((profile) => {
                      const active = summary?.type === 'openvpn' && summary.profileId === profile.id && summary.status === 'connected';
                      return (
                        <tr key={profile.id}>
                          <td className="p-3 font-semibold text-white">{profile.name}</td>
                          <td className="p-3 text-neutral-400">{profile.remotes[0] || 'Configured'}</td>
                          <td className="p-3 uppercase text-neutral-400">{profile.proto || 'auto'}</td>
                          <td className="p-3 uppercase text-neutral-400">{profile.source}</td>
                          <td className="p-3">{active ? <span className="font-bold text-white">CONNECTED</span> : <span className="text-neutral-500">INACTIVE</span>}</td>
                          <td className="p-3"><div className="flex justify-end gap-2">
                            <button type="button" disabled={disabled || active} onClick={() => void connectProfile('openvpn', profile.id)} className="border border-white bg-white px-2 py-1 font-bold uppercase text-black disabled:opacity-40">Connect</button>
                            <button type="button" disabled={disabled} onClick={() => void renameProfile('openvpn', profile.id, profile.name)} className="border border-neutral-700 px-2 py-1 uppercase text-neutral-300">Rename</button>
                            <button type="button" disabled={disabled || active} onClick={() => void deleteProfile('openvpn', profile.id, profile.name)} className="border border-neutral-700 p-1 text-neutral-400"><Trash2 className="h-3.5 w-3.5" /></button>
                          </div></td>
                        </tr>
                      );
                    })}
                    {!openvpnProfiles.length && <tr><td colSpan={6} className="p-8 text-center text-neutral-500">No OpenVPN profiles saved.</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'vpngate' && (
            <section className="space-y-4">
              <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
                <div>
                  <h2 className="text-xs font-bold uppercase text-white">VPNGate Live Servers</h2>
                  <p className="text-[11px] text-neutral-500">Server configs stay on the server. You can connect directly or save a relay as an OpenVPN profile.</p>
                </div>
                <button type="button" disabled={vpnGateLoading} onClick={() => void loadVpnGate(true)} className="flex items-center gap-1.5 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black disabled:opacity-50">
                  <RefreshCw className={`h-3.5 w-3.5 ${vpnGateLoading ? 'animate-spin' : ''}`} /> Refresh Servers
                </button>
              </div>

              <div className="grid gap-3 border border-neutral-800 bg-neutral-950 p-3 text-xs sm:grid-cols-2 lg:grid-cols-5">
                <label className="relative lg:col-span-2"><Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-neutral-500" /><input value={vpnGateSearch} onChange={(e) => setVpnGateSearch(e.target.value)} placeholder="Country, IP, host" className="w-full border border-neutral-800 bg-black py-2 pl-8 pr-2 text-white outline-none focus:border-white" /></label>
                <select value={vpnGateCountry} onChange={(e) => setVpnGateCountry(e.target.value)} className="border border-neutral-800 bg-black px-2 py-2 text-white outline-none focus:border-white"><option value="ALL">All countries</option>{countries.map((country) => <option key={country} value={country}>{country}</option>)}</select>
                <select value={vpnGateSort} onChange={(e) => setVpnGateSort(e.target.value as 'score' | 'ping' | 'speed')} className="border border-neutral-800 bg-black px-2 py-2 text-white outline-none focus:border-white"><option value="score">Sort: score</option><option value="ping">Sort: ping</option><option value="speed">Sort: speed</option></select>
                <div className="flex items-center gap-2"><span className="whitespace-nowrap text-neutral-500">Ping ≤</span><input type="number" min={1} max={1000} value={vpnGateMaxPing} onChange={(e) => setVpnGateMaxPing(Number(e.target.value) || 300)} className="w-full border border-neutral-800 bg-black px-2 py-2 text-white outline-none" /></div>
                <div className="flex items-center gap-2 lg:col-start-5"><span className="whitespace-nowrap text-neutral-500">Speed ≥</span><input type="number" min={0} value={vpnGateMinSpeed} onChange={(e) => setVpnGateMinSpeed(Number(e.target.value) || 0)} className="w-full border border-neutral-800 bg-black px-2 py-2 text-white outline-none" /><span className="text-neutral-500">Mbps</span></div>
              </div>

              <div className="overflow-x-auto border border-neutral-800 bg-neutral-950">
                <table className="w-full min-w-[880px] text-left text-xs">
                  <thead className="border-b border-neutral-800 bg-neutral-900 text-[10px] uppercase text-neutral-400"><tr><th className="p-3">Country</th><th className="p-3">IP / Host</th><th className="p-3">Ping</th><th className="p-3">Speed</th><th className="p-3">Score</th><th className="p-3">Sessions</th><th className="p-3">Uptime</th><th className="p-3 text-right">Actions</th></tr></thead>
                  <tbody className="divide-y divide-neutral-900">
                    {filteredVpnGate.slice(0, 250).map((server) => {
                      const active = summary?.profileId === `vpngate:${server.id}` && summary.status === 'connected';
                      return (
                        <tr key={server.id}>
                          <td className="p-3"><strong className="text-white">{server.countryShort}</strong> <span className="text-neutral-500">{server.countryLong}</span></td>
                          <td className="p-3"><div className="text-white">{server.ip}</div><div className="max-w-[180px] truncate text-[10px] text-neutral-500">{server.hostname}</div></td>
                          <td className="p-3 text-neutral-300">{server.ping || 'N/A'}{server.ping ? ' ms' : ''}</td>
                          <td className="p-3 text-neutral-300">{formatSpeed(server.speed)}</td>
                          <td className="p-3 text-neutral-300">{server.score.toLocaleString()}</td>
                          <td className="p-3 text-neutral-300">{server.sessions}</td>
                          <td className="p-3 text-neutral-300">{formatUptime(server.uptime)}</td>
                          <td className="p-3"><div className="flex justify-end gap-2">
                            {active ? <button type="button" onClick={() => void disconnect()} disabled={disabled} className="border border-white bg-white px-2 py-1 font-bold uppercase text-black">Disconnect</button> : <button type="button" onClick={() => void vpnGateAction(server, 'connect')} disabled={disabled} className="flex items-center gap-1 border border-white bg-white px-2 py-1 font-bold uppercase text-black disabled:opacity-40"><Play className="h-3 w-3" /> Connect</button>}
                            <button type="button" onClick={() => void vpnGateAction(server, 'save')} disabled={disabled} className="flex items-center gap-1 border border-neutral-700 px-2 py-1 uppercase text-neutral-300"><Save className="h-3 w-3" /> Save</button>
                          </div></td>
                        </tr>
                      );
                    })}
                    {!vpnGateLoading && !filteredVpnGate.length && <tr><td colSpan={8} className="p-8 text-center text-neutral-500">No VPNGate servers match the current filters.</td></tr>}
                    {vpnGateLoading && <tr><td colSpan={8} className="p-8 text-center text-neutral-500">Loading VPNGate servers…</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {activeTab === 'warp' && (
            <section className="grid gap-4 lg:grid-cols-2">
              <div className="border border-neutral-800 bg-neutral-950 p-5">
                <div className="mb-4 flex items-center justify-between border-b border-neutral-800 pb-3">
                  <h2 className="text-xs font-bold uppercase text-white">Cloudflare WARP</h2>
                  <button type="button" onClick={() => void loadWarp()} className="border border-neutral-800 p-1.5 text-neutral-400"><RefreshCw className="h-3.5 w-3.5" /></button>
                </div>
                <div className="space-y-2 text-xs">
                  {[
                    ['Client Installed', warpStatus?.installed ? 'YES' : 'NO'],
                    ['Service Running', warpStatus?.daemonRunning ? 'YES' : 'NO'],
                    ['Registered', warpStatus?.registered ? 'YES' : 'NO'],
                    ['Connected', warpStatus?.connected ? 'YES' : 'NO'],
                    ['Mode', warpStatus?.mode || 'Unknown'],
                    ['Account', warpStatus?.accountType || 'Unknown'],
                    ['Device ID', warpStatus?.deviceId || 'N/A'],
                  ].map(([label, value]) => <div key={label} className="flex justify-between gap-4 border-b border-neutral-900 py-2"><span className="text-neutral-500">{label}</span><span className="max-w-[60%] truncate text-white">{value}</span></div>)}
                </div>
              </div>
              <div className="border border-neutral-800 bg-neutral-950 p-5">
                <h2 className="mb-4 border-b border-neutral-800 pb-3 text-xs font-bold uppercase text-white">WARP Actions</h2>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" disabled={disabled || !warpStatus?.installed} onClick={() => void warpAction('register')} className="border border-neutral-700 bg-black px-3 py-2 text-xs uppercase text-white disabled:opacity-40">Register</button>
                  <button type="button" disabled={disabled || !warpStatus?.installed} onClick={() => void warpAction('connect')} className="border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black disabled:opacity-40">Connect</button>
                  <button type="button" disabled={disabled || !warpStatus?.installed} onClick={() => void warpAction('disconnect')} className="border border-neutral-700 bg-black px-3 py-2 text-xs uppercase text-white disabled:opacity-40">Disconnect</button>
                  <button type="button" disabled={disabled || !warpStatus?.installed} onClick={() => void warpAction('reset')} className="border border-neutral-700 bg-black px-3 py-2 text-xs uppercase text-white disabled:opacity-40">Reset</button>
                </div>
                <div className="mt-4 border border-neutral-900 bg-black p-3 text-[10px] leading-relaxed text-neutral-500 whitespace-pre-wrap break-words">{warpStatus?.details || 'No WARP status loaded.'}</div>
              </div>
            </section>
          )}
        </main>
      </div>

      {wgModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
          <form onSubmit={saveWireGuard} className="w-full max-w-xl space-y-4 border border-neutral-700 bg-neutral-950 p-5 text-xs">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3"><h2 className="font-bold uppercase text-white">Add WireGuard Profile</h2><button type="button" onClick={() => setWgModal(false)}><X className="h-4 w-4" /></button></div>
            <label className="block"><span className="mb-1 block uppercase text-neutral-500">Profile Name</span><input required value={wgName} onChange={(e) => setWgName(e.target.value)} className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none focus:border-white" /></label>
            <label className="block"><span className="mb-1 block uppercase text-neutral-500">Import .conf</span><input type="file" accept=".conf,text/plain" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setWgConfig(await file.text()); }} className="w-full border border-neutral-800 bg-black p-2 text-neutral-400 file:mr-3 file:border-0 file:bg-white file:px-2 file:py-1 file:text-xs file:font-bold file:text-black" /></label>
            <label className="block"><span className="mb-1 block uppercase text-neutral-500">Configuration</span><textarea required rows={12} value={wgConfig} onChange={(e) => setWgConfig(e.target.value)} className="w-full border border-neutral-800 bg-black p-3 font-mono text-[11px] text-white outline-none focus:border-white" placeholder="[Interface]\nPrivateKey = ...\nAddress = ...\n\n[Peer]\nPublicKey = ...\nEndpoint = ..." /></label>
            <p className="text-[10px] text-neutral-500">PreUp/PostUp/PreDown/PostDown commands are rejected. Private keys are stored in SQLite and are never returned by list/read APIs.</p>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setWgModal(false)} className="border border-neutral-700 px-4 py-2 uppercase text-neutral-300">Cancel</button><button type="submit" disabled={Boolean(busy)} className="flex items-center gap-1.5 border border-white bg-white px-4 py-2 font-bold uppercase text-black disabled:opacity-40"><FileUp className="h-3.5 w-3.5" /> Save</button></div>
          </form>
        </div>
      )}

      {ovpnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 p-4">
          <form onSubmit={saveOpenVpn} className="w-full max-w-xl space-y-4 border border-neutral-700 bg-neutral-950 p-5 text-xs">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3"><h2 className="font-bold uppercase text-white">Add OpenVPN Profile</h2><button type="button" onClick={() => setOvpnModal(false)}><X className="h-4 w-4" /></button></div>
            <label className="block"><span className="mb-1 block uppercase text-neutral-500">Profile Name</span><input required value={ovpnName} onChange={(e) => setOvpnName(e.target.value)} className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none focus:border-white" /></label>
            <label className="block"><span className="mb-1 block uppercase text-neutral-500">Import .ovpn</span><input type="file" accept=".ovpn,.conf,text/plain" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setOvpnConfig(await file.text()); }} className="w-full border border-neutral-800 bg-black p-2 text-neutral-400 file:mr-3 file:border-0 file:bg-white file:px-2 file:py-1 file:text-xs file:font-bold file:text-black" /></label>
            <div className="grid gap-3 sm:grid-cols-2"><label><span className="mb-1 block uppercase text-neutral-500">Username (optional)</span><input value={ovpnUsername} onChange={(e) => setOvpnUsername(e.target.value)} autoComplete="off" className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none" /></label><label><span className="mb-1 block uppercase text-neutral-500">Password (optional)</span><input type="password" value={ovpnPassword} onChange={(e) => setOvpnPassword(e.target.value)} autoComplete="new-password" className="w-full border border-neutral-800 bg-black px-3 py-2 text-white outline-none" /></label></div>
            <label className="block"><span className="mb-1 block uppercase text-neutral-500">Configuration</span><textarea required rows={12} value={ovpnConfig} onChange={(e) => setOvpnConfig(e.target.value)} className="w-full border border-neutral-800 bg-black p-3 font-mono text-[11px] text-white outline-none focus:border-white" placeholder="client\ndev tun\nproto udp\nremote ..." /></label>
            <p className="text-[10px] text-neutral-500">Profiles containing script hooks, executable plugins, or auth verification commands are rejected before storage.</p>
            <div className="flex justify-end gap-2"><button type="button" onClick={() => setOvpnModal(false)} className="border border-neutral-700 px-4 py-2 uppercase text-neutral-300">Cancel</button><button type="submit" disabled={Boolean(busy)} className="flex items-center gap-1.5 border border-white bg-white px-4 py-2 font-bold uppercase text-black disabled:opacity-40"><FileUp className="h-3.5 w-3.5" /> Save</button></div>
          </form>
        </div>
      )}
    </div>
  );
}
