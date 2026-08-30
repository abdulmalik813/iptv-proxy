'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Database, Play, RefreshCw, Terminal, Trash2 } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

interface CacheDescriptor {
  providerId: string;
  endpoint: string;
  query?: string;
}

interface CacheEntry {
  key: string;
  status: number;
  contentType: string;
  sizeBytes: number;
  fetchedAt: number;
  expiresAt: number;
  ttlSeconds: number;
  refreshRegistered: boolean;
  descriptor?: CacheDescriptor;
  itemCount?: number;
  itemCountKnown?: boolean;
}

interface CacheStats {
  entries: number;
  bytes: number;
  registeredRefreshes: number;
}

interface LogItem {
  id: string;
  timestamp: string;
  level: string;
  source: string;
  category: string;
  message: string;
  metadata?: Record<string, unknown> | null;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { success: false, error: `HTTP ${response.status}` };
  }
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(current >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(epoch: number) {
  return epoch ? new Date(epoch * 1000).toLocaleString() : 'N/A';
}

function descriptorParts(entry: CacheEntry) {
  const descriptor = entry.descriptor;
  if (!descriptor?.endpoint) {
    return { title: 'Legacy cache entry', detail: entry.key };
  }
  const query = new URLSearchParams(descriptor.query || '');
  const action = query.get('action');
  const usefulQuery = [...query.entries()]
    .filter(([key]) => key !== 'action')
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
  return {
    title: action ? `${descriptor.endpoint} · ${action}` : descriptor.endpoint,
    detail: [descriptor.providerId, usefulQuery].filter(Boolean).join(' · '),
  };
}

function metaText(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return '';
  const allowed = [
    'operation',
    'operationId',
    'providerName',
    'endpoint',
    'action',
    'status',
    'bytes',
    'items',
    'elapsedMs',
    'cacheKey',
    'error',
  ];
  return allowed
    .filter((key) => metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '')
    .map((key) => `${key}=${String(metadata[key])}`)
    .join(' · ');
}

export default function CachePage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [stats, setStats] = useState<CacheStats>({ entries: 0, bytes: 0, registeredRefreshes: 0 });
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [purgingAll, setPurgingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [authRes, cacheRes, logsRes] = await Promise.all([
        fetch('/api/auth/me', { cache: 'no-store' }),
        fetch('/api/system/cache', { cache: 'no-store' }),
        fetch('/api/logs?source=proxy&limit=150', { cache: 'no-store' }),
      ]);
      if (authRes.status === 401) {
        router.replace('/login');
        return;
      }

      const auth = await responseJson(authRes);
      const cache = await responseJson(cacheRes);
      const logPayload = await responseJson(logsRes);
      if (auth.authenticated) setUser(auth.user as { username: string });
      if (!cacheRes.ok || !cache.success) {
        throw new Error(String(cache.error || `Unable to load cache (HTTP ${cacheRes.status}).`));
      }
      setEntries((cache.data || []) as CacheEntry[]);
      setStats((cache.stats || { entries: 0, bytes: 0, registeredRefreshes: 0 }) as CacheStats);
      if (logsRes.ok && logPayload.success) {
        const all = (logPayload.data || []) as LogItem[];
        setLogs(all.filter((item) => item.category.startsWith('cache.') || item.category.startsWith('upstream.')).slice(0, 100));
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [load]);

  const sorted = useMemo(
    () => [...entries].sort((a, b) => {
      const left = a.descriptor ? `${a.descriptor.providerId}:${a.descriptor.endpoint}:${a.descriptor.query || ''}` : a.key;
      const right = b.descriptor ? `${b.descriptor.providerId}:${b.descriptor.endpoint}:${b.descriptor.query || ''}` : b.key;
      return left.localeCompare(right);
    }),
    [entries],
  );

  const startPull = async () => {
    setStarting(true);
    setError(null);
    setMessage('Starting the standard provider cache pull. Live activity appears below.');
    try {
      const response = await fetch('/api/system/cache', { method: 'POST' });
      const payload = await responseJson(response);
      const data = (payload.data || {}) as Record<string, unknown>;
      if (!response.ok || (!payload.success && Number(data.succeeded || 0) === 0)) {
        throw new Error(String(payload.error || ((data.errors as string[] | undefined)?.join('\n')) || `Start pull failed (HTTP ${response.status}).`));
      }
      const succeeded = Number(data.succeeded || 0);
      const failed = Number(data.failed || 0);
      setMessage(`Cache pull finished: ${succeeded} succeeded${failed ? `, ${failed} failed` : ''}.`);
      if (Array.isArray(data.errors) && data.errors.length) setError((data.errors as string[]).join('\n'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  };

  const replaceEntry = async (key: string, method: 'POST' | 'DELETE') => {
    setBusyKey(key);
    setError(null);
    try {
      const response = await fetch(`/api/system/cache?key=${encodeURIComponent(key)}`, { method });
      const payload = await responseJson(response);
      if (!response.ok || !payload.success) {
        throw new Error(String(payload.error || `Cache repull failed (HTTP ${response.status}).`));
      }
      setMessage('Fresh provider data was validated and atomically published. The previous generation stayed active until the swap.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const purgeAll = async () => {
    if (!window.confirm('Repull every active cache entry now? Existing cache stays active until each replacement validates.')) return;
    setPurgingAll(true);
    setError(null);
    try {
      const response = await fetch('/api/system/cache', { method: 'DELETE' });
      const payload = await responseJson(response);
      if (!response.ok || !payload.success) throw new Error(String(payload.error || `Repull failed (HTTP ${response.status}).`));
      setMessage(`Repulled ${Number(payload.replaced || 0)} cache entries.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPurgingAll(false);
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
              <h1 className="flex items-center gap-2 text-base font-bold uppercase text-white sm:text-lg"><Database className="h-5 w-5" /> IPTV Cache</h1>
              <p className="mt-1 text-xs text-neutral-500">One canonical cache identity per provider request. Replacements are written completely before the active generation changes.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button onClick={() => void startPull()} disabled={starting} className="flex items-center gap-2 border border-emerald-700 bg-emerald-950/30 px-3 py-2 text-xs font-bold uppercase text-emerald-300 disabled:opacity-50"><Play className="h-3.5 w-3.5" />{starting ? 'Pulling...' : 'Start Pull'}</button>
              <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 border border-neutral-700 bg-black px-3 py-2 text-xs font-bold uppercase disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />Reload</button>
              <button onClick={() => void purgeAll()} disabled={purgingAll || entries.length === 0} className="flex items-center gap-2 border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs font-bold uppercase text-rose-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" />{purgingAll ? 'Repulling...' : 'Purge All'}</button>
            </div>
          </div>

          {error && <div className="border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300"><pre className="whitespace-pre-wrap break-all">{error}</pre></div>}
          {message && <div className="border border-emerald-900 bg-emerald-950/20 p-3 text-xs text-emerald-300">{message}</div>}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="border border-neutral-800 bg-neutral-950 p-4"><div className="text-[10px] font-bold uppercase text-neutral-500">Entries</div><div className="mt-1 text-lg font-bold text-white">{stats.entries}</div></div>
            <div className="border border-neutral-800 bg-neutral-950 p-4"><div className="text-[10px] font-bold uppercase text-neutral-500">Stored Data</div><div className="mt-1 text-lg font-bold text-white">{formatBytes(stats.bytes)}</div></div>
            <div className="border border-neutral-800 bg-neutral-950 p-4"><div className="text-[10px] font-bold uppercase text-neutral-500">Auto Refresh Jobs</div><div className="mt-1 text-lg font-bold text-white">{stats.registeredRefreshes}</div></div>
          </div>

          <div className="border border-neutral-800 bg-neutral-950">
            {loading && entries.length === 0 ? (
              <div className="p-8 text-center text-xs text-neutral-500">Loading cache...</div>
            ) : sorted.length === 0 ? (
              <div className="space-y-4 p-8 text-center">
                <div className="text-xs text-neutral-400">No validated IPTV metadata cache exists yet.</div>
                <button onClick={() => void startPull()} disabled={starting} className="inline-flex items-center gap-2 border border-emerald-700 bg-emerald-950/30 px-4 py-2 text-xs font-bold uppercase text-emerald-300 disabled:opacity-50"><Play className="h-4 w-4" />{starting ? 'Pulling provider data...' : 'Start Pull Now'}</button>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-neutral-800 bg-neutral-900 text-[10px] uppercase text-neutral-400"><tr><th className="p-3">Cache Entry</th><th className="p-3">Size</th><th className="p-3">Fetched</th><th className="p-3">Refresh Point</th><th className="p-3 text-right">Actions</th></tr></thead>
                  <tbody className="divide-y divide-neutral-900">
                    {sorted.map((entry) => {
                      const refreshAt = entry.fetchedAt + Math.round(entry.ttlSeconds * 0.7);
                      const descriptor = descriptorParts(entry);
                      return (
                        <tr key={entry.key} className="hover:bg-neutral-900/40">
                          <td className="max-w-[560px] p-3">
                            <div className="font-semibold text-neutral-100">{descriptor.title}</div>
                            <div className="mt-1 break-all text-[10px] text-neutral-500">{descriptor.detail}</div>
                            <div className="mt-1 text-[10px] text-neutral-600">HTTP {entry.status} · {entry.contentType || 'unknown'}{entry.itemCountKnown ? ` · ${entry.itemCount ?? 0} items` : ''} · {entry.refreshRegistered ? 'auto-refresh active' : 'refresh registration missing'}</div>
                            <div className="mt-1 break-all text-[9px] text-neutral-700">{entry.key}</div>
                          </td>
                          <td className="p-3 text-neutral-400">{formatBytes(entry.sizeBytes)}</td>
                          <td className="p-3 text-neutral-400">{formatTime(entry.fetchedAt)}</td>
                          <td className="p-3 text-neutral-400">{formatTime(refreshAt)}</td>
                          <td className="p-3">
                            <div className="flex justify-end gap-2">
                              <button onClick={() => void replaceEntry(entry.key, 'POST')} disabled={busyKey === entry.key} className="border border-neutral-700 bg-black px-2.5 py-1.5 text-[10px] font-bold uppercase hover:border-white disabled:opacity-50">Refresh</button>
                              <button onClick={() => void replaceEntry(entry.key, 'DELETE')} disabled={busyKey === entry.key} className="border border-rose-900 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-bold uppercase text-rose-300 disabled:opacity-50">Purge</button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <section className="border border-neutral-800 bg-neutral-950">
            <div className="flex items-center justify-between border-b border-neutral-800 p-3"><h2 className="flex items-center gap-2 text-xs font-bold uppercase text-white"><Terminal className="h-4 w-4" /> Cache Activity</h2><span className="text-[10px] text-neutral-600">Auto refresh every 3s</span></div>
            {logs.length === 0 ? <div className="p-5 text-xs text-neutral-600">No cache lifecycle logs yet.</div> : <div className="max-h-[520px] divide-y divide-neutral-900 overflow-y-auto">{logs.map((log) => <div key={log.id} className="p-3 text-[11px]"><div className="flex flex-wrap items-center gap-2"><span className="text-neutral-600">{new Date(log.timestamp).toLocaleTimeString()}</span><span className={log.level === 'error' ? 'text-rose-400' : log.level === 'warning' ? 'text-amber-400' : 'text-emerald-400'}>{log.level.toUpperCase()}</span><span className="text-neutral-400">{log.category}</span><span className="text-neutral-200">{log.message}</span></div>{metaText(log.metadata) && <div className="mt-1 break-all text-neutral-600">{metaText(log.metadata)}</div>}</div>)}</div>}
          </section>
        </main>
      </div>
    </div>
  );
}
