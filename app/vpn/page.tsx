'use client';

import * as React from 'react';
import {
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
} from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { apiPath, readJson } from '@/lib/client/api';

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
};

type OpenvpnProfile = {
  id: string;
  name: string;
  remotes: string[];
  proto: string | null;
  source: 'uploaded' | 'vpngate';
  enabled: number;
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

type SpeedResult = {
  downloadMbps: number;
  uploadMbps: number;
  testedAt: string;
};

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

type DeleteTarget = {
  kind: 'wireguard' | 'openvpn';
  id: string;
  name: string;
};

type Envelope<T = unknown> = {
  success?: boolean;
  data?: T;
  error?: string;
};

const PAGE_SIZE = 10;

function DetailRows({ rows }: { rows: Array<[string, React.ReactNode]> }) {
  return (
    <div className="divide-y rounded-lg border">
      {rows.map(([label, value]) => (
        <div key={label} className="flex items-start justify-between gap-6 px-4 py-3 text-sm">
          <span className="text-muted-foreground">{label}</span>
          <span className="max-w-[65%] break-words text-right font-medium">{value}</span>
        </div>
      ))}
    </div>
  );
}

export default function VpnPage() {
  const [tab, setTab] = React.useState<VpnTab>('overview');
  const [summary, setSummary] = React.useState<VpnSummary | null>(null);
  const [wireguardProfiles, setWireguardProfiles] = React.useState<WireguardProfile[]>([]);
  const [openvpnProfiles, setOpenvpnProfiles] = React.useState<OpenvpnProfile[]>([]);
  const [gateServers, setGateServers] = React.useState<VpnGateServer[]>([]);
  const [warp, setWarp] = React.useState<WarpStatus | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState('');
  const [gatePage, setGatePage] = React.useState(1);
  const [gateRefreshing, setGateRefreshing] = React.useState(false);
  const [editor, setEditor] = React.useState<ProfileEditor | null>(null);
  const [editorSaving, setEditorSaving] = React.useState(false);
  const [editorError, setEditorError] = React.useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = React.useState<DeleteTarget | null>(null);
  const [speed, setSpeed] = React.useState<SpeedResult | null>(null);
  const [speedBusy, setSpeedBusy] = React.useState(false);

  const loadStatus = React.useCallback(async () => {
    const response = await fetch(apiPath('/api/vpn/status'), { cache: 'no-store' });
    const payload = await readJson<Envelope<VpnSummary>>(response);
    if (response.ok && payload.success && payload.data) setSummary(payload.data);
  }, []);

  const loadWireguard = React.useCallback(async () => {
    const response = await fetch(apiPath('/api/vpn/wireguard'), { cache: 'no-store' });
    const payload = await readJson<Envelope<WireguardProfile[]>>(response);
    if (response.ok && payload.success && payload.data) setWireguardProfiles(payload.data);
  }, []);

  const loadOpenvpn = React.useCallback(async () => {
    const response = await fetch(apiPath('/api/vpn/openvpn'), { cache: 'no-store' });
    const payload = await readJson<Envelope<OpenvpnProfile[]>>(response);
    if (response.ok && payload.success && payload.data) setOpenvpnProfiles(payload.data);
  }, []);

  const loadWarp = React.useCallback(async () => {
    const response = await fetch(apiPath('/api/vpn/warp'), { cache: 'no-store' });
    const payload = await readJson<Envelope<WarpStatus>>(response);
    if (response.ok && payload.success && payload.data) setWarp(payload.data);
  }, []);

  const loadGate = React.useCallback(async (refresh = false) => {
    if (refresh) setGateRefreshing(true);
    try {
      const response = await fetch(apiPath(`/api/vpn/vpngate?refresh=${refresh}`), { cache: 'no-store' });
      const payload = await readJson<Envelope<VpnGateServer[]>>(response);
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || 'Unable to load VPNGate servers.');
      }
      setGateServers(payload.data);
      setGatePage(1);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (refresh) setGateRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void loadStatus();
    const timer = window.setInterval(() => void loadStatus(), 4_000);
    return () => window.clearInterval(timer);
  }, [loadStatus]);

  React.useEffect(() => {
    if (tab === 'wireguard') void loadWireguard();
    if (tab === 'openvpn') void loadOpenvpn();
    if (tab === 'vpngate') void loadGate();
    if (tab === 'warp') void loadWarp();
  }, [tab, loadGate, loadOpenvpn, loadWarp, loadWireguard]);

  React.useEffect(() => setGatePage(1), [search]);

  const action = React.useCallback(async (
    label: string,
    request: () => Promise<Response>,
    after?: () => Promise<void>,
  ) => {
    setBusy(label);
    setError(null);
    try {
      const response = await request();
      const payload = await readJson<Envelope>(response);
      if (!response.ok || !payload.success) throw new Error(payload.error || `${label} failed.`);
      if (after) await after();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      await loadStatus().catch(() => undefined);
      setBusy(null);
    }
  }, [loadStatus]);

  const active = summary?.status === 'connected';
  const operationBusy = Boolean(busy) || Boolean(summary?.isBusy) || summary?.status === 'connecting';
  const canConnect = !operationBusy && !active;
  const canDisconnect = !operationBusy && Boolean(active);
  const currentLabel = summary?.profileName || (summary?.type && summary.type !== 'off' ? summary.type : 'None');

  const connect = (type: 'wireguard' | 'openvpn', profileId: string) => action(
    `Connecting ${type}`,
    () => fetch(apiPath('/api/vpn/connect'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, profileId }),
    }),
  );

  const disconnect = () => action(
    'Disconnecting VPN',
    () => fetch(apiPath('/api/vpn/disconnect'), { method: 'POST' }),
  );

  const connectGate = (server: VpnGateServer) => action(
    `Connecting VPNGate ${server.countryShort}`,
    () => fetch(apiPath('/api/vpn/vpngate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'connect', serverId: server.id }),
    }),
  );

  const saveGate = (server: VpnGateServer) => action(
    'Saving VPNGate profile',
    () => fetch(apiPath('/api/vpn/vpngate'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', serverId: server.id }),
    }),
    loadOpenvpn,
  );

  const warpAction = (operation: 'register' | 'connect' | 'disconnect' | 'rotate') => action(
    `WARP ${operation}`,
    () => fetch(apiPath('/api/vpn/warp'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: operation }),
    }),
    loadWarp,
  );

  const runSpeedTest = async () => {
    setSpeedBusy(true);
    setError(null);
    try {
      const response = await fetch(apiPath('/api/vpn/speedtest'), { method: 'POST' });
      const payload = await readJson<Envelope<SpeedResult>>(response);
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error || 'Speed test failed.');
      setSpeed(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
    setEditor({
      kind,
      id: null,
      name: '',
      config: '',
      username: '',
      password: '',
      enabled: true,
      source: kind === 'openvpn' ? 'uploaded' : undefined,
    });
  };

  const openEdit = async (kind: 'wireguard' | 'openvpn', id: string) => {
    setBusy(`Loading ${kind} profile`);
    setError(null);
    setEditorError(null);
    try {
      const response = await fetch(apiPath(`/api/vpn/${kind}/${id}`), { cache: 'no-store' });
      const payload = await readJson<Envelope<ProfileEditor>>(response);
      if (!response.ok || !payload.success || !payload.data) throw new Error(payload.error || 'Unable to load profile.');
      setEditor({
        kind,
        id,
        name: payload.data.name || '',
        config: payload.data.config || '',
        username: payload.data.username || '',
        password: payload.data.password || '',
        enabled: Boolean(payload.data.enabled),
        source: payload.data.source,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
        : {
            name: editor.name,
            config: editor.config,
            username: editor.username || null,
            password: editor.password || null,
            ...(isEdit ? { enabled: editor.enabled } : { source: 'uploaded' }),
          };
      const response = await fetch(apiPath(endpoint), {
        method: isEdit ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await readJson<Envelope>(response);
      if (!response.ok || !result.success) throw new Error(result.error || 'Failed to save profile.');
      const kind = editor.kind;
      closeEditor();
      if (kind === 'wireguard') await loadWireguard();
      else await loadOpenvpn();
    } catch (err) {
      setEditorError(err instanceof Error ? err.message : String(err));
    } finally {
      setEditorSaving(false);
    }
  };

  const deleteProfile = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);
    await action(
      `Deleting ${target.kind} profile`,
      () => fetch(apiPath(`/api/vpn/${target.kind}/${target.id}`), { method: 'DELETE' }),
      target.kind === 'wireguard' ? loadWireguard : loadOpenvpn,
    );
  };

  const filteredGate = React.useMemo(
    () => gateServers.filter((server) => !search || `${server.countryLong} ${server.countryShort} ${server.ip} ${server.hostname}`.toLowerCase().includes(search.toLowerCase())),
    [gateServers, search],
  );
  const gatePages = Math.max(1, Math.ceil(filteredGate.length / PAGE_SIZE));
  const page = Math.min(gatePage, gatePages);
  const visibleGate = filteredGate.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  return (
    <AppShell>
      <PageHeader
        title="VPN"
        description="Manage the container's outbound route. Only one tunnel can be active at a time."
        actions={
          <>
            <Button variant="outline" onClick={() => void loadStatus()}>
              <RefreshCw />
              Refresh
            </Button>
            {active && (
              <Button variant="destructive" disabled={!canDisconnect} onClick={() => void disconnect()}>
                <Square />
                Disconnect
              </Button>
            )}
          </>
        }
      />

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}
      {busy && <Alert><RefreshCw className="mb-2 size-4 animate-spin" /><AlertDescription>{busy}…</AlertDescription></Alert>}
      {summary?.lastError && summary.status === 'error' && <Alert variant="destructive"><AlertDescription>{summary.lastError}</AlertDescription></Alert>}

      <Tabs value={tab} onValueChange={(value) => setTab(value as VpnTab)}>
        <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="wireguard">WireGuard</TabsTrigger>
          <TabsTrigger value="openvpn">OpenVPN</TabsTrigger>
          <TabsTrigger value="vpngate">VPNGate</TabsTrigger>
          <TabsTrigger value="warp">WARP</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2"><Shield className="size-4" />Connection</CardTitle>
                <CardDescription>Current outbound VPN state.</CardDescription>
              </CardHeader>
              <CardContent>
                <DetailRows rows={[
                  ['Status', <Badge key="status" variant={active ? 'success' : summary?.status === 'error' ? 'destructive' : 'secondary'}>{summary?.status || 'off'}</Badge>],
                  ['Type', summary?.type || 'off'],
                  ['Profile', currentLabel],
                  ['Public IP', summary?.publicIp || 'Unknown'],
                  ['Country', summary?.country || 'Unknown'],
                  ['Connected since', summary?.connectedSince ? new Date(summary.connectedSince).toLocaleString() : 'N/A'],
                ]} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex-row items-start justify-between gap-4">
                <div>
                  <CardTitle className="flex items-center gap-2"><Gauge className="size-4" />Speed test</CardTitle>
                  <CardDescription>Measures the current outbound route.</CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={() => void runSpeedTest()} disabled={speedBusy}>
                  <RefreshCw className={speedBusy ? 'animate-spin' : ''} />
                  {speedBusy ? 'Testing…' : 'Run test'}
                </Button>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 gap-4">
                  <div className="rounded-lg border p-4">
                    <div className="text-sm text-muted-foreground">Download</div>
                    <div className="mt-2 text-2xl font-semibold">{speed ? speed.downloadMbps.toFixed(2) : '—'} <span className="text-sm font-normal text-muted-foreground">Mbps</span></div>
                  </div>
                  <div className="rounded-lg border p-4">
                    <div className="text-sm text-muted-foreground">Upload</div>
                    <div className="mt-2 text-2xl font-semibold">{speed ? speed.uploadMbps.toFixed(2) : '—'} <span className="text-sm font-normal text-muted-foreground">Mbps</span></div>
                  </div>
                </div>
                {speed && <div className="mt-3 text-xs text-muted-foreground">Last tested {new Date(speed.testedAt).toLocaleString()}</div>}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="wireguard">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>WireGuard profiles</CardTitle>
                <CardDescription>Imported WireGuard configurations available to the proxy.</CardDescription>
              </div>
              <Button size="sm" onClick={() => openCreate('wireguard')}><Plus />Add profile</Button>
            </CardHeader>
            <CardContent>
              {wireguardProfiles.length === 0 ? (
                <EmptyState title="No WireGuard profiles" description="Add a configuration to connect through WireGuard." />
              ) : (
                <div className="divide-y rounded-lg border">
                  {wireguardProfiles.map((profile) => {
                    const isActive = active && summary?.type === 'wireguard' && summary.profileId === profile.id;
                    return (
                      <div key={profile.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{profile.name}</span>
                            {isActive && <Badge variant="success">Connected</Badge>}
                            {!profile.enabled && <Badge variant="secondary">Disabled</Badge>}
                          </div>
                          <div className="mt-1 truncate text-sm text-muted-foreground">{profile.endpoint || profile.address || 'Configured'}</div>
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" disabled={!canConnect || isActive || !profile.enabled} onClick={() => void connect('wireguard', profile.id)}>{isActive ? 'Connected' : 'Connect'}</Button>
                          <Button variant="ghost" size="icon" disabled={isActive || operationBusy} onClick={() => void openEdit('wireguard', profile.id)} aria-label={`Edit ${profile.name}`}><Pencil /></Button>
                          <Button variant="ghost" size="icon" disabled={isActive || operationBusy} onClick={() => setDeleteTarget({ kind: 'wireguard', id: profile.id, name: profile.name })} aria-label={`Delete ${profile.name}`}><Trash2 /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="openvpn">
          <Card>
            <CardHeader className="flex-row items-start justify-between gap-4">
              <div>
                <CardTitle>OpenVPN profiles</CardTitle>
                <CardDescription>Uploaded configurations and VPNGate servers saved as profiles.</CardDescription>
              </div>
              <Button size="sm" onClick={() => openCreate('openvpn')}><Plus />Add profile</Button>
            </CardHeader>
            <CardContent>
              {openvpnProfiles.length === 0 ? (
                <EmptyState title="No OpenVPN profiles" description="Upload a configuration or save a VPNGate server." />
              ) : (
                <div className="divide-y rounded-lg border">
                  {openvpnProfiles.map((profile) => {
                    const isActive = active && summary?.type === 'openvpn' && summary.profileId === profile.id;
                    return (
                      <div key={profile.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{profile.name}</span>
                            {profile.source === 'vpngate' && <Badge variant="outline">VPNGate</Badge>}
                            {isActive && <Badge variant="success">Connected</Badge>}
                            {!profile.enabled && <Badge variant="secondary">Disabled</Badge>}
                          </div>
                          <div className="mt-1 truncate text-sm text-muted-foreground">{profile.remotes?.[0] || 'Configured'}</div>
                        </div>
                        <div className="flex gap-1">
                          <Button size="sm" disabled={!canConnect || isActive || !profile.enabled} onClick={() => void connect('openvpn', profile.id)}>{isActive ? 'Connected' : 'Connect'}</Button>
                          <Button variant="ghost" size="icon" disabled={isActive || operationBusy} onClick={() => void openEdit('openvpn', profile.id)} aria-label={`Edit ${profile.name}`}><Pencil /></Button>
                          <Button variant="ghost" size="icon" disabled={isActive || operationBusy} onClick={() => setDeleteTarget({ kind: 'openvpn', id: profile.id, name: profile.name })} aria-label={`Delete ${profile.name}`}><Trash2 /></Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vpngate">
          <div className="space-y-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex flex-col gap-3 sm:flex-row">
                  <div className="relative flex-1">
                    <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search country, IP, or hostname" className="pl-9" />
                  </div>
                  <Button variant="outline" onClick={() => void loadGate(true)} disabled={gateRefreshing}>
                    <RefreshCw className={gateRefreshing ? 'animate-spin' : ''} />
                    {gateRefreshing ? 'Refreshing…' : 'Refresh servers'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Public VPNGate servers</CardTitle>
                <CardDescription>{filteredGate.length} matching servers · page {page} of {gatePages}</CardDescription>
              </CardHeader>
              <CardContent>
                {visibleGate.length === 0 ? (
                  <EmptyState title="No VPNGate servers found" description="Refresh the list or change your search." />
                ) : (
                  <div className="divide-y rounded-lg border">
                    {visibleGate.map((server) => {
                      const isActive = active && summary?.profileId === `vpngate:${server.id}`;
                      return (
                        <div key={server.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-medium">{server.countryLong}</span>
                              <Badge variant="outline">{server.countryShort}</Badge>
                              {isActive && <Badge variant="success">Connected</Badge>}
                            </div>
                            <div className="mt-1 font-mono text-xs text-muted-foreground">{server.ip}</div>
                            <div className="mt-1 text-xs text-muted-foreground">{server.ping || 'N/A'} ms · {(server.speed / 1_000_000).toFixed(1)} Mbps · {server.sessions} sessions</div>
                          </div>
                          <div className="flex gap-2">
                            <Button size="sm" disabled={!canConnect || isActive} onClick={() => void connectGate(server)}><Play />{isActive ? 'Connected' : 'Connect'}</Button>
                            <Button variant="outline" size="sm" disabled={operationBusy} onClick={() => void saveGate(server)}><Save />Save</Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div className="mt-4 flex justify-end gap-2">
                  <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setGatePage((current) => Math.max(1, current - 1))}><ChevronLeft />Previous</Button>
                  <Button variant="outline" size="sm" disabled={page >= gatePages} onClick={() => setGatePage((current) => Math.min(gatePages, current + 1))}>Next<ChevronRight /></Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="warp">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Cloudflare WARP</CardTitle>
                <CardDescription>Local WARP client status.</CardDescription>
              </CardHeader>
              <CardContent>
                <DetailRows rows={[
                  ['Installed', warp?.installed ? 'Yes' : 'No'],
                  ['Service', warp?.daemonRunning ? 'Running' : 'Stopped'],
                  ['Registered', warp?.registered ? 'Yes' : 'No'],
                  ['Connected', warp?.connected ? 'Yes' : 'No'],
                  ['Mode', warp?.mode || 'Unknown'],
                  ['Account', warp?.accountType || 'Unknown'],
                  ['Device', warp?.deviceId || 'Unknown'],
                ]} />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Actions</CardTitle>
                <CardDescription>Register, connect, disconnect, or rotate the WARP identity.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-2">
                  <Button variant="outline" disabled={operationBusy || active || !warp?.installed || Boolean(warp?.registered)} onClick={() => void warpAction('register')}>Register</Button>
                  <Button disabled={!canConnect || !warp?.installed || !warp?.registered || Boolean(warp?.connected)} onClick={() => void warpAction('connect')}>Connect</Button>
                  <Button variant="outline" disabled={operationBusy || !active || summary?.type !== 'warp'} onClick={() => void warpAction('disconnect')}>Disconnect</Button>
                  <Button variant="outline" disabled={operationBusy || !warp?.installed || !warp?.registered || (active && summary?.type !== 'warp')} onClick={() => void warpAction('rotate')}>Rotate</Button>
                </div>
                {warp?.details && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs text-muted-foreground">{warp.details}</pre>}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(editor)} onOpenChange={(open) => !open && closeEditor()}>
        <DialogContent className="max-w-2xl">
          {editor && (
            <>
              <DialogHeader>
                <DialogTitle>{editor.id ? 'Edit' : 'Add'} {editor.kind === 'wireguard' ? 'WireGuard' : 'OpenVPN'} profile</DialogTitle>
                <DialogDescription>Paste a complete, valid VPN configuration.</DialogDescription>
              </DialogHeader>

              {editorError && (
                <Alert variant="destructive" className="mb-5">
                  <AlertTitle>Validation error</AlertTitle>
                  <AlertDescription>{editorError}</AlertDescription>
                </Alert>
              )}

              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="vpn-profile-name">Name</Label>
                  <Input id="vpn-profile-name" value={editor.name} onChange={(event) => setEditor({ ...editor, name: event.target.value })} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="vpn-profile-config">Configuration</Label>
                  <Textarea id="vpn-profile-config" rows={14} spellCheck={false} value={editor.config} onChange={(event) => setEditor({ ...editor, config: event.target.value })} className="font-mono text-xs" />
                </div>

                {editor.kind === 'openvpn' && (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="vpn-profile-username">Username</Label>
                      <Input id="vpn-profile-username" value={editor.username} onChange={(event) => setEditor({ ...editor, username: event.target.value })} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="vpn-profile-password">Password</Label>
                      <Input id="vpn-profile-password" type="password" value={editor.password} onChange={(event) => setEditor({ ...editor, password: event.target.value })} />
                    </div>
                  </div>
                )}

                {editor.id && (
                  <label className="flex items-center justify-between rounded-lg border p-3 text-sm">
                    <span>Enabled</span>
                    <input type="checkbox" checked={editor.enabled} onChange={(event) => setEditor({ ...editor, enabled: event.target.checked })} className="size-4 accent-current" />
                  </label>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={closeEditor}>Cancel</Button>
                <Button disabled={editorSaving || !editor.name.trim() || !editor.config.trim()} onClick={() => void saveProfile()}>
                  <Save />
                  {editorSaving ? 'Saving…' : 'Save profile'}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete VPN profile?</DialogTitle>
            <DialogDescription>{deleteTarget ? `${deleteTarget.name} will be permanently removed.` : 'This profile will be removed.'}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void deleteProfile()}>Delete profile</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
