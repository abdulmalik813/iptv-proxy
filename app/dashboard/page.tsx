'use client';

import * as React from 'react';
import Link from 'next/link';
import {
  Activity,
  Database,
  RefreshCw,
  Server,
  Shield,
  TriangleAlert,
  Tv,
  Users,
} from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiPath, readJson } from '@/lib/client/api';

interface HealthData {
  tunAvailable: boolean;
  wireguardInstalled: boolean;
  openvpnInstalled: boolean;
  warpInstalled: boolean;
  dbPath: string;
  dbSizeFormatted: string;
  dbWalMode: boolean;
  activeProviders: number;
  totalProviders: number;
  totalLogs: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
  };
}

interface VpnData {
  status: 'off' | 'connecting' | 'connected' | 'error';
  type: 'off' | 'wireguard' | 'openvpn' | 'warp';
  profileName: string | null;
  publicIp: string | null;
  country: string | null;
}

interface ProviderSummary {
  id: string;
  name: string;
  route: string;
  host: string;
  is_default: number;
  enabled: number;
}

interface LogPreview {
  id: string;
  timestamp: string;
  level: string;
  source: string;
  category: string;
  message: string;
}

interface SystemStatus {
  go: {
    running: boolean;
    status: string;
    latencyMs: number;
    activeStreams: number;
    viewers: number;
  };
}

type Envelope<T> = { success?: boolean; data?: T; error?: string };

function formatUptime(seconds = 0) {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  if (days > 0) return `${days}d ${hours}h`;
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours}h ${minutes}m`;
}

export default function DashboardPage() {
  const [health, setHealth] = React.useState<HealthData | null>(null);
  const [vpn, setVpn] = React.useState<VpnData | null>(null);
  const [providers, setProviders] = React.useState<ProviderSummary[]>([]);
  const [recentWarnings, setRecentWarnings] = React.useState<LogPreview[]>([]);
  const [system, setSystem] = React.useState<SystemStatus | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(async (manual = false) => {
    if (manual) setRefreshing(true);
    setError(null);
    try {
      const [healthResponse, vpnResponse, providersResponse, logsResponse, systemResponse] = await Promise.all([
        fetch(apiPath('/api/system/health'), { cache: 'no-store' }),
        fetch(apiPath('/api/vpn/status'), { cache: 'no-store' }),
        fetch(apiPath('/api/providers'), { cache: 'no-store' }),
        fetch(apiPath('/api/logs?level=warning&limit=5'), { cache: 'no-store' }),
        fetch(apiPath('/api/system/status'), { cache: 'no-store' }),
      ]);

      const [healthPayload, vpnPayload, providersPayload, logsPayload, systemPayload] = await Promise.all([
        readJson<Envelope<HealthData>>(healthResponse),
        readJson<Envelope<VpnData>>(vpnResponse),
        readJson<Envelope<ProviderSummary[]>>(providersResponse),
        readJson<Envelope<LogPreview[]>>(logsResponse),
        readJson<Envelope<SystemStatus>>(systemResponse),
      ]);

      if (healthPayload.success && healthPayload.data) setHealth(healthPayload.data);
      if (vpnPayload.success && vpnPayload.data) setVpn(vpnPayload.data);
      if (providersPayload.success && providersPayload.data) setProviders(providersPayload.data);
      if (logsPayload.success && logsPayload.data) setRecentWarnings(logsPayload.data);
      if (systemPayload.success && systemPayload.data) setSystem(systemPayload.data);

      const failed = [healthResponse, vpnResponse, providersResponse, systemResponse].find((response) => !response.ok);
      if (failed) setError(`Some runtime data could not be loaded (HTTP ${failed.status}).`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load dashboard data.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const interval = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(interval);
  }, [load]);

  const enabledProviders = providers.filter((provider) => provider.enabled === 1).length;
  const defaultProvider = providers.find((provider) => provider.is_default === 1);
  const vpnConnected = vpn?.status === 'connected';

  return (
    <AppShell>
      <PageHeader
        title="Overview"
        description="Provider, stream, cache, VPN, and host status at a glance."
        actions={
          <Button variant="outline" onClick={() => void load(true)} disabled={refreshing}>
            <RefreshCw className={refreshing ? 'animate-spin' : ''} />
            Refresh
          </Button>
        }
      />

      {error && (
        <Alert variant="warning">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {Array.from({ length: 4 }).map((_, index) => <Skeleton key={index} className="h-28" />)}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <MetricCard
            label="VPN"
            value={vpnConnected ? 'Connected' : vpn?.status === 'connecting' ? 'Connecting' : vpn?.status === 'error' ? 'Error' : 'Direct'}
            description={vpnConnected ? `${vpn?.profileName || vpn.type} · ${vpn.publicIp || 'IP unavailable'}` : 'Host network egress'}
            icon={<Shield className="size-5" />}
            valueClassName={vpnConnected ? 'text-emerald-600 dark:text-emerald-400' : undefined}
          />
          <MetricCard
            label="Providers"
            value={`${enabledProviders} / ${providers.length}`}
            description={defaultProvider ? `Default: ${defaultProvider.name}` : 'No default provider'}
            icon={<Tv className="size-5" />}
          />
          <MetricCard
            label="Live streams"
            value={system?.go.activeStreams ?? 0}
            description={`${system?.go.viewers ?? 0} active viewer${system?.go.viewers === 1 ? '' : 's'}`}
            icon={<Users className="size-5" />}
          />
          <MetricCard
            label="Database"
            value={health?.dbSizeFormatted || 'Ready'}
            description={health?.dbWalMode ? 'SQLite · WAL mode' : 'SQLite'}
            icon={<Database className="size-5" />}
          />
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle>Providers</CardTitle>
              <CardDescription>Configured upstream routes and their current state.</CardDescription>
            </div>
            <Link href="/providers" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Manage</Link>
          </CardHeader>
          <CardContent>
            {providers.length === 0 ? (
              <EmptyState
                icon={<Tv className="size-6" />}
                title="No providers configured"
                description="Add an Xtream provider to start routing IPTV traffic."
                action={<Link href="/providers" className={buttonVariants({ size: 'sm' })}>Add provider</Link>}
              />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Provider</TableHead>
                    <TableHead>Route</TableHead>
                    <TableHead>Upstream</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {providers.slice(0, 6).map((provider) => (
                    <TableRow key={provider.id}>
                      <TableCell>
                        <div className="flex items-center gap-2 font-medium">
                          {provider.name}
                          {provider.is_default === 1 && <Badge variant="secondary">Default</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">/{provider.route}</TableCell>
                      <TableCell className="max-w-72 truncate text-muted-foreground">{provider.host}</TableCell>
                      <TableCell>
                        <Badge variant={provider.enabled === 1 ? 'success' : 'secondary'}>
                          {provider.enabled === 1 ? 'Enabled' : 'Disabled'}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Runtime</CardTitle>
            <CardDescription>Core services and host capabilities.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            {[
              ['Go core', system?.go.running === true, system ? `${system.go.latencyMs} ms` : 'Checking'],
              ['TUN device', health?.tunAvailable === true, health?.tunAvailable ? 'Available' : 'Unavailable'],
              ['WireGuard', health?.wireguardInstalled === true, health?.wireguardInstalled ? 'Installed' : 'Unavailable'],
              ['OpenVPN', health?.openvpnInstalled === true, health?.openvpnInstalled ? 'Installed' : 'Unavailable'],
              ['Cloudflare WARP', health?.warpInstalled === true, health?.warpInstalled ? 'Installed' : 'Unavailable'],
            ].map(([label, ok, detail]) => (
              <div key={String(label)} className="flex items-center justify-between gap-3 border-b py-2 last:border-0">
                <span className="text-muted-foreground">{String(label)}</span>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{String(detail)}</span>
                  <span className={`size-2 rounded-full ${ok ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                </div>
              </div>
            ))}
            <div className="flex items-center justify-between gap-3 pt-1">
              <span className="text-muted-foreground">Host uptime</span>
              <span>{formatUptime(health?.environment.uptimeSeconds)}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Recent warnings</CardTitle>
            <CardDescription>Latest warning events from the application log.</CardDescription>
          </div>
          <Link href="/logs" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>View logs</Link>
        </CardHeader>
        <CardContent>
          {recentWarnings.length === 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground">
              <Activity className="size-4" />
              No recent warnings.
            </div>
          ) : (
            <div className="divide-y rounded-lg border">
              {recentWarnings.map((item) => (
                <div key={item.id} className="flex items-start gap-3 p-3">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{item.message}</div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {item.source} · {new Date(item.timestamp).toLocaleString()}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
