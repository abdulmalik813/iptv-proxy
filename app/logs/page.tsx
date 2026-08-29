'use client';

import React, { useEffect, useState, useRef } from 'react';
import { useRouter } from 'next/navigation';
import {
  ScrollText,
  Play,
  Pause,
  Trash2,
  Filter,
  Search,
  RefreshCw,
  ArrowUpDown,
  AlertCircle,
  AlertTriangle,
  Info,
  Bug,
  Radio,
  Download,
  X,
} from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

interface LogItem {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error' | 'debug';
  source: string;
  category: string;
  message: string;
  metadata_json: string | null;
}

export default function LogsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);

  const [logs, setLogs] = useState<LogItem[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [loading, setLoading] = useState(true);

  // Filters
  const [levelFilter, setLevelFilter] = useState<string>('ALL');
  const [sourceFilter, setSourceFilter] = useState<string>('ALL');
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [sortOrder, setSortOrder] = useState<'DESC' | 'ASC'>('DESC');

  // Stream & Auto-scroll State
  const [autoScroll, setAutoScroll] = useState(true);
  const [isStreaming, setIsStreaming] = useState(true);
  const eventSourceRef = useRef<EventSource | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);

  // Clear Confirmation
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  // Selected Log Details Modal
  const [selectedLog, setSelectedLog] = useState<LogItem | null>(null);

  useEffect(() => {
    let ignore = false;
    async function fetchLogs() {
      try {
        const params = new URLSearchParams();
        if (levelFilter !== 'ALL') params.set('level', levelFilter);
        if (sourceFilter !== 'ALL') params.set('source', sourceFilter);
        if (categoryFilter !== 'ALL') params.set('category', categoryFilter);
        if (searchQuery.trim()) params.set('search', searchQuery.trim());
        params.set('order', sortOrder);
        params.set('limit', '200');

        const [authRes, logsRes] = await Promise.all([
          fetch('/api/auth/me'),
          fetch(`/api/logs?${params.toString()}`),
        ]);

        if (authRes.status === 401) {
          router.push('/login');
          return;
        }
        const authData = await authRes.json();
        if (ignore) return;
        if (authData.authenticated) setUser(authData.user);

        if (logsRes.ok) {
          const json = await logsRes.json();
          if (ignore) return;
          if (json.success) {
            setLogs(json.data);
            setTotalCount(json.total);
          }
        }
      } catch {
        // Ignore
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void fetchLogs();
    return () => {
      ignore = true;
    };
  }, [levelFilter, sourceFilter, categoryFilter, searchQuery, sortOrder, router]);

  // Set up SSE Stream
  useEffect(() => {
    if (!isStreaming) {
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    const es = new EventSource('/api/logs/stream');
    eventSourceRef.current = es;

    es.addEventListener('log', (event) => {
      try {
        const newLog: LogItem = JSON.parse(event.data);
        setLogs((prev) => {
          // Check if matches active filters
          if (levelFilter !== 'ALL' && newLog.level !== levelFilter) return prev;
          if (sourceFilter !== 'ALL' && newLog.source !== sourceFilter) return prev;
          if (categoryFilter !== 'ALL' && newLog.category !== categoryFilter) return prev;
          if (
            searchQuery &&
            !newLog.message.toLowerCase().includes(searchQuery.toLowerCase()) &&
            !newLog.source.toLowerCase().includes(searchQuery.toLowerCase())
          ) {
            return prev;
          }

          if (sortOrder === 'DESC') {
            return [newLog, ...prev.slice(0, 199)];
          } else {
            return [...prev.slice(-199), newLog];
          }
        });
        setTotalCount((c) => c + 1);
      } catch {
        // Ignore JSON parse error
      }
    });

    es.onerror = () => {
      // If error or disconnect, will retry automatically
    };

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [isStreaming, levelFilter, sourceFilter, categoryFilter, searchQuery, sortOrder]);

  // Auto Scroll
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      if (sortOrder === 'ASC') {
        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
      } else {
        logContainerRef.current.scrollTop = 0;
      }
    }
  }, [logs, autoScroll, sortOrder]);

  const handleClearLogs = async () => {
    setClearing(true);
    try {
      const res = await fetch('/api/logs', { method: 'DELETE' });
      if (res.ok) {
        setLogs([]);
        setTotalCount(0);
        setConfirmClear(false);
      }
    } catch {
      // Ignore
    } finally {
      setClearing(false);
    }
  };

  const handleExportJson = () => {
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(logs, null, 2));
    const downloadAnchor = document.createElement('a');
    downloadAnchor.setAttribute('href', dataStr);
    downloadAnchor.setAttribute('download', `iptv-proxy-logs-${new Date().toISOString()}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const clearAllFilters = () => {
    setLevelFilter('ALL');
    setSourceFilter('ALL');
    setCategoryFilter('ALL');
    setSearchQuery('');
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

  return (
    <div className="flex h-screen bg-black text-neutral-200 font-mono overflow-hidden">
      <Sidebar
        user={user}
        onLogout={() => router.push('/login')}
        mobileOpen={mobileOpen}
        setMobileOpen={setMobileOpen}
      />

      <div className="flex-1 flex flex-col min-w-0 overflow-y-auto">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />

        <main className="p-4 sm:p-6 lg:p-8 space-y-4 max-w-7xl">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
            <div>
              <h1 className="text-base sm:text-lg font-bold text-white uppercase tracking-tight flex items-center gap-2">
                <ScrollText className="w-5 h-5" />
                <span>Live Audit Logs</span>
              </h1>
              <p className="text-xs text-neutral-500">
                Real-time Server-Sent Events stream of authentication, routing, and VPN events.
              </p>
            </div>

            {/* Stream & Control Toolbar */}
            <div className="flex flex-wrap items-center gap-2">
              <button
                id="btn-toggle-stream"
                onClick={() => setIsStreaming(!isStreaming)}
                className={`px-3 py-1.5 border text-xs font-bold uppercase tracking-wider flex items-center gap-1.5 cursor-pointer ${
                  isStreaming
                    ? 'bg-emerald-950 text-emerald-300 border-emerald-800'
                    : 'bg-neutral-900 text-neutral-400 border-neutral-800'
                }`}
              >
                <Radio className={`w-3.5 h-3.5 ${isStreaming ? 'animate-pulse text-emerald-400' : ''}`} />
                <span>{isStreaming ? 'STREAMING LIVE' : 'STREAM PAUSED'}</span>
              </button>

              <button
                id="btn-toggle-autoscroll"
                onClick={() => setAutoScroll(!autoScroll)}
                className={`px-2.5 py-1.5 border text-xs uppercase flex items-center gap-1.5 cursor-pointer ${
                  autoScroll
                    ? 'bg-neutral-900 text-white border-neutral-700'
                    : 'bg-black text-neutral-500 border-neutral-800'
                }`}
              >
                {autoScroll ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
                <span>Auto-Scroll: {autoScroll ? 'ON' : 'OFF'}</span>
              </button>

              <button
                id="btn-export-logs"
                onClick={handleExportJson}
                title="Export JSON"
                className="p-1.5 border border-neutral-800 bg-black hover:bg-neutral-900 text-neutral-400 hover:text-white transition-colors"
              >
                <Download className="w-4 h-4" />
              </button>

              <button
                id="btn-open-clear-modal"
                onClick={() => setConfirmClear(true)}
                className="px-2.5 py-1.5 bg-black border border-neutral-800 text-neutral-400 hover:text-rose-400 hover:border-rose-900 text-xs uppercase flex items-center gap-1 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Clear DB Logs</span>
              </button>
            </div>
          </div>

          {/* Filters Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 bg-neutral-950 border border-neutral-800 p-3 text-xs">
            {/* Search */}
            <div className="relative lg:col-span-2">
              <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search messages or sources..."
                className="w-full pl-9 pr-3 py-1.5 bg-black border border-neutral-800 text-white placeholder-neutral-600 focus:border-white focus:outline-none text-xs"
              />
            </div>

            {/* Level Filter */}
            <div>
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
              >
                <option value="ALL">All Levels</option>
                <option value="info">INFO</option>
                <option value="warning">WARNING</option>
                <option value="error">ERROR</option>
                <option value="debug">DEBUG</option>
              </select>
            </div>

            {/* Source Filter */}
            <div>
              <select
                value={sourceFilter}
                onChange={(e) => setSourceFilter(e.target.value)}
                className="w-full px-2.5 py-1.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
              >
                {sources.map((s) => (
                  <option key={s} value={s}>
                    Source: {s.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            {/* Order & Reset */}
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setSortOrder(sortOrder === 'DESC' ? 'ASC' : 'DESC')}
                className="flex-1 px-2 py-1.5 bg-black border border-neutral-800 text-neutral-300 hover:text-white text-xs uppercase flex items-center justify-center gap-1"
              >
                <ArrowUpDown className="w-3 h-3" />
                <span>{sortOrder === 'DESC' ? 'Newest' : 'Oldest'}</span>
              </button>

              {(levelFilter !== 'ALL' || sourceFilter !== 'ALL' || searchQuery) && (
                <button
                  onClick={clearAllFilters}
                  title="Reset Filters"
                  className="p-1.5 bg-neutral-900 border border-neutral-800 text-neutral-400 hover:text-white"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>

          {/* Log Stream Container */}
          <div className="border border-neutral-800 bg-neutral-950">
            {/* Header info */}
            <div className="px-4 py-2 border-b border-neutral-800 bg-neutral-900 text-[10px] text-neutral-400 flex justify-between items-center select-none">
              <span>
                DISPLAYING <strong className="text-white">{logs.length}</strong> OF{' '}
                <strong className="text-white">{totalCount}</strong> LOG ENTRIES
              </span>
              <span className="text-neutral-500">CLICK ANY ROW FOR METADATA INSPECTION</span>
            </div>

            <div
              ref={logContainerRef}
              className="max-h-[600px] overflow-y-auto divide-y divide-neutral-900 font-mono text-xs"
            >
              {loading && logs.length === 0 ? (
                <div className="p-12 text-center text-xs text-neutral-500 space-y-2">
                  <RefreshCw className="w-4 h-4 animate-spin mx-auto" />
                  <span>Loading logs from SQLite database...</span>
                </div>
              ) : logs.length === 0 ? (
                <div className="p-12 text-center text-xs text-neutral-500 space-y-2">
                  <p>No log records match current filters.</p>
                  <button
                    onClick={clearAllFilters}
                    className="px-3 py-1 bg-white text-black text-xs font-semibold uppercase"
                  >
                    Reset Filters
                  </button>
                </div>
              ) : (
                logs.map((log) => {
                  let LevelBadge = (
                    <span className="text-[9px] font-bold px-1.5 py-0.2 bg-neutral-900 text-neutral-300 border border-neutral-800 uppercase">
                      {log.level}
                    </span>
                  );

                  if (log.level === 'error') {
                    LevelBadge = (
                      <span className="text-[9px] font-bold px-1.5 py-0.2 bg-rose-950 text-rose-300 border border-rose-800 uppercase">
                        ERROR
                      </span>
                    );
                  } else if (log.level === 'warning') {
                    LevelBadge = (
                      <span className="text-[9px] font-bold px-1.5 py-0.2 bg-amber-950 text-amber-300 border border-amber-800 uppercase">
                        WARN
                      </span>
                    );
                  } else if (log.level === 'debug') {
                    LevelBadge = (
                      <span className="text-[9px] font-bold px-1.5 py-0.2 bg-neutral-950 text-neutral-500 border border-neutral-800 uppercase">
                        DEBUG
                      </span>
                    );
                  }

                  return (
                    <div
                      key={log.id}
                      onClick={() => setSelectedLog(log)}
                      className="p-3 hover:bg-neutral-900/60 transition-colors cursor-pointer flex flex-col sm:flex-row sm:items-start justify-between gap-2"
                    >
                      <div className="flex items-start gap-2.5 overflow-hidden">
                        <div className="shrink-0 mt-0.5">{LevelBadge}</div>
                        <div className="space-y-0.5 overflow-hidden">
                          <div className="flex items-center gap-2 text-[10px] text-neutral-500">
                            <span className="text-neutral-300 font-semibold uppercase">[{log.source}]</span>
                            <span>•</span>
                            <span className="uppercase">{log.category}</span>
                          </div>
                          <div className="text-neutral-200 text-xs break-words leading-relaxed">
                            {log.message}
                          </div>
                        </div>
                      </div>

                      <div className="text-[10px] text-neutral-500 shrink-0 font-mono sm:text-right">
                        {new Date(log.timestamp).toLocaleTimeString()}{' '}
                        <span className="text-neutral-600 hidden md:inline">
                          ({new Date(log.timestamp).toLocaleDateString()})
                        </span>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </main>
      </div>

      {/* Log Detail Inspector Modal */}
      {selectedLog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-2xl border border-neutral-800 bg-neutral-950 p-6 space-y-4 font-mono text-xs">
            <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
              <div className="flex items-center gap-2">
                <ScrollText className="w-4 h-4 text-white" />
                <h2 className="text-sm font-bold text-white uppercase">Log Entry Details</h2>
              </div>
              <button onClick={() => setSelectedLog(null)} className="text-neutral-500 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 p-3 bg-black border border-neutral-900 text-[11px]">
                <div>
                  <span className="text-neutral-500">Log ID: </span>
                  <span className="text-neutral-300 font-mono text-[10px]">{selectedLog.id}</span>
                </div>
                <div>
                  <span className="text-neutral-500">Timestamp: </span>
                  <span className="text-neutral-300">{new Date(selectedLog.timestamp).toISOString()}</span>
                </div>
                <div>
                  <span className="text-neutral-500">Level: </span>
                  <span className="text-white uppercase font-bold">{selectedLog.level}</span>
                </div>
                <div>
                  <span className="text-neutral-500">Source / Category: </span>
                  <span className="text-neutral-300 uppercase">
                    {selectedLog.source} / {selectedLog.category}
                  </span>
                </div>
              </div>

              <div>
                <span className="text-[10px] text-neutral-500 uppercase font-bold block mb-1">Message</span>
                <div className="p-3 bg-black border border-neutral-900 text-neutral-200 text-xs leading-relaxed">
                  {selectedLog.message}
                </div>
              </div>

              {selectedLog.metadata_json && (
                <div>
                  <span className="text-[10px] text-neutral-500 uppercase font-bold block mb-1">
                    Structured Metadata
                  </span>
                  <pre className="p-3 bg-black border border-neutral-900 text-neutral-300 text-[11px] overflow-x-auto">
                    {(() => {
                      try {
                        return JSON.stringify(JSON.parse(selectedLog.metadata_json), null, 2);
                      } catch {
                        return selectedLog.metadata_json;
                      }
                    })()}
                  </pre>
                </div>
              )}
            </div>

            <div className="flex justify-end pt-2 border-t border-neutral-800">
              <button
                onClick={() => setSelectedLog(null)}
                className="px-4 py-1.5 bg-white text-black font-bold uppercase text-xs hover:bg-neutral-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clear Database Confirmation Modal */}
      {confirmClear && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-sm border border-neutral-800 bg-neutral-950 p-6 space-y-4 font-mono">
            <div className="flex items-center gap-2 text-rose-400">
              <AlertTriangle className="w-5 h-5" />
              <h2 className="text-sm font-bold uppercase tracking-tight text-white">Clear All Logs</h2>
            </div>
            <p className="text-xs text-neutral-400 leading-relaxed">
              Are you sure you want to delete all historical logs from the SQLite database? This cannot be undone.
            </p>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmClear(false)}
                className="px-3 py-1.5 border border-neutral-800 text-neutral-400 hover:text-white text-xs uppercase"
              >
                Cancel
              </button>
              <button
                onClick={handleClearLogs}
                disabled={clearing}
                className="px-3 py-1.5 bg-rose-600 text-white font-bold text-xs uppercase hover:bg-rose-500 disabled:opacity-50"
              >
                {clearing ? 'Clearing...' : 'Confirm Clear'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
