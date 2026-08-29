'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Settings as SettingsIcon,
  Database,
  Server,
  Shield,
  Save,
  CheckCircle2,
  AlertTriangle,
  Radio,
  FileCode,
  HardDrive,
} from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

interface AppSettings {
  id: string;
  active_vpn_type: string;
  active_vpn_profile_id: string | null;
  vpn_status: string;
  public_ip: string | null;
  log_retention_days: number;
  initial_setup_completed: number;
}

interface HealthData {
  dbPath: string;
  dbSizeFormatted: string;
  dbWalMode: boolean;
  totalProviders: number;
  activeProviders: number;
  totalLogs: number;
  environment: {
    nodeVersion: string;
    platform: string;
    arch: string;
    uptimeSeconds: number;
  };
}

export default function SettingsPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);

  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);

  // Form State
  const [logRetentionDays, setLogRetentionDays] = useState(30);
  const [saving, setSaving] = useState(false);
  const [savedSuccess, setSavedSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function fetchData() {
      try {
        const [authRes, settingsRes, healthRes] = await Promise.all([
          fetch('/api/auth/me'),
          fetch('/api/settings'),
          fetch('/api/system/health'),
        ]);

        if (authRes.status === 401) {
          router.push('/login');
          return;
        }
        const authData = await authRes.json();
        if (ignore) return;
        if (authData.authenticated) setUser(authData.user);

        if (settingsRes.ok) {
          const s = await settingsRes.json();
          if (ignore) return;
          if (s.success) {
            setSettings(s.data);
            setLogRetentionDays(s.data.log_retention_days || 30);
          }
        }

        if (healthRes.ok) {
          const h = await healthRes.json();
          if (ignore) return;
          if (h.success) setHealth(h.data);
        }
      } catch {
        // Ignore
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void fetchData();
    return () => {
      ignore = true;
    };
  }, [router]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveError(null);
    setSavedSuccess(false);

    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ log_retention_days: Number(logRetentionDays) }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setSaveError(data.error || 'Failed to save settings');
      } else {
        setSavedSuccess(true);
        setTimeout(() => setSavedSuccess(false), 3000);
      }
    } catch {
      setSaveError('Network or server error');
    } finally {
      setSaving(false);
    }
  };

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
          <div className="border-b border-neutral-800 pb-4">
            <h1 className="text-base sm:text-lg font-bold text-white uppercase tracking-tight flex items-center gap-2">
              <SettingsIcon className="w-5 h-5" />
              <span>System & Architecture Settings</span>
            </h1>
            <p className="text-xs text-neutral-500">
              Database persistence, log retention schedules, and Go engine interface specifications.
            </p>
          </div>

          {saveError && (
            <div className="p-3 bg-rose-950/50 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
              <AlertTriangle className="w-4 h-4" />
              <span>{saveError}</span>
            </div>
          )}

          {savedSuccess && (
            <div className="p-3 bg-emerald-950/50 border border-emerald-800 text-emerald-300 text-xs flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4" />
              <span>Settings saved successfully.</span>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Global Settings Form */}
            <div className="border border-neutral-800 bg-neutral-950 p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
                <HardDrive className="w-4 h-4 text-white" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  Maintenance & Retention
                </h2>
              </div>

              <form onSubmit={handleSave} className="space-y-4 text-xs">
                <div>
                  <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                    Audit Log Retention Period (Days)
                  </label>
                  <input
                    type="number"
                    min="1"
                    max="365"
                    value={logRetentionDays}
                    onChange={(e) => setLogRetentionDays(parseInt(e.target.value, 10))}
                    className="w-full px-3 py-2 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none"
                  />
                  <p className="text-[10px] text-neutral-500 mt-1">
                    Log entries older than this limit are pruned during database optimization cycles.
                  </p>
                </div>

                <div className="pt-2">
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-4 py-2 bg-white text-black font-bold uppercase text-xs hover:bg-neutral-200 border border-white cursor-pointer flex items-center gap-2 disabled:opacity-50"
                  >
                    <Save className="w-3.5 h-3.5" />
                    <span>{saving ? 'Saving...' : 'Save Preferences'}</span>
                  </button>
                </div>
              </form>
            </div>

            {/* SQLite Database Telemetry */}
            <div className="border border-neutral-800 bg-neutral-950 p-5 space-y-4">
              <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
                <Database className="w-4 h-4 text-white" />
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  SQLite Database Telemetry
                </h2>
              </div>

              <div className="space-y-2.5 text-xs">
                <div className="flex justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-500">Database Path</span>
                  <span className="text-neutral-200 font-mono text-[11px]">{health?.dbPath || '/data/iptv-proxy.db'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-500">Journal Mode</span>
                  <span className="text-emerald-400 font-bold uppercase">
                    {health?.dbWalMode ? 'WAL (Write-Ahead Logging)' : 'Standard'}
                  </span>
                </div>
                <div className="flex justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-500">Database Size</span>
                  <span className="text-white font-mono">{health?.dbSizeFormatted || 'N/A'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-neutral-900">
                  <span className="text-neutral-500">Total Provider Records</span>
                  <span className="text-white">{health?.totalProviders ?? 0}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className="text-neutral-500">Total Audit Logs</span>
                  <span className="text-white">{health?.totalLogs ?? 0}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Go Proxy Core Engine Interface Reference */}
          <div className="border border-neutral-800 bg-neutral-950 p-5 space-y-4">
            <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
              <Radio className="w-4 h-4 text-white" />
              <div>
                <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                  Go IPTV Proxy / Core Engine Interface Reference
                </h2>
                <p className="text-[11px] text-neutral-500">
                  Specifications for the Go high-throughput video streaming proxy service.
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
              <div className="p-3.5 bg-black border border-neutral-900 space-y-2">
                <span className="text-white font-bold uppercase text-[11px] block">
                  1. Shared SQLite State
                </span>
                <p className="text-neutral-400 text-[11px] leading-relaxed">
                  Both services share the SQLite database file in WAL mode. The Go engine reads <code className="text-neutral-200">iptv_providers</code> and <code className="text-neutral-200">app_settings</code> directly with zero IPC overhead.
                </p>
              </div>

              <div className="p-3.5 bg-black border border-neutral-900 space-y-2">
                <span className="text-white font-bold uppercase text-[11px] block">
                  2. High-Performance Video Forwarding
                </span>
                <p className="text-neutral-400 text-[11px] leading-relaxed">
                  Next.js never touches video TS/M3U8 chunks. The Go engine streams video packets using zero-allocation ring buffers and HTTP pipe forwarding.
                </p>
              </div>

              <div className="p-3.5 bg-black border border-neutral-900 space-y-2">
                <span className="text-white font-bold uppercase text-[11px] block">
                  3. Path Normalization Contract
                </span>
                <p className="text-neutral-400 text-[11px] leading-relaxed">
                  Requests matching <code className="text-neutral-200">/&lt;route&gt;/...</code> are mapped to the matched provider with credentials substituted in-flight; bare paths route to the default provider.
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
