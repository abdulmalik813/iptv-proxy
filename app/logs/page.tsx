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
  'vpn_manager',
  'vpn_wireguard',
  'vpn_openvpn',
  'vpn_vpngate',
  'vpn_warp',
  'system',
  'proxy',
];

function levelVariant(level: LogLevel): 'secondary' | 'warning' | 'destructive' | 'outline' {
  if (level === 'error') return 'destructive';
  if (level === 'warning') return 'warning';
  if (level === 'debug') return 'outline';
  return 'secondary';
}

function prettyMetadata(value: string | null) {
  if (!value) return null;
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return value;
  }
}

export default function LogsPage() {
  const [logs, setLogs] = React.useState<LogItem[]>([]);
  const [totalCount, setTotalCount] = React.useState(0);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [levelFilter, setLevelFilter] = React.useState('ALL');
  const [sourceFilter, setSourceFilter] = React.useState('ALL');
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
        const params = new URLSearchParams({ order: sortOrder, limit: '200' });
        if (levelFilter !== 'ALL') params.set('level', levelFilter);
        if (sourceFilter !== 'ALL') params.set('source', sourceFilter);
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
  }, [levelFilter, searchQuery, sortOrder, sourceFilter]);

  React.useEffect(() => {
    if (!isStreaming) return;

    const eventSource = new EventSource(apiPath('/api/logs/stream'));
    eventSource.addEventListener('log', (event) => {
      try {
        const newLog = JSON.parse(event.data) as LogItem;
        setLogs((current) => {
          if (levelFilter !== 'ALL' && newLog.level !== levelFilter) return current;
          if (sourceFilter !== 'ALL' && newLog.source !== sourceFilter) return current;
          if (searchQuery) {
            const query = searchQuery.toLowerCase();
            if (!newLog.message.toLowerCase().includes(query) && !newLog.source.toLowerCase().includes(query)) return current;
          }
          return sortOrder === 'DESC'
            ? [newLog, ...current.slice(0, 199)]
            : [...current.slice(-199), newLog];
        });
        setTotalCount((current) => current + 1);
      } catch {
        return;
      }
    });

    return () => eventSource.close();
  }, [isStreaming, levelFilter, searchQuery, sortOrder, sourceFilter]);

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
    setSearchQuery('');
  };

  const hasFilters = levelFilter !== 'ALL' || sourceFilter !== 'ALL' || Boolean(searchQuery);

  return (
    <AppShell>
      <PageHeader
        title="Logs"
        description="Live application and proxy events with searchable historical records."
        actions={
          <>
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
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
            <div className="relative xl:col-span-2">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Search logs" className="pl-9" />
            </div>
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
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div>
            <CardTitle>Events</CardTitle>
            <CardDescription>Showing {logs.length} of {totalCount} matching records.</CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setAutoScroll((value) => !value)}>
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
            <div ref={logContainerRef} className="max-h-[650px] divide-y overflow-y-auto rounded-lg border">
              {logs.map((log) => (
                <button key={log.id} type="button" onClick={() => setSelectedLog(log)} className="flex w-full flex-col gap-2 p-3 text-left transition-colors hover:bg-muted/50 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 items-start gap-3">
                    <Badge variant={levelVariant(log.level)} className="mt-0.5 shrink-0">{log.level}</Badge>
                    <div className="min-w-0">
                      <div className="text-sm leading-relaxed">{log.message}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                        <span>{log.source}</span>
                        <span>·</span>
                        <span>{log.category}</span>
                      </div>
                    </div>
                  </div>
                  <time className="shrink-0 pl-11 text-xs text-muted-foreground sm:pl-0">{new Date(log.timestamp).toLocaleString()}</time>
                </button>
              ))}
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
                  <div><div className="text-xs text-muted-foreground">Source</div><div className="mt-1 text-sm font-medium">{selectedLog.source}</div></div>
                  <div><div className="text-xs text-muted-foreground">Category</div><div className="mt-1 text-sm font-medium">{selectedLog.category}</div></div>
                  <div><div className="text-xs text-muted-foreground">ID</div><div className="mt-1 break-all font-mono text-xs">{selectedLog.id}</div></div>
                </div>
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
            <DialogDescription>This permanently deletes the historical application log records.</DialogDescription>
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
