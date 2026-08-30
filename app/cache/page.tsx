'use client';

import * as React from 'react';
import { Database, RefreshCw, RotateCcw, Users } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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
  activeReaders?: number;
}

interface CacheStats {
  entries: number;
  bytes: number;
  registeredRefreshes: number;
  activeReaders: number;
  retiredGenerations: number;
}

interface CacheOperationState {
  key: string;
  status: 'running' | 'succeeded' | 'failed' | 'rejected' | string;
  operation?: string;
  operationId?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  error?: string;
}

interface BulkCacheState {
  status: 'idle' | 'refreshing' | 'succeeded' | 'partial' | 'failed' | 'interrupted' | 'unknown' | string;
  operationId?: string;
  startedAt?: number;
  updatedAt?: number;
  finishedAt?: number;
  started?: number;
  succeeded?: number;
  failed?: number;
  skipped?: number;
  errors?: string[];
}

type CacheEnvelope = {
  success?: boolean;
  started?: boolean;
  alreadyRunning?: boolean;
  data?: CacheEntry[] | BulkCacheState | Record<string, unknown>;
  stats?: CacheStats;
  states?: CacheOperationState[];
  bulk?: BulkCacheState;
  error?: string;
};

const emptyStats: CacheStats = {
  entries: 0,
  bytes: 0,
  registeredRefreshes: 0,
  activeReaders: 0,
  retiredGenerations: 0,
};

const idleBulk: BulkCacheState = { status: 'idle' };

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

function formatTime(epoch?: number) {
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

function stateBadge(state?: CacheOperationState) {
  if (!state) return <Badge variant="outline">Idle</Badge>;
  switch (state.status) {
    case 'running':
      return <Badge variant="warning">Refreshing</Badge>;
    case 'succeeded':
      return <Badge variant="success">Updated</Badge>;
    case 'failed':
      return <Badge variant="destructive">Failed</Badge>;
    case 'rejected':
      return <Badge variant="warning">Rejected</Badge>;
    default:
      return <Badge variant="outline">{state.status}</Badge>;
  }
}

export default function CachePage() {
  const [entries, setEntries] = React.useState<CacheEntry[]>([]);
  const [stats, setStats] = React.useState<CacheStats>(emptyStats);
  const [states, setStates] = React.useState<CacheOperationState[]>([]);
  const [bulk, setBulk] = React.useState<BulkCacheState>(idleBulk);
  const [loading, setLoading] = React.useState(true);
  const [refreshingAll, setRefreshingAll] = React.useState(false);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [message, setMessage] = React.useState<string | null>(null);

  const load = React.useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const cacheResponse = await fetch(apiPath('/api/system/cache'), { cache: 'no-store' });
      const cachePayload = await readJson<CacheEnvelope>(cacheResponse);
      if (!cacheResponse.ok || !cachePayload.success) {
        throw new Error(cachePayload.error || `Unable to load cache (HTTP ${cacheResponse.status}).`);
      }
      setEntries(Array.isArray(cachePayload.data) ? cachePayload.data : []);
      setStats(cachePayload.stats || emptyStats);
      setStates(Array.isArray(cachePayload.states) ? cachePayload.states : []);
      setBulk(cachePayload.bulk || idleBulk);
    } catch (err) {
      if (!silent) setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 3_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const operationByKey = React.useMemo(() => new Map(states.map((state) => [state.key, state])), [states]);
  const bulkRunning = bulk.status === 'refreshing';

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
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || `Cache refresh failed to start (HTTP ${response.status}).`);
      }
      setMessage(payload.alreadyRunning ? 'A bulk cache refresh is already running. The existing job is shown below.' : 'Bulk cache refresh started. It will continue even if you reload or leave this page.');
      await load(true);
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
        throw new Error(payload.error || `Cache refresh failed to start (HTTP ${response.status}).`);
      }
      setMessage('Cache refresh started. Automatic and manual refreshes share the same Redis lock, so duplicate pulls for this entry are skipped.');
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyKey(null);
    }
  };

  const bulkCompleted = (bulk.succeeded || 0) + (bulk.failed || 0) + (bulk.skipped || 0);
  const bulkStarted = bulk.started || 0;

  return (
    <AppShell>
      <PageHeader
        title="Cache"
        description="Validated IPTV metadata cached in Redis with persistent single-flight refresh state. Cache activity is also available in the unified Logs console."
        actions={
          <>
            <Button variant="outline" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'animate-spin' : ''} />
              Reload status
            </Button>
            <Button onClick={() => void refreshAll()} disabled={refreshingAll || bulkRunning}>
              <RotateCcw className={refreshingAll || bulkRunning ? 'animate-spin' : ''} />
              {bulkRunning ? 'Refreshing…' : refreshingAll ? 'Starting…' : 'Refresh all cache'}
            </Button>
          </>
        }
      />

      {error && <Alert variant="destructive"><AlertDescription className="whitespace-pre-wrap">{error}</AlertDescription></Alert>}
      {message && <Alert variant="success"><AlertDescription>{message}</AlertDescription></Alert>}

      {bulkRunning && (
        <Alert>
          <AlertDescription>
            Bulk refresh is running{bulk.operationId ? ` · ${bulk.operationId.slice(0, 8)}` : ''}. {bulkCompleted} completed of {bulkStarted} started so far
            {(bulk.skipped || 0) > 0 ? ` · ${bulk.skipped} duplicate${bulk.skipped === 1 ? '' : 's'} skipped` : ''}. This state is stored in Redis and survives a page reload.
          </AlertDescription>
        </Alert>
      )}

      {!bulkRunning && bulk.status !== 'idle' && bulk.status !== 'unknown' && (
        <Alert variant={bulk.status === 'failed' || bulk.status === 'interrupted' ? 'destructive' : bulk.status === 'partial' ? 'warning' : 'success'}>
          <AlertDescription>
            Last bulk refresh: {bulk.status} · {bulk.succeeded || 0} succeeded, {bulk.failed || 0} failed, {bulk.skipped || 0} skipped · finished {formatTime(bulk.finishedAt)}.
            {bulk.errors?.length ? ` ${bulk.errors[0]}` : ''}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-5">
        <MetricCard label="Entries" value={stats.entries} icon={<Database className="size-5" />} />
        <MetricCard label="Stored data" value={formatBytes(stats.bytes)} icon={<Database className="size-5" />} />
        <MetricCard label="Auto-refresh jobs" value={stats.registeredRefreshes} icon={<RefreshCw className="size-5" />} />
        <MetricCard label="Active readers" value={stats.activeReaders} icon={<Users className="size-5" />} />
        <MetricCard label="Retiring generations" value={stats.retiredGenerations} icon={<RotateCcw className="size-5" />} />
      </div>

      {stats.retiredGenerations > 0 && (
        <Alert>
          <AlertDescription>
            {stats.retiredGenerations} previous cache generation{stats.retiredGenerations === 1 ? ' is' : 's are'} waiting for active request{stats.activeReaders === 1 ? '' : 's'} to finish. Cleanup happens automatically when the last reader releases it.
          </AlertDescription>
        </Alert>
      )}

      {loading && entries.length === 0 ? (
        <Card><CardContent className="p-8 text-center text-sm text-muted-foreground">Loading cache…</CardContent></Card>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={<Database className="size-6" />}
          title="Cache is empty"
          description="Refresh all cache to pull the standard heavy provider datasets into Redis."
          action={<Button size="sm" onClick={() => void refreshAll()} disabled={refreshingAll || bulkRunning}><RotateCcw className={refreshingAll || bulkRunning ? 'animate-spin' : ''} />{bulkRunning ? 'Refreshing…' : 'Refresh all cache'}</Button>}
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
                  <TableHead>Readers</TableHead>
                  <TableHead>State</TableHead>
                  <TableHead>Fetched</TableHead>
                  <TableHead>Refresh</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((entry) => {
                  const descriptor = describeEntry(entry);
                  const refreshAt = entry.fetchedAt + Math.round(entry.ttlSeconds * 0.7);
                  const state = operationByKey.get(entry.key);
                  const running = state?.status === 'running';
                  return (
                    <TableRow key={entry.key}>
                      <TableCell>
                        <div className="font-medium">{descriptor.title}</div>
                        <div className="mt-1 text-xs text-muted-foreground">{descriptor.detail} · HTTP {entry.status}</div>
                      </TableCell>
                      <TableCell>{entry.itemCountKnown ? entry.itemCount ?? 0 : '—'}</TableCell>
                      <TableCell>{formatBytes(entry.sizeBytes)}</TableCell>
                      <TableCell>{entry.activeReaders ?? 0}</TableCell>
                      <TableCell>
                        {stateBadge(state)}
                        {state && <div className="mt-1 max-w-48 truncate text-xs text-muted-foreground" title={state.error || undefined}>{state.operation || 'refresh'} · {formatTime(state.finishedAt || state.startedAt)}</div>}
                      </TableCell>
                      <TableCell className="text-muted-foreground">{formatTime(entry.fetchedAt)}</TableCell>
                      <TableCell>
                        <div className="text-sm">{formatTime(refreshAt)}</div>
                        <Badge variant={entry.refreshRegistered ? 'success' : 'warning'} className="mt-1">
                          {entry.refreshRegistered ? 'Scheduled' : 'Not scheduled'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="outline" size="sm" onClick={() => void refreshEntry(entry.key)} disabled={busyKey === entry.key || refreshingAll || bulkRunning || running}>
                          <RotateCcw className={busyKey === entry.key || running ? 'animate-spin' : ''} />
                          {running ? 'Refreshing' : 'Refresh'}
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
    </AppShell>
  );
}
