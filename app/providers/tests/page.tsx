'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle2, FlaskConical, RefreshCw, Server, XCircle } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

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
  rawResponse?: string;
  rawContentType?: string;
  finalUrl?: string;
  requestMethod?: string;
  responseHeaders?: Record<string, string>;
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

type TestState = {
  loading: boolean;
  data: ProviderTestData | null;
  error: string | null;
};

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

async function parseResponse(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { success: false, error: raw };
  }
}

export default function ProviderTestsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [providers, setProviders] = useState<ProviderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, TestState>>({});
  const [testingAll, setTestingAll] = useState(false);

  const loadProviders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [authRes, providersRes] = await Promise.all([
        fetch('/api/auth/me', { cache: 'no-store' }),
        fetch('/api/providers', { cache: 'no-store' }),
      ]);

      if (authRes.status === 401) {
        router.replace('/login');
        return;
      }

      const auth = await parseResponse(authRes);
      const providerPayload = await parseResponse(providersRes);
      if (auth.authenticated) setUser(auth.user as { username: string });
      if (!providersRes.ok || !providerPayload.success) {
        throw new Error(String(providerPayload.error || `Unable to load providers (HTTP ${providersRes.status}).`));
      }
      setProviders(providerPayload.data as ProviderItem[]);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void loadProviders();
  }, [loadProviders]);

  const testProvider = useCallback(async (provider: ProviderItem) => {
    setResults((current) => ({
      ...current,
      [provider.id]: { ...(current[provider.id] || emptyState), loading: true, error: null },
    }));

    try {
      const response = await fetch(`/api/providers/${provider.id}/test`, { method: 'POST' });
      const payload = await parseResponse(response);
      const data = (payload.data || null) as ProviderTestData | null;
      if (!response.ok || !payload.success) {
        setResults((current) => ({
          ...current,
          [provider.id]: {
            loading: false,
            data,
            error: String(payload.error || `Provider test failed with HTTP ${response.status}.`),
          },
        }));
        return;
      }
      setResults((current) => ({
        ...current,
        [provider.id]: { loading: false, data, error: null },
      }));
    } catch (error) {
      setResults((current) => ({
        ...current,
        [provider.id]: {
          loading: false,
          data: null,
          error: error instanceof Error ? error.message : String(error),
        },
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
    <div className="flex h-screen overflow-hidden bg-black font-mono text-neutral-200">
      <Sidebar user={user} onLogout={() => router.push('/login')} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />
        <main className="max-w-7xl space-y-5 p-4 sm:p-6 lg:p-8">
          <div className="flex flex-col gap-4 border-b border-neutral-800 pb-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h1 className="flex items-center gap-2 text-base font-bold uppercase text-white sm:text-lg">
                <FlaskConical className="h-5 w-5" /> Provider Account Tests
              </h1>
              <p className="mt-1 text-xs text-neutral-500">
                Successful Xtream responses show account details. Failed HTML or text responses are shown as HTTP diagnostics without executing provider markup.
              </p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void loadProviders()} disabled={loading} className="flex items-center gap-2 border border-neutral-700 bg-black px-3 py-2 text-xs font-bold uppercase disabled:opacity-50">
                <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
              </button>
              <button onClick={() => void testAll()} disabled={testingAll || providers.length === 0} className="flex items-center gap-2 border border-white bg-white px-3 py-2 text-xs font-bold uppercase text-black disabled:opacity-50">
                <FlaskConical className="h-3.5 w-3.5" /> {testingAll ? 'Testing All...' : 'Test All'}
              </button>
            </div>
          </div>

          {loadError && <div className="flex items-start gap-2 border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300"><XCircle className="mt-0.5 h-4 w-4 shrink-0" /><pre className="whitespace-pre-wrap break-all">{loadError}</pre></div>}

          {!loading && providers.length === 0 && !loadError && <div className="border border-neutral-800 bg-neutral-950 p-8 text-center text-xs text-neutral-500">No IPTV providers are configured yet.</div>}

          <div className="space-y-4">
            {providers.map((provider) => {
              const state = results[provider.id] || emptyState;
              const account = state.data?.account;
              const server = state.data?.server;
              const headers = Object.entries(state.data?.responseHeaders || {});
              return (
                <section key={provider.id} className="border border-neutral-800 bg-neutral-950">
                  <div className="flex flex-col gap-3 border-b border-neutral-800 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <h2 className="font-bold text-white">{provider.name}</h2>
                        <span className="border border-neutral-800 bg-black px-2 py-0.5 text-[10px] text-neutral-400">/{provider.route}</span>
                        {provider.enabled === 0 && <span className="text-[10px] font-bold uppercase text-neutral-600">Disabled</span>}
                      </div>
                      <div className="mt-1 break-all text-[11px] text-neutral-500">{provider.host} · {provider.upstream_username}</div>
                    </div>
                    <button onClick={() => void testProvider(provider)} disabled={state.loading} className="flex shrink-0 items-center justify-center gap-2 border border-neutral-700 bg-black px-3 py-2 text-xs font-bold uppercase hover:border-white disabled:opacity-50">
                      {state.loading ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FlaskConical className="h-3.5 w-3.5" />}
                      {state.loading ? 'Testing...' : 'Test Account'}
                    </button>
                  </div>

                  {state.error && (
                    <div className="m-4 space-y-4 border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300">
                      <div className="flex items-center gap-2 font-bold uppercase"><XCircle className="h-4 w-4" /> {state.error}</div>

                      {state.data && (
                        <div className="grid gap-px overflow-hidden border border-neutral-800 bg-neutral-800 sm:grid-cols-2 lg:grid-cols-4">
                          {[
                            ['HTTP Status', state.data.upstreamStatus ? `${state.data.upstreamStatus}${state.data.upstreamStatusText ? ` ${state.data.upstreamStatusText}` : ''}` : 'N/A'],
                            ['Content Type', display(state.data.rawContentType)],
                            ['Response Time', `${state.data.elapsedMs} ms`],
                            ['Method', display(state.data.requestMethod)],
                          ].map(([label, value]) => (
                            <div key={label} className="bg-black p-3">
                              <div className="text-[9px] font-bold uppercase text-neutral-600">{label}</div>
                              <div className="mt-1 break-words text-xs text-neutral-200">{value}</div>
                            </div>
                          ))}
                        </div>
                      )}

                      {state.data?.finalUrl && (
                        <div>
                          <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-neutral-500">Final URL</div>
                          <div className="break-all border border-neutral-800 bg-black p-3 text-[11px] text-neutral-300">{state.data.finalUrl}</div>
                        </div>
                      )}

                      {headers.length > 0 && (
                        <div>
                          <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-neutral-500">Response Headers</div>
                          <div className="overflow-hidden border border-neutral-800 bg-black">
                            {headers.map(([name, value]) => (
                              <div key={name} className="grid gap-1 border-b border-neutral-900 px-3 py-2 last:border-b-0 sm:grid-cols-[180px_1fr]">
                                <span className="text-[10px] font-bold text-neutral-500">{name}</span>
                                <span className="break-all text-[11px] text-neutral-300">{value}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {state.data?.rawResponse && (
                        <div>
                          <div className="mb-1 text-[9px] font-bold uppercase tracking-wider text-neutral-500">Raw Response Body</div>
                          <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap break-all border border-neutral-800 bg-black p-3 text-[11px] leading-relaxed text-neutral-300">{state.data.rawResponse}</pre>
                        </div>
                      )}
                    </div>
                  )}

                  {state.data && account && (
                    <div className="space-y-4 p-4">
                      <div className="flex flex-wrap items-center gap-3 border border-emerald-900 bg-emerald-950/20 p-3 text-xs">
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                        <span className="font-bold uppercase text-emerald-400">Connected & Authenticated</span>
                        <span className="text-neutral-500">{state.data.elapsedMs} ms</span>
                        <span className="text-neutral-600">Tested {new Date(state.data.testedAt).toLocaleString()}</span>
                      </div>

                      <div>
                        <h3 className="mb-2 text-[10px] font-bold uppercase tracking-wider text-neutral-500">Account Information</h3>
                        <div className="grid gap-px overflow-hidden border border-neutral-800 bg-neutral-800 sm:grid-cols-2 lg:grid-cols-4">
                          {[
                            ['Username', display(account.username)], ['Status', display(account.status)], ['Expires', formatEpoch(account.expiresAt)], ['Trial', display(account.isTrial)],
                            ['Active Connections', display(account.activeConnections)], ['Max Connections', display(account.maxConnections)], ['Created', formatEpoch(account.createdAt)],
                            ['Formats', account.allowedOutputFormats.length ? account.allowedOutputFormats.join(', ') : 'N/A'],
                          ].map(([label, value]) => <div key={label} className="bg-black p-3"><div className="text-[9px] font-bold uppercase text-neutral-600">{label}</div><div className="mt-1 break-words text-xs text-white">{value}</div></div>)}
                        </div>
                      </div>

                      {server && (
                        <div>
                          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-neutral-500"><Server className="h-3 w-3" /> Server Information</h3>
                          <div className="grid gap-px overflow-hidden border border-neutral-800 bg-neutral-800 sm:grid-cols-2 lg:grid-cols-4">
                            {[
                              ['Server', display(server.url)], ['Protocol', display(server.protocol)], ['Port', display(server.port)], ['HTTPS Port', display(server.httpsPort)],
                              ['RTMP Port', display(server.rtmpPort)], ['Timezone', display(server.timezone)], ['Server Time', display(server.timeNow)], ['Timestamp', display(server.timestampNow)],
                            ].map(([label, value]) => <div key={label} className="bg-black p-3"><div className="text-[9px] font-bold uppercase text-neutral-600">{label}</div><div className="mt-1 break-words text-xs text-neutral-300">{value}</div></div>)}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {!state.loading && !state.error && !state.data && <div className="p-4 text-xs text-neutral-600">Not tested yet.</div>}
                </section>
              );
            })}
          </div>
        </main>
      </div>
    </div>
  );
}
