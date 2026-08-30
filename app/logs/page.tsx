'use client';

import * as React from 'react';
import { ArrowUpDown, Download, Pause, Play, Radio, Search, Trash2 } from 'lucide-react';
import { AppShell } from '@/components/layout/app-shell';
import { PageHeader } from '@/components/layout/page-header';
import { Alert, AlertDescription } from '@/components/ui/alert';
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
import { Select } from '@/components/ui/select';
import { apiPath, readJson } from '@/lib/client/api';

type LogLevel = 'info' | 'warning' | 'error' | 'debug';
type LogGroup = 'ALL' | 'traffic' | 'cache' | 'streams' | 'vpn' | 'providers' | 'auth' | 'system';

type LogItem = {
  id: string;
  timestamp: string;
  level: LogLevel;
  source: string;
  category: string;
  message: string;
  metadata_json: string | null;
};

type LogsEnvelope = {
  success?: boolean;
  data?: LogItem[];
  total?: number;
  error?: string;
};

const sources = [
  'ALL',
  'auth',
  'provider',
  'vpn',
  'wireguard',
  'openvpn',
  'vpngate',
  'warp',
  'system',
  'proxy',
];

const groups: Array<{ value: LogGroup; label: string }> = [
  { value: 'ALL', label: 'All categories' },
  { value: 'traffic', label: 'Request traffic' },
  { value: 'cache', label: 'Cache' },
  { value: 'streams', label: 'Streams / HLS' },
  { value: 'vpn', label: 'VPN' },
  { value: 'providers', label: 'Providers' },
  { value: 'auth', label: 'Authentication' },
  { value: 'system', label: 'System' },
];

const requestRoutingCategories = new Set(['direct.route', 'cache.route', 'cache.result', 'live.route', 'hls.token']);

function levelVariant(level: LogLevel): 'secondary' | 'warning' | 'destructive' | 'outline' {
  if (level === 'error') return 'destructive';
  if (level === 'warning') return 'warning';
  if (level === 'debug') return 'outline';
  return 'secondary';
}

function parseMetadata(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function prettyMetadata(value: string | null) {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

function matchesGroup(log: LogItem, group: LogGroup) {
  if (group === 'ALL') return true;
  if (group === 'traffic') {
    return log.category.startsWith('request.') || log.category.startsWith('upstream.') || log.category.startsWith('route.') || requestRoutingCategories.has(log.category);
  }
  if (group === 'cache') return log.category.startsWith('cache.');
  if (group === 'streams') return log.category.startsWith('live.') || log.category.startsWith('hls.') || log.category.startsWith('stream.');
  if (group === 'vpn') return ['vpn', 'wireguard', 'openvpn', 'vpngate', 'warp'].includes(log.source);
  if (group === 'providers') return log.source === 'provider';
  if (group === 'auth') return log.source === 'auth';
  if (group === 'system') return log.source === 'system';
  return true;
}

function displayGroup(log: LogItem) {
  if (matchesGroup(log, 'traffic')) return 'traffic';
  if (matchesGroup(log, 'cache')) return 'cache';
  if (matchesGroup(log, 'streams')) return 'stream';
  if (matchesGroup(log, 'vpn')) return 'vpn';
  if (matchesGroup(log, 'providers')) return 'provider';
  if (matchesGroup(log, 'auth')) return 'auth';
  if (matchesGroup(log, 'system')) return 'system';
  return log.source;
}

function proxyTraffic(log: LogItem, metadata: Record<string, unknown> | null) {
  if (log.source !== 'proxy' || !metadata) return null;
  const direction = typeof metadata.direction === 'string' ? metadata.direction : null;
  const url = typeof metadata.url === 'string'
    ? metadata.url
    : typeof metadata.outgoingUrl === 'string'
      ? metadata.outgoingUrl
      : typeof metadata.incomingUrl === 'string'
        ? metadata.incomingUrl
        : null;
  const method = typeof metadata.method === 'string' ? metadata.method : null;
  const status = typeof metadata.status === 'number' || typeof metadata.status === 'string' ? String(metadata.status) : null;
  const traceId = typeof metadata.traceId === 'string' ? metadata.traceId : null;
  const elapsedMs = typeof metadata.elapsedMs === 'number' || typeof metadata.elapsedMs === 'string' ? String(metadata.elapsedMs) : null;
  const bytes = typeof metadata.bytesOut === 'number' || typeof metadata.bytesOut === 'string'
    ? String(metadata.bytesOut)
    : typeof metadata.bytes === 'number' || typeof metadata.bytes === 'string'
      ? String(metadata.bytes)
      : null;

  let step: string | null = null;
  if (log.category === 'request.received') step = 'CLIENT → PROXY';
  else if (log.category === 'request.completed') step = 'PROXY → CLIENT';
  else if (log.category === 'upstream.request') step = 'PROXY → PROVIDER';
  else if (log.category === 'upstream.response') step = 'PROVIDER → PROXY';
  else if (log.category === 'upstream.error') step = 'PROVIDER ERROR';
  else if (log.category === 'cache.route') step = 'CACHE ROUTE';
  else if (log.category === 'cache.result') step = 'CACHE RESPONSE';
  else if (log.category === 'live.route') step = 'LIVE ROUTE';
  else if (log.category === 'hls.token') step = 'HLS CHILD';
  else if (log.category === 'direct.route') step = 'DIRECT ROUTE';
  else if (log.category.startsWith('route.') || log.category === 'request.rewrite') step = 'ROUTING';

  if (!direction && !url && !method && !status && !traceId && !step) return null;
  return { direction, url, method, status, traceId, elapsedMs, bytes, step };
}

export default function LogsPage() {
  const [logs, setLogs] = React.useState<LogItem[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [levelFilter, setLevelFilter] = React.useState('ALL');
  const [sourceFilter, setSourceFilter] = React.useState('ALL');
  const [groupFilter, setGroupFilter] = React.useState<LogGroup>('ALL');
  const [searchQuery, setSearchQuery] = React.useState('');
  const [sortOrder, setSortOrder] = React.useState<'DESC' | 'ASC'>('DESC');
  const [autoScroll, setAutoScroll] = React.useState(true);
  const [isStreaming, setIsStreaming] = React.useState(true);
  const [confirmClear, setConfirmClear] = React.useState(false);
  const [clearing, setClearing] = React.useState(false);
  const [selectedLog, setSelectedLog] = React.useState<LogItem | null>(null);
  const logContainerRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    async function fetchLogs() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ order: sortOrder, limit: '500' });
        if (levelFilter !== 'ALL') params.set('level', levelFilter);
        if (sourceFilter !== 'ALL') params.set('source', sourceFilter);
        if (groupFilter !== 'ALL') params.set('group', groupFilter);
        if (searchQuery.trim()) params.set('search', searchQuery.trim());

        const response = await fetch(apiPath(`/api/logs?${params.toString()}`), { cache: 'no-store' });
        const payload = await readJson<LogsEnvelope>(response);
        if (!response.ok || !payload.success) throw new Error(payload.error || `Unable to load logs (HTTP ${response.status}).`);
        if (!cancelled) {
          setLogs(payload.data || []);
          setTotalCount(payload.total || 0);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void fetchLogs();
    return () => {
      cancelled = true;
    };
  }, [groupFilter, levelFilter, searchQuery, sortOrder, sourceFilter]);

  React.useEffect(() => {
    if (!isStreaming) return;

    const eventSource = new EventSource(apiPath('/api/logs/stream'));
    eventSource.addEventListener('log', (event) => {
      try {
        const newLog = JSON.parse(event.data) as LogItem;
        if (levelFilter !== 'ALL' && newLog.level !== levelFilter) return;
        if (sourceFilter !== 'ALL' && newLog.source !== sourceFilter) return;
        if (!matchesGroup(newLog, groupFilter)) return;
        if (searchQuery) {
          const query = searchQuery.toLowerCase();
          const searchable = `${newLog.message} ${newLog.source} ${newLog.category} ${newLog.metadata_json || ''}`.toLowerCase();
          if (!searchable.includes(query)) return;
        }
        setLogs((current) => sortOrder === 'DESC'
          ? [newLog, ...current.slice(0, 499)]
          : [...current.slice(-499), newLog]);
        setTotalCount((current) => current + 1);
      } catch {
        return;
      }
    });

    return () => eventSource.close();
  }, [groupFilter, isStreaming, levelFilter, searchQuery, sortOrder, sourceFilter]);

  React.useEffect(() => {
    if (!autoScroll || !logContainerRef.current) return;
    logContainerRef.current.scrollTop = sortOrder === 'ASC' ? logContainerRef.current.scrollHeight : 0;
  }, [autoScroll, logs, sortOrder]);

  const clearLogs = async () => {
    setClearing(true);
    setError(null);
    try {
      const response = await fetch(apiPath('/api/logs'), { method: 'DELETE' });
      const payload = await readJson<{ success?: boolean; error?: string }>(response);
      if (!response.ok || !payload.success) throw new Error(payload.error || 'Unable to clear logs.');
      setLogs([]);
      setTotalCount(0);
      setConfirmClear(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  };

  const exportLogs = () => {
    const blob = new Blob([JSON.stringify(logs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `iptv-proxy-logs-${new Date().toISOString()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };

  const clearFilters = () => {
    setLevelFilter('ALL');
    setSourceFilter('ALL');
    setGroupFilter('ALL');
    setSearchQuery('');
  };

  const showTrace = (traceId: string) => {
    setSearchQuery(traceId);
    setSourceFilter('proxy');
    setGroupFilter('traffic');
    setSortOrder('ASC');
    setSelectedLog(null);
  };

  const hasFilters = levelFilter !== 'ALL' || sourceFilter !== 'ALL' || groupFilter !== 'ALL' || Boolean(searchQuery);
  const selectedMetadata = selectedLog ? parseMetadata(selectedLog.metadata_json) : null;
  const selectedTraffic = selectedLog ? proxyTraffic(selectedLog, selectedMetadata) : null;

  return (
    <AppShell>
      <PageHeader
        title="Logs"
        description="One live console for application, VPN, cache, stream and end-to-end IPTV request traffic."
        actions={
          <>
            <Button variant={groupFilter === 'traffic' ? 'secondary' : 'outline'} onClick={() => setGroupFilter((value) => value === 'traffic' ? 'ALL' : 'traffic')}>
              Request traffic
            </Button>
            <Button variant={isStreaming ? 'secondary' : 'outline'} onClick={() => setIsStreaming((value) => !value)}>
              <Radio className={isStreaming ? 'text-emerald-500' : ''} />
              {isStreaming ? 'Live' : 'Paused'}
            </Button>
            <Button variant="outline" onClick={exportLogs} disabled={logs.length === 0}>
              <Download />
              Export
            </Button>
            <Button variant="outline" onClick={() => setConfirmClear(true)} disabled={totalCount === 0}>
              <Trash2 />
              Clear
            </Button>
          </>
        }
      />

      {error && <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>}

      <Card>
        <CardContent className="p-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            <div className="relative xl:col-span-2">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search message, URL, trace ID, stream, provider or action" className="pl-9" />
            </div>
            <Select value={groupFilter} onChange={(event) => setGroupFilter(event.target.value as LogGroup)} aria-label="Filter by category group">
              {groups.map((group) => <option key={group.value} value={group.value}>{group.label}</option>)}
            </Select>
            <Select value={levelFilter} onChange={(event) => setLevelFilter(event.target.value)} aria-label="Filter by level">
              <option value="ALL">All levels</option>
              <option value="info">Info</option>
              <option value="warning">Warning</option>
              <option value="error">Error</option>
              <option value="debug">Debug</option>
            </Select>
            <Select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} aria-label="Filter by source">
              {sources.map((source) => <option key={source} value={source}>{source === 'ALL' ? 'All sources' : source}</option>)}
            </Select>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={() => setSortOrder((value) => value === 'DESC' ? 'ASC' : 'DESC')}>
                <ArrowUpDown />
                {sortOrder === 'DESC' ? 'Newest' : 'Oldest'}
              </Button>
              {hasFilters && <Button variant="ghost" onClick={clearFilters}>Reset</Button>}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle>Unified console</CardTitle>
            <CardDescription>Showing {logs.length} of {totalCount} matching records. Trace IDs link the client request, routing/cache decision, provider request, provider response and final client response.</CardDescription>
          </div>
          <Button className="w-full sm:w-auto" variant="ghost" size="sm" onClick={() => setAutoScroll((value) => !value)}>
            {autoScroll ? <Pause /> : <Play />}
            Auto-scroll {autoScroll ? 'on' : 'off'}
          </Button>
        </CardHeader>
        <CardContent>
          {loading && logs.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">Loading logs…</div>
          ) : logs.length === 0 ? (
            <EmptyState title="No logs found" description={hasFilters ? 'No records match the current filters.' : 'No application events have been recorded yet.'} action={hasFilters ? <Button size="sm" variant="outline" onClick={clearFilters}>Reset filters</Button> : undefined} />
          ) : (
            <div ref={logContainerRef} className="max-h-[700px] divide-y overflow-y-auto rounded-lg border">
              {logs.map((log) => {
                const metadata = parseMetadata(log.metadata_json);
                const traffic = proxyTraffic(log, metadata);
                return (
                  <button key={log.id} type="button" onClick={() => setSelectedLog(log)} className="flex w-full flex-col gap-2 p-3 text-left transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between">
                    <div className="flex min-w-0 items-start gap-3">
                      <Badge variant={levelVariant(log.level)} className="mt-0.5 shrink-0">{log.level}</Badge>
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{displayGroup(log)}</Badge>
                          {traffic?.step && <Badge variant="secondary">{traffic.step}</Badge>}
                          {traffic?.method && <span className="font-mono text-xs font-semibold">{traffic.method}</span>}
                          {traffic?.status && <span className="font-mono text-xs">HTTP {traffic.status}</span>}
                          {traffic?.elapsedMs && <span className="font-mono text-xs text-muted-foreground">{traffic.elapsedMs} ms</span>}
                          <span className="text-sm leading-relaxed">{log.message}</span>
                        </div>
                        {traffic?.url && <div className="mt-1 break-all font-mono text-xs text-foreground/80">{traffic.url}</div>}
                        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                          <span>{log.source}</span>
                          <span>·</span>
                          <span>{log.category}</span>
                          {traffic?.bytes && <><span>·</span><span>{traffic.bytes} bytes</span></>}
                          {traffic?.traceId && <><span>·</span><span className="font-mono">trace {traffic.traceId}</span></>}
                        </div>
                      </div>
                    </div>
                    <time className="shrink-0 pl-11 text-xs text-muted-foreground sm:pl-0">{new Date(log.timestamp).toLocaleString()}</time>
                  </button>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedLog)} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <DialogContent className="max-w-2xl">
          {selectedLog && (
            <>
              <DialogHeader>
                <DialogTitle>Log details</DialogTitle>
                <DialogDescription>{new Date(selectedLog.timestamp).toLocaleString()}</DialogDescription>
              </DialogHeader>
              <div className="space-y-4">
                <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
                  <div><div className="text-xs text-muted-foreground">Level</div><div className="mt-1"><Badge variant={levelVariant(selectedLog.level)}>{selectedLog.level}</Badge></div></div>
                  <div><div className="text-xs text-muted-foreground">Group</div><div className="mt-1 text-sm font-medium">{displayGroup(selectedLog)}</div></div>
                  <div><div className="text-xs text-muted-foreground">Source</div><div className="mt-1 text-sm font-medium">{selectedLog.source}</div></div>
                  <div><div className="text-xs text-muted-foreground">Category</div><div className="mt-1 text-sm font-medium">{selectedLog.category}</div></div>
                </div>
                {selectedTraffic && (
                  <div className="grid gap-3 rounded-lg border p-4 sm:grid-cols-2">
                    <div><div className="text-xs text-muted-foreground">Request step</div><div className="mt-1 text-sm font-medium">{selectedTraffic.step || 'Traffic event'}</div></div>
                    <div><div className="text-xs text-muted-foreground">Status</div><div className="mt-1 font-mono text-sm">{selectedTraffic.status ? `HTTP ${selectedTraffic.status}` : '—'}</div></div>
                    <div className="sm:col-span-2"><div className="text-xs text-muted-foreground">URL</div><div className="mt-1 break-all font-mono text-xs">{selectedTraffic.url || '—'}</div></div>
                    {selectedTraffic.traceId && <div className="sm:col-span-2"><Button size="sm" variant="outline" onClick={() => showTrace(selectedTraffic.traceId!)}>Show complete request trace</Button></div>}
                  </div>
                )}
                <div>
                  <div className="mb-2 text-sm font-medium">Message</div>
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm leading-relaxed">{selectedLog.message}</div>
                </div>
                {selectedLog.metadata_json && (
                  <div>
                    <div className="mb-2 text-sm font-medium">Metadata</div>
                    <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 text-xs">{prettyMetadata(selectedLog.metadata_json)}</pre>
                  </div>
                )}
              </div>
              <DialogFooter><Button onClick={() => setSelectedLog(null)}>Close</Button></DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Clear all logs?</DialogTitle>
            <DialogDescription>This permanently deletes the historical application log records from the unified console.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void clearLogs()} disabled={clearing}>{clearing ? 'Clearing…' : 'Clear logs'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppShell>
  );
}
