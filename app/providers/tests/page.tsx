'use client';

import * as React from 'react';
import { CheckCircle2, FlaskConical, RefreshCw, Server, XCircle } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { apiPath, readJson } from '@/lib/client/api';

interface ProviderItem {
  id: string;
  name: string;
  host: string;
  route: string;
  upstream_username: string;
  enabled: number;
}

interface ProviderTestData {
  provider: { id: string; name: string; host: string; route: string };
  reachable: boolean;
  authenticated: boolean;
  elapsedMs: number;
  testedAt: string;
  upstreamStatus?: number;
  upstreamStatusText?: string | null;
  account?: {
    username: string | null;
    status: string | null;
    expiresAt: string | number | null;
    isTrial: string | number | null;
    activeConnections: string | number | null;
    createdAt: string | number | null;
    maxConnections: string | number | null;
    allowedOutputFormats: unknown[];
  };
  server?: {
    url: string | null;
    port: string | number | null;
    httpsPort: string | number | null;
    protocol: string | null;
    rtmpPort: string | number | null;
    timezone: string | null;
    timestampNow: number | null;
    timeNow: string | null;
  } | null;
}

type TestState = { loading: boolean; data: ProviderTestData | null; error: string | null };
type Envelope<T = unknown> = { success?: boolean; data?: T; error?: string };

const emptyState: TestState = { loading: false, data: null, error: null };

function formatEpoch(value: string | number | null | undefined) {
  if (value === null || value === undefined || value === '') return 'N/A';
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return String(value);
  const date = new Date(numeric * 1000);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

function display(value: unknown) {
  return value === null || value === undefined || value === '' ? 'N/A' : String(value);
}

function DetailGrid({ items }: { items: Array<[string, string]> }) {
  return (
    <div className="grid overflow-hidden rounded-lg border sm:grid-cols-2 xl:grid-cols-4">
      {items.map(([label, value]) => (
        <div key={label} className="border-b p-3 sm:border-r xl:[&:nth-child(4n)]:border-r-0">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="mt-1 break-words text-sm font-medium">{value}</div>
        </div>
      ))}
    </div>
  );
}

export default function ProviderTestsPage() {
  const [providers, setProviders] = React.useState<ProviderItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [results, setResults] = React.useState<Record<string, TestState>>({});
  const [testingAll, setTestingAll] = React.useState(false);

  const loadProviders = React.useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(apiPath('/api/providers'), { cache: 'no-store' });
      const payload = await readJson<Envelope<ProviderItem[]>>(response);
      if (!response.ok || !payload.success || !payload.data) {
        throw new Error(payload.error || `Unable to load providers (HTTP ${response.status}).`);
      }
      setProviders(payload.data);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const testProvider = React.useCallback(async (provider: ProviderItem) => {
    setResults((current) => ({
      ...current,
      [provider.id]: { ...(current[provider.id] || emptyState), loading: true, error: null },
    }));

    try {
      const response = await fetch(apiPath(`/api/providers/${provider.id}/test`), { method: 'POST' });
      const payload = await readJson<Envelope<ProviderTestData>>(response);
      const data = payload.data || null;
      if (!response.ok || !payload.success) {
        setResults((current) => ({
          ...current,
          [provider.id]: {
            loading: false,
            data,
            error: payload.error || `Provider test failed with HTTP ${response.status}.`,
          },
        }));
        return;
      }
      setResults((current) => ({ ...current, [provider.id]: { loading: false, data, error: null } }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [provider.id]: { loading: false, data: null, error: error instanceof Error ? error.message : String(error) },
      }));
    }
  }, []);

  const testAll = async () => {
    setTestingAll(true);
    try {
      await Promise.all(providers.map((provider) => testProvider(provider)));
    } finally {
      setTestingAll(false);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Provider tests"
        description="Check Xtream authentication and server details. Non-JSON responses are shown as HTTP status only."
        actions={
          <>
            <Button variant="outline" onClick={() => void loadProviders()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Refresh
            </Button>
            <Button onClick={() => void testAll()} disabled={testingAll || providers.length === 0}>
              <FlaskConical />
              {testingAll ? 'Testing…' : 'Test all'}
            </Button>
          </>
        }
      />

      {loadError && (
        <Alert variant="destructive">
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
      )}

      {!loading && providers.length === 0 ? (
        <EmptyState
          icon={<FlaskConical className="size-6" />}
          title="No providers to test"
          description="Add a provider first, then return here to verify its account."
        />
      ) : (
        <div className="space-y-4">
          {providers.map((provider) => {
            const state = results[provider.id] || emptyState;
            const account = state.data?.account;
            const server = state.data?.server;
            const statusOnly = state.data?.upstreamStatus
              ? `HTTP ${state.data.upstreamStatus}${state.data.upstreamStatusText ? ` ${state.data.upstreamStatusText}` : ''}`
              : state.error;

            return (
              <Card key={provider.id}>
                <CardHeader className="flex-row items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>{provider.name}</CardTitle>
                      <Badge variant="outline" className="font-mono">/{provider.route}</Badge>
                      {provider.enabled !== 1 && <Badge variant="secondary">Disabled</Badge>}
                    </div>
                    <CardDescription className="mt-1 truncate">{provider.host} · {provider.upstream_username}</CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => void testProvider(provider)} disabled={state.loading}>
                    {state.loading ? <RefreshCw className="animate-spin" /> : <FlaskConical />}
                    {state.loading ? 'Testing…' : 'Test account'}
                  </Button>
                </CardHeader>

                {(state.error || (state.data && !account)) && (
                  <CardContent>
                    <Alert variant="destructive">
                      <XCircle className="mb-2 size-4" />
                      <AlertDescription>{statusOnly || 'Authentication failed.'}</AlertDescription>
                    </Alert>
                  </CardContent>
                )}

                {state.data && account && (
                  <CardContent className="space-y-5">
                    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-emerald-500/10 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                      <CheckCircle2 className="size-4" />
                      <span className="font-medium">Connected and authenticated</span>
                      <span className="text-xs opacity-80">{state.data.elapsedMs} ms</span>
                    </div>

                    <section className="space-y-2">
                      <h3 className="text-sm font-medium">Account</h3>
                      <DetailGrid
                        items={[
                          ['Username', display(account.username)],
                          ['Status', display(account.status)],
                          ['Expires', formatEpoch(account.expiresAt)],
                          ['Trial', display(account.isTrial)],
                          ['Active connections', display(account.activeConnections)],
                          ['Max connections', display(account.maxConnections)],
                          ['Created', formatEpoch(account.createdAt)],
                          ['Formats', account.allowedOutputFormats.length ? account.allowedOutputFormats.join(', ') : 'N/A'],
                        ]}
                      />
                    </section>

                    {server && (
                      <section className="space-y-2">
                        <h3 className="flex items-center gap-2 text-sm font-medium"><Server className="size-4" />Server</h3>
                        <DetailGrid
                          items={[
                            ['Server', display(server.url)],
                            ['Protocol', display(server.protocol)],
                            ['Port', display(server.port)],
                            ['HTTPS port', display(server.httpsPort)],
                            ['RTMP port', display(server.rtmpPort)],
                            ['Timezone', display(server.timezone)],
                            ['Server time', display(server.timeNow)],
                            ['Timestamp', display(server.timestampNow)],
                          ]}
                        />
                      </section>
                    )}
                  </CardContent>
                )}

                {!state.loading && !state.error && !state.data && (
                  <CardContent className="text-sm text-muted-foreground">Not tested yet.</CardContent>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
