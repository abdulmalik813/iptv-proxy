'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  Tv,
  Database,
  Server,
  Activity,
  AlertTriangle,
  ArrowRight,
  RefreshCw,
  Clock,
  Radio,
  ExternalLink,
} from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

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
  lastError: string | null;
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

export default function DashboardPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [vpn, setVpn] = useState<VpnData | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [recentErrors, setRecentErrors] = useState<LogPreview[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    let ignore = false;
    async function load() {
      try {
        setRefreshing(true);
        const [authRes, healthRes, vpnRes, provRes, logsRes] = await Promise.all([
          fetch('/api/auth/me'),
          fetch('/api/system/health'),
          fetch('/api/vpn/status'),
          fetch('/api/providers'),
          fetch('/api/logs?level=warning&limit=5'),
        ]);

        if (authRes.status === 401) {
          router.push('/login');
          return;
        }

        const authData = await authRes.json();
        if (ignore) return;
        if (authData.authenticated) setUser(authData.user);

        if (healthRes.ok) {
          const h = await healthRes.json();
          if (ignore) return;
          if (h.success) setHealth(h.data);
        }

        if (vpnRes.ok) {
          const v = await vpnRes.json();
          if (ignore) return;
          if (v.success) setVpn(v.data);
        }

        if (provRes.ok) {
          const p = await provRes.json();
          if (ignore) return;
          if (p.success) setProviders(p.data);
        }

        if (logsRes.ok) {
          const l = await logsRes.json();
          if (ignore) return;
          if (l.success) setRecentErrors(l.data);
        }
      } catch {
        // Ignore
      } finally {
        if (!ignore) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    }

    void load();
    const interval = setInterval(() => {
      void load();
    }, 10000);

    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [router, refreshTrigger]);

  const defaultProvider = providers.find((p) => p.is_default === 1);

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

        <main className="p-4 sm:p-6 lg:p-8 space-y-6 max-w-7xl">
          {/* Header */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-neutral-800 pb-4">
            <div>
              <h1 className="text-base sm:text-lg font-bold text-white uppercase tracking-tight">
                System Overview
              </h1>
              <p className="text-xs text-neutral-500">
                Operational status of IPTV routes, VPN network tunnels, and SQLite database.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                id="btn-refresh-dashboard"
                onClick={() => setRefreshTrigger((c) => c + 1)}
                disabled={refreshing}
                className="px-3 py-1.5 border border-neutral-800 bg-neutral-950 hover:bg-neutral-900 text-xs text-neutral-300 hover:text-white transition-colors cursor-pointer flex items-center gap-1.5 disabled:opacity-50"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
                <span>REFRESH</span>
              </button>
            </div>
          </div>

          {/* Quick Metrics Grid */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Metric 1: VPN Tunnel */}
            <div id="card-vpn-metric" className="border border-neutral-800 bg-neutral-950 p-4 space-y-2">
              <div className="flex items-center justify-between text-neutral-500 text-[11px] uppercase tracking-wider font-semibold">
                <span>VPN STATE</span>
                {vpn?.status === 'connected' ? (
                  <ShieldCheck className="w-4 h-4 text-emerald-400" />
                ) : vpn?.status === 'connecting' ? (
                  <RefreshCw className="w-4 h-4 text-amber-400 animate-spin" />
                ) : vpn?.status === 'error' ? (
                  <ShieldAlert className="w-4 h-4 text-rose-400" />
                ) : (
                  <Shield className="w-4 h-4 text-neutral-600" />
                )}
              </div>
              <div className="text-base font-bold text-white uppercase tracking-tight">
                {vpn?.status === 'connected' ? (
                  <span className="text-emerald-400">{vpn.type} Active</span>
                ) : vpn?.status === 'connecting' ? (
                  <span className="text-amber-400">Connecting...</span>
                ) : vpn?.status === 'error' ? (
                  <span className="text-rose-400">Tunnel Error</span>
                ) : (
                  <span className="text-neutral-400">Off (Direct IP)</span>
                )}
              </div>
              <div className="text-[11px] text-neutral-500 truncate">
                {vpn?.profileName || 'No profile active'}
              </div>
              <div className="pt-2 border-t border-neutral-900 flex justify-between text-[10px] text-neutral-400">
                <span>IP: {vpn?.publicIp || 'Direct'}</span>
                <Link href="/vpn" className="text-neutral-300 hover:text-white flex items-center gap-0.5">
                  Manage <ArrowRight className="w-2.5 h-2.5" />
                </Link>
              </div>
            </div>

            {/* Metric 2: IPTV Providers */}
            <div id="card-providers-metric" className="border border-neutral-800 bg-neutral-950 p-4 space-y-2">
              <div className="flex items-center justify-between text-neutral-500 text-[11px] uppercase tracking-wider font-semibold">
                <span>IPTV PROVIDERS</span>
                <Tv className="w-4 h-4 text-neutral-400" />
              </div>
              <div className="text-base font-bold text-white tracking-tight">
                {providers.filter((p) => p.enabled === 1).length} / {providers.length}{' '}
                <span className="text-xs font-normal text-neutral-500">Enabled</span>
              </div>
              <div className="text-[11px] text-neutral-500 truncate">
                Default: {defaultProvider ? `/${defaultProvider.route}` : 'None configured'}
              </div>
              <div className="pt-2 border-t border-neutral-900 flex justify-between text-[10px] text-neutral-400">
                <span>Routes: {providers.length}</span>
                <Link href="/providers" className="text-neutral-300 hover:text-white flex items-center gap-0.5">
                  View <ArrowRight className="w-2.5 h-2.5" />
                </Link>
              </div>
            </div>

            {/* Metric 3: Database & Persistence */}
            <div id="card-db-metric" className="border border-neutral-800 bg-neutral-950 p-4 space-y-2">
              <div className="flex items-center justify-between text-neutral-500 text-[11px] uppercase tracking-wider font-semibold">
                <span>DATABASE (SQLITE)</span>
                <Database className="w-4 h-4 text-neutral-400" />
              </div>
              <div className="text-base font-bold text-white tracking-tight">
                {health?.dbWalMode ? 'WAL Mode' : 'Standard'}
              </div>
              <div className="text-[11px] text-neutral-500 truncate">
                Size: {health?.dbSizeFormatted || 'Ready'}
              </div>
              <div className="pt-2 border-t border-neutral-900 flex justify-between text-[10px] text-neutral-400">
                <span className="truncate max-w-[120px]">{health?.dbPath || '/data'}</span>
                <span className="text-emerald-400">Online</span>
              </div>
            </div>

            {/* Metric 4: System Logs */}
            <div id="card-logs-metric" className="border border-neutral-800 bg-neutral-950 p-4 space-y-2">
              <div className="flex items-center justify-between text-neutral-500 text-[11px] uppercase tracking-wider font-semibold">
                <span>AUDIT LOGS</span>
                <Activity className="w-4 h-4 text-neutral-400" />
              </div>
              <div className="text-base font-bold text-white tracking-tight">
                {health?.totalLogs ?? 0}{' '}
                <span className="text-xs font-normal text-neutral-500">Events</span>
              </div>
              <div className="text-[11px] text-neutral-500 truncate">
                SSE Live Streaming: Active
              </div>
              <div className="pt-2 border-t border-neutral-900 flex justify-between text-[10px] text-neutral-400">
                <span>Real-time</span>
                <Link href="/logs" className="text-neutral-300 hover:text-white flex items-center gap-0.5">
                  Stream <ArrowRight className="w-2.5 h-2.5" />
                </Link>
              </div>
            </div>
          </div>

          {/* Core Configuration & Routing Diagnostic */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
            {/* Left Col: Configured Providers Table Preview */}
            <div className="lg:col-span-2 border border-neutral-800 bg-neutral-950 p-4 sm:p-5 space-y-4">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                <div className="flex items-center gap-2">
                  <Tv className="w-4 h-4 text-white" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    Upstream Provider Routes
                  </h2>
                </div>
                <Link
                  href="/providers"
                  className="text-xs text-neutral-400 hover:text-white flex items-center gap-1 border border-neutral-800 px-2 py-1 bg-black"
                >
                  <span>Configure All</span>
                  <ExternalLink className="w-3 h-3" />
                </Link>
              </div>

              {providers.length === 0 ? (
                <div className="py-8 text-center text-xs text-neutral-500 space-y-3">
                  <p>No IPTV providers configured yet.</p>
                  <Link
                    href="/providers"
                    className="inline-block px-3 py-1.5 bg-white text-black font-semibold text-xs uppercase"
                  >
                    Add First Provider
                  </Link>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs border border-neutral-800">
                    <thead className="bg-neutral-900 text-neutral-400 uppercase text-[10px] border-b border-neutral-800">
                      <tr>
                        <th className="p-2.5 font-semibold">Name</th>
                        <th className="p-2.5 font-semibold">Local Route</th>
                        <th className="p-2.5 font-semibold">Upstream Host</th>
                        <th className="p-2.5 font-semibold">Status</th>
                        <th className="p-2.5 font-semibold text-right">Default</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-900">
                      {providers.map((p) => (
                        <tr key={p.id} className="hover:bg-neutral-900/40">
                          <td className="p-2.5 font-medium text-white">{p.name}</td>
                          <td className="p-2.5 text-neutral-300">
                            <span className="bg-black border border-neutral-800 px-1.5 py-0.5 text-[11px]">
                              /{p.route}
                            </span>
                          </td>
                          <td className="p-2.5 text-neutral-400 truncate max-w-[180px]">{p.host}</td>
                          <td className="p-2.5">
                            {p.enabled === 1 ? (
                              <span className="text-emerald-400 text-[10px] font-semibold uppercase">Enabled</span>
                            ) : (
                              <span className="text-neutral-500 text-[10px] font-semibold uppercase">Disabled</span>
                            )}
                          </td>
                          <td className="p-2.5 text-right">
                            {p.is_default === 1 ? (
                              <span className="bg-white text-black font-bold text-[9px] px-1.5 py-0.5 uppercase">
                                DEFAULT
                              </span>
                            ) : (
                              <span className="text-neutral-600 text-[10px]">-</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Xtream Resolution Rules Reference */}
              <div className="p-3 bg-black border border-neutral-900 text-[11px] text-neutral-400 space-y-1">
                <div className="font-semibold text-neutral-300 uppercase text-[10px]">
                  Xtream Routing Architecture:
                </div>
                <p>
                  Requests to <code className="text-neutral-200">/&lt;route&gt;/player_api.php</code> route to that specific provider.
                </p>
                <p>
                  Requests to <code className="text-neutral-200">/player_api.php</code> or <code className="text-neutral-200">/live/...</code> route automatically to the Default Provider.
                </p>
              </div>
            </div>

            {/* Right Col: Host & Capability Diagnostics */}
            <div className="border border-neutral-800 bg-neutral-950 p-4 sm:p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
                <Server className="w-4 h-4 text-white" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  Environment Diagnostics
                </h2>
              </div>

              <div className="space-y-2.5 text-xs">
                <div className="flex items-center justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-400">TUN Device (/dev/net/tun)</span>
                  {health?.tunAvailable ? (
                    <span className="text-emerald-400 font-semibold text-[11px]">PRESENT</span>
                  ) : (
                    <span className="text-rose-400 font-semibold text-[11px]">NOT DETECTED</span>
                  )}
                </div>

                <div className="flex items-center justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-400">WireGuard Tooling</span>
                  {health?.wireguardInstalled ? (
                    <span className="text-emerald-400 font-semibold text-[11px]">AVAILABLE</span>
                  ) : (
                    <span className="text-neutral-500 font-semibold text-[11px]">NOT INSTALLED</span>
                  )}
                </div>

                <div className="flex items-center justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-400">OpenVPN Binary</span>
                  {health?.openvpnInstalled ? (
                    <span className="text-emerald-400 font-semibold text-[11px]">AVAILABLE</span>
                  ) : (
                    <span className="text-neutral-500 font-semibold text-[11px]">NOT INSTALLED</span>
                  )}
                </div>

                <div className="flex items-center justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-400">Cloudflare WARP CLI</span>
                  {health?.warpInstalled ? (
                    <span className="text-emerald-400 font-semibold text-[11px]">AVAILABLE</span>
                  ) : (
                    <span className="text-neutral-500 font-semibold text-[11px]">NOT INSTALLED</span>
                  )}
                </div>

                <div className="flex items-center justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-400">Node.js Runtime</span>
                  <span className="text-neutral-200">{health?.environment.nodeVersion || process.version}</span>
                </div>

                <div className="flex items-center justify-between py-1">
                  <span className="text-neutral-400">Uptime</span>
                  <span className="text-neutral-200 font-mono">
                    {health?.environment.uptimeSeconds ? `${Math.floor(health.environment.uptimeSeconds / 60)}m` : '0m'}
                  </span>
                </div>
              </div>

              {/* Docker Note */}
              <div className="p-3 bg-black border border-neutral-900 text-[10px] text-neutral-500 space-y-1">
                <span className="text-neutral-400 font-semibold uppercase">Docker Container Note:</span>
                <p>
                  In Docker, VPN routing uses container <code className="text-neutral-300">cap_add: NET_ADMIN</code> and device <code className="text-neutral-300">/dev/net/tun</code> while preserving inbound HTTP web port 3000.
                </p>
              </div>
            </div>
          </div>

          {/* Recent Warnings / Errors Feed */}
          {recentErrors.length > 0 && (
            <div className="border border-neutral-800 bg-neutral-950 p-4 sm:p-5 space-y-3">
              <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                <div className="flex items-center gap-2 text-rose-400">
                  <AlertTriangle className="w-4 h-4" />
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    Recent Warnings & Errors
                  </h2>
                </div>
                <Link href="/logs" className="text-xs text-neutral-400 hover:text-white">
                  Open Full Logs →
                </Link>
              </div>

              <div className="space-y-2">
                {recentErrors.map((log) => (
                  <div
                    key={log.id}
                    className="p-2.5 bg-black border border-neutral-900 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 overflow-hidden">
                      <span
                        className={`text-[9px] font-bold px-1.5 py-0.5 uppercase shrink-0 ${
                          log.level === 'error'
                            ? 'bg-rose-950 text-rose-300 border border-rose-800'
                            : 'bg-amber-950 text-amber-300 border border-amber-800'
                        }`}
                      >
                        {log.level}
                      </span>
                      <span className="text-neutral-500 text-[10px] shrink-0 uppercase">[{log.source}]</span>
                      <span className="text-neutral-300 truncate text-[11px]">{log.message}</span>
                    </div>
                    <span className="text-[10px] text-neutral-600 shrink-0 font-mono">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
