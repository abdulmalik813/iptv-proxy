'use client';

import * as React from 'react';
import { Database, RefreshCw, RotateCcw, Terminal } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/ui/empty-state';
import { MetricCard } from '@/components/ui/metric-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { apiPath, readJson } from '@/lib/client/api';

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

type CacheEnvelope = {
  success?: boolean;
  data?: CacheEntry[] | Record<string, unknown>;
  stats?: CacheStats;
  error?: string;
};

type LogEnvelope = { success?: boolean; data?: LogItem[] };

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

function describeEntry(entry: CacheEntry) {
  if (!entry.descriptor?.endpoint) return { title: 'Legacy cache entry', detail: 'Imported cache data' };
  const query = new URLSearchParams(entry.descriptor.query || '');
  const action = query.get('action');
  return {
    title: action ? `${entry.descriptor.endpoint} · ${action}` : entry.descriptor.endpoint,
    detail: entry.descriptor.providerId,
  };
}

function logMeta(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata) return '';
  return ['providerName', 'endpoint', 'action', 'status', 'bytes', 'items', 'elapsedMs']
    .filter((key) => metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '')
    .map((key) => `${key}=${String(metadata[key])}`)
    .join(' · ');
}

export default function CachePage() {
  const [entries, setEntries] = React.useState<CacheEntry[]>([]);
  const [stats, setStats] = React.useState<CacheStats>({ entries: 0, bytes: 0, registeredRefreshes: 0 });
  const [logs, setLogs] = React.useState<LogItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [refreshingAll, setRefreshingAll] = React.useState(false);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const [cacheResponse, logsResponse] = await Promise.all([
        fetch(apiPath('/api/system/cache'), { cache: 'no-store' }),
        fetch(apiPath('/api/logs?source=proxy&limit=120'), { cache: 'no-store' }),
      ]);
      const cachePayload = await readJson<CacheEnvelope>(cacheResponse);
      const logsPayload = await readJson<LogEnvelope>(logsResponse);
      if (!cacheResponse.ok || !cachePayload.success) {
        throw new Error(cachePayload.error || `Unable to load cache (HTTP ${cacheResponse.status}).`);
      }
      setEntries(Array.isArray(cachePayload.data) ? cachePayload.data : []);
      setStats(cachePayload.stats || { entries: 0, bytes: 0, registeredRefreshes: 0 });
      if (logsResponse.ok && logsPayload.success && logsPayload.data) {
        setLogs(
          logsPayload.data
            .filter((item) => item.category.startsWith('cache.') || item.category.startsWith('upstream.'))
            .slice(0, 40),
        );
      }
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 5_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const sorted = React.useMemo(
    () => [...entries].sort((left, right) => describeEntry(left).title.localeCompare(describeEntry(right).title)),
    [entries],
  );

  const refreshAll = async () => {
    setRefreshingAll(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(apiPath('/api/system/cache'), { method: 'POST' });
      const payload = await readJson<CacheEnvelope>(response);
      const data = (payload.data || {}) as Record<string, unknown>;
      const succeeded = Number(data.succeeded || 0);
      const failed = Number(data.failed || 0);
      if (!response.ok || (!payload.success && succeeded === 0)) {
        const errors = Array.isArray(data.errors) ? data.errors.join('\n') : '';
        throw new Error(payload.error || errors || `Cache refresh failed (HTTP ${response.status}).`);
      }
      setMessage(`Cache refresh completed: ${succeeded} succeeded${failed ? `, ${failed} failed` : ''}. Missing heavy-cache entries were created automatically.`);
      if (Array.isArray(data.errors) && data.errors.length) setError(data.errors.join('\n'));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshingAll(false);
    }
  };

  const refreshEntry = async (key: string) => {
    setBusyKey(key);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(apiPath(`/api/system/cache?key=${encodeURIComponent(key)}`), { method: 'DELETE' });
      const payload = await readJson<CacheEnvelope>(response);
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Cache refresh failed (HTTP ${response.status}).`);
      }
      setMessage('Fresh provider data was validated and published for this cache entry without interrupting the active cache.');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="Cache"
        description="Validated IPTV metadata cached in Redis with automatic background replacement."
        actions={
          <>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Reload status
            </Button>
            <Button onClick={() => void refreshAll()} disabled={refreshingAll}>
              <RotateCcw className={refreshingAll ? 'animate-spin' : ''} />
              {refreshingAll ? 'Refreshing…' : 'Refresh all cache'}
            </Button>
          </>
        }
      />

      {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
      {message && <Alert variant="success"><AlertDescription>{message}</AlertDescription></Alert>}

      <div className="grid gap-4 sm:grid-cols-3">
        <MetricCard label="Entries" value={stats.entries} icon={<Database className="size-5" />} />
        <MetricCard label="Stored data" value={formatBytes(stats.bytes)} icon={<Database className="size-5" />} />
        <MetricCard label="Auto-refresh jobs" value={stats.registeredRefreshes} icon={<RefreshCw className="size-5" />} />
      </div>

      {loading && entries.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading cache…</CardContent></Card>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<Database className="size-6" />}
          title="Cache is empty"
          description="Refresh all cache to pull the standard heavy provider datasets into Redis."
          action={<Button size="sm" onClick={() => void refreshAll()} disabled={refreshingAll}><RotateCcw className={refreshingAll ? 'animate-spin' : ''} />{refreshingAll ? 'Refreshing…' : 'Refresh all cache'}</Button>}
        />
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Entry</TableHead>
                  <TableHead>Items</TableHead>
                  <TableHead>Size</TableHead>
                  <TableHead>Fetched</TableHead>
                  <TableHead>Refresh</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((entry) => {
                  const descriptor = describeEntry(entry);
                  const refreshAt = entry.fetchedAt + Math.round(entry.ttlSeconds * 0.7);
                  return (
                    <TableRow key={entry.key}>
                      <TableCell>
                        <div className="font-medium">{descriptor.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{descriptor.detail} · HTTP {entry.status}</div>
                      </TableCell>
                      <TableCell>{entry.itemCountKnown ? entry.itemCount ?? 0 : '—'}</TableCell>
                      <TableCell>{formatBytes(entry.sizeBytes)}</TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(entry.fetchedAt)}</TableCell>
                      <TableCell>
                        <div className="text-sm">{formatTime(refreshAt)}</div>
                        <Badge variant={entry.refreshRegistered ? 'success' : 'warning'} className="mt-1">
                          {entry.refreshRegistered ? 'Scheduled' : 'Not scheduled'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => void refreshEntry(entry.key)} disabled={busyKey === entry.key || refreshingAll}>
                          <RotateCcw className={busyKey === entry.key ? 'animate-spin' : ''} />
                          Refresh
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Terminal className="size-4" />Recent cache activity</CardTitle>
          <CardDescription>Cache and upstream events from the proxy log.</CardDescription>
        </CardHeader>
        <CardContent>
          {logs.length === 0 ? (
            <div className="text-sm text-muted-foreground">No recent cache activity.</div>
          ) : (
            <div className="divide-y rounded-lg border">
              {logs.map((item) => {
                const meta = logMeta(item.metadata);
                return (
                  <div key={item.id} className="p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={item.level === 'error' ? 'destructive' : item.level === 'warning' ? 'warning' : 'secondary'}>{item.level}</Badge>
                      <span className="text-sm font-medium">{item.message}</span>
                    </div>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {new Date(item.timestamp).toLocaleString()}{meta ? ` · ${meta}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </AppShell>
  );
}
