'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Database, RefreshCw, Trash2 } from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

interface CacheEntry {
  key: string;
  status: number;
  contentType: string;
  sizeBytes: number;
  fetchedAt: number;
  expiresAt: number;
  ttlSeconds: number;
  refreshRegistered: boolean;
}

interface CacheStats {
  entries: number;
  bytes: number;
  registeredRefreshes: number;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  const raw = await response.text();
  if (!raw) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { return { success: false, error: `HTTP ${response.status}` }; }
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let current = value;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) { current /= 1024; unit += 1; }
  return `${current.toFixed(current >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function formatTime(epoch: number) {
  if (!epoch) return 'N/A';
  return new Date(epoch * 1000).toLocaleString();
}

export default function CachePage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [entries, setEntries] = useState<CacheEntry[]>([]);
  const [stats, setStats] = useState<CacheStats>({ entries: 0, bytes: 0, registeredRefreshes: 0 });
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [purgingAll, setPurgingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [authRes, cacheRes] = await Promise.all([
        fetch('/api/auth/me', { cache: 'no-store' }),
        fetch('/api/system/cache', { cache: 'no-store' }),
      ]);
      if (authRes.status === 401) { router.replace('/login'); return; }
      const auth = await responseJson(authRes);
      const cache = await responseJson(cacheRes);
      if (auth.authenticated) setUser(auth.user as { username: string });
      if (!cacheRes.ok || !cache.success) throw new Error(String(cache.error || `Unable to load cache (HTTP ${cacheRes.status}).`));
      setEntries((cache.data || []) as CacheEntry[]);
      setStats((cache.stats || { entries: 0, bytes: 0, registeredRefreshes: 0 }) as CacheStats);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void load(); }, [load]);

  const sorted = useMemo(() => [...entries].sort((a, b) => a.key.localeCompare(b.key)), [entries]);

  const refreshEntry = async (key: string) => {
    setBusyKey(key); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/system/cache?key=${encodeURIComponent(key)}`, { method: 'POST' });
      const payload = await responseJson(response);
      if (!response.ok || !payload.success) throw new Error(String(payload.error || `Refresh failed (HTTP ${response.status}).`));
      setMessage('Cache refreshed successfully. The old value stayed active until the new response was validated and atomically replaced.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyKey(null); }
  };

  const purgeEntry = async (key: string) => {
    setBusyKey(key); setError(null); setMessage(null);
    try {
      const response = await fetch(`/api/system/cache?key=${encodeURIComponent(key)}`, { method: 'DELETE' });
      const payload = await responseJson(response);
      if (!response.ok || !payload.success) throw new Error(String(payload.error || `Purge failed (HTTP ${response.status}).`));
      setMessage('Cache purged safely: fresh provider data was fetched and validated before the old value was atomically replaced.');
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusyKey(null); }
  };

  const purgeAll = async () => {
    if (!window.confirm('Safely rebuild every active IPTV metadata cache entry from its provider? Existing values remain available until each replacement is validated.')) return;
    setPurgingAll(true); setError(null); setMessage(null);
    try {
      const response = await fetch('/api/system/cache', { method: 'DELETE' });
      const payload = await responseJson(response);
      if (!response.ok || !payload.success) throw new Error(String(payload.error || `Purge failed (HTTP ${response.status}).`));
      setMessage(`Safely rebuilt ${Number(payload.replaced || 0)} cache entries. Old values stayed active until their replacements were validated.`);
      await load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setPurgingAll(false); }
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
              <p className="mt-1 text-xs text-neutral-500">Refresh and Purge both fetch and validate replacement data before atomically replacing the current cache. Cache-enabled API requests fail closed if no cache exists.</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void load()} disabled={loading} className="flex items-center gap-2 border border-neutral-700 bg-black px-3 py-2 text-xs font-bold uppercase disabled:opacity-50"><RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> Reload</button>
              <button onClick={() => void purgeAll()} disabled={purgingAll || entries.length === 0} className="flex items-center gap-2 border border-rose-800 bg-rose-950/30 px-3 py-2 text-xs font-bold uppercase text-rose-300 disabled:opacity-50"><Trash2 className="h-3.5 w-3.5" /> {purgingAll ? 'Rebuilding...' : 'Purge All'}</button>
            </div>
          </div>

          {error && <div className="border border-rose-900 bg-rose-950/30 p-3 text-xs text-rose-300">{error}</div>}
          {message && <div className="border border-emerald-900 bg-emerald-950/20 p-3 text-xs text-emerald-300">{message}</div>}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="border border-neutral-800 bg-neutral-950 p-4"><div className="text-[10px] font-bold uppercase text-neutral-500">Entries</div><div className="mt-1 text-lg font-bold text-white">{stats.entries}</div></div>
            <div className="border border-neutral-800 bg-neutral-950 p-4"><div className="text-[10px] font-bold uppercase text-neutral-500">Stored Data</div><div className="mt-1 text-lg font-bold text-white">{formatBytes(stats.bytes)}</div></div>
            <div className="border border-neutral-800 bg-neutral-950 p-4"><div className="text-[10px] font-bold uppercase text-neutral-500">Auto Refresh Jobs</div><div className="mt-1 text-lg font-bold text-white">{stats.registeredRefreshes}</div></div>
          </div>

          <div className="border border-neutral-800 bg-neutral-950">
            {loading && entries.length === 0 ? <div className="p-8 text-center text-xs text-neutral-500">Loading cache...</div> : sorted.length === 0 ? <div className="p-8 text-center text-xs text-neutral-500">No cached IPTV metadata is available. Cache-enabled IPTV API requests will return unavailable while Go refills the missing entry in the background.</div> : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-neutral-800 bg-neutral-900 text-[10px] uppercase text-neutral-400"><tr><th className="p-3">Cache Key</th><th className="p-3">Size</th><th className="p-3">Fetched</th><th className="p-3">Refresh Point</th><th className="p-3 text-right">Actions</th></tr></thead>
                  <tbody className="divide-y divide-neutral-900">
                    {sorted.map((entry) => {
                      const refreshAt = entry.fetchedAt + Math.round(entry.ttlSeconds * 0.7);
                      return <tr key={entry.key} className="hover:bg-neutral-900/40">
                        <td className="max-w-[520px] p-3"><div className="break-all text-neutral-200">{entry.key}</div><div className="mt-1 text-[10px] text-neutral-600">HTTP {entry.status} · {entry.contentType || 'unknown'} · {entry.refreshRegistered ? 'auto-refresh active' : 'refresh job not registered'}</div></td>
                        <td className="p-3 text-neutral-400">{formatBytes(entry.sizeBytes)}</td>
                        <td className="p-3 text-neutral-400">{formatTime(entry.fetchedAt)}</td>
                        <td className="p-3 text-neutral-400">{formatTime(refreshAt)}</td>
                        <td className="p-3"><div className="flex justify-end gap-2"><button onClick={() => void refreshEntry(entry.key)} disabled={busyKey === entry.key} className="border border-neutral-700 bg-black px-2.5 py-1.5 text-[10px] font-bold uppercase hover:border-white disabled:opacity-50">Refresh</button><button onClick={() => void purgeEntry(entry.key)} disabled={busyKey === entry.key} className="border border-rose-900 bg-rose-950/20 px-2.5 py-1.5 text-[10px] font-bold uppercase text-rose-300 disabled:opacity-50">Purge</button></div></td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
