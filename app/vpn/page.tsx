'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Shield,
  ShieldAlert,
  ShieldCheck,
  RefreshCw,
  Plus,
  Trash2,
  Play,
  Square,
  Globe,
  Upload,
  Search,
  Filter,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Radio,
  FileCode,
  Lock,
  ArrowRight,
  Info,
} from 'lucide-react';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';

interface VpnSummary {
  status: 'off' | 'connecting' | 'connected' | 'error';
  type: 'off' | 'wireguard' | 'openvpn' | 'warp';
  profileId: string | null;
  profileName: string | null;
  publicIp: string | null;
  country: string | null;
  connectedSince: string | null;
  lastError: string | null;
  isBusy: boolean;
}

interface WgProfile {
  id: string;
  name: string;
  config: string;
  enabled: number;
  created_at: string;
}

interface OvpnProfile {
  id: string;
  name: string;
  config: string;
  username: string | null;
  source: 'uploaded' | 'vpngate';
  enabled: number;
  created_at: string;
}

interface VpnGateServer {
  hostname: string;
  ip: string;
  score: number;
  ping: number;
  speed: number;
  countryLong: string;
  countryShort: string;
  numVpnSessions: number;
  uptime: number;
  totalUsers: number;
  totalTraffic: number;
  logType: string;
  operator: string;
  message: string;
  ovpnConfigDataBase64: string;
}

interface WarpStatus {
  installed: boolean;
  registered: boolean;
  connected: boolean;
  accountType?: string;
  deviceId?: string;
  details?: string;
}

type VpnTab = 'overview' | 'wireguard' | 'openvpn' | 'vpngate' | 'warp';

export default function VpnPage() {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [user, setUser] = useState<{ username: string } | null>(null);
  const [activeTab, setActiveTab] = useState<VpnTab>('overview');

  // VPN Status
  const [summary, setSummary] = useState<VpnSummary | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  // WireGuard State
  const [wgProfiles, setWgProfiles] = useState<WgProfile[]>([]);
  const [wgModal, setWgModal] = useState(false);
  const [wgName, setWgName] = useState('');
  const [wgConfig, setWgConfig] = useState('');

  // OpenVPN State
  const [ovpnProfiles, setOvpnProfiles] = useState<OvpnProfile[]>([]);
  const [ovpnModal, setOvpnModal] = useState(false);
  const [ovpnName, setOvpnName] = useState('');
  const [ovpnConfig, setOvpnConfig] = useState('');
  const [ovpnUsername, setOvpnUsername] = useState('');
  const [ovpnPassword, setOvpnPassword] = useState('');

  // VPNGate State
  const [vpngateServers, setVpngateServers] = useState<VpnGateServer[]>([]);
  const [vpngateLoading, setVpngateLoading] = useState(false);
  const [vpngateSearch, setVpngateSearch] = useState('');
  const [vpngateCountryFilter, setVpngateCountryFilter] = useState('ALL');
  const [maxPing, setMaxPing] = useState<number>(300);

  // WARP State
  const [warpStatus, setWarpStatus] = useState<WarpStatus | null>(null);
  const [warpLoading, setWarpLoading] = useState(false);

  // Common Loading
  const [loading, setLoading] = useState(true);

  const loadStatus = React.useCallback(async () => {
    try {
      const [authRes, vpnRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/vpn/status'),
      ]);

      if (authRes.status === 401) {
        router.push('/login');
        return;
      }
      const authData = await authRes.json();
      if (authData.authenticated) setUser(authData.user);

      if (vpnRes.ok) {
        const json = await vpnRes.json();
        if (json.success) setSummary(json.data);
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [router]);

  const loadWireGuard = React.useCallback(async () => {
    try {
      const res = await fetch('/api/vpn/wireguard');
      if (res.ok) {
        const json = await res.json();
        if (json.success) setWgProfiles(json.data);
      }
    } catch {
      // Ignore
    }
  }, []);

  const loadOpenVpn = React.useCallback(async () => {
    try {
      const res = await fetch('/api/vpn/openvpn');
      if (res.ok) {
        const json = await res.json();
        if (json.success) setOvpnProfiles(json.data);
      }
    } catch {
      // Ignore
    }
  }, []);

  const loadVpnGate = React.useCallback(async (forceRefresh = false) => {
    try {
      setVpngateLoading(true);
      const res = await fetch(`/api/vpn/vpngate?refresh=${forceRefresh ? 'true' : 'false'}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success) setVpngateServers(json.data);
      }
    } catch {
      // Ignore
    } finally {
      setVpngateLoading(false);
    }
  }, []);

  const loadWarp = React.useCallback(async () => {
    try {
      setWarpLoading(true);
      const res = await fetch('/api/vpn/warp');
      if (res.ok) {
        const json = await res.json();
        if (json.success) setWarpStatus(json.data);
      }
    } catch {
      // Ignore
    } finally {
      setWarpLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;
    async function fetchStatus() {
      try {
        const [authRes, vpnRes] = await Promise.all([
          fetch('/api/auth/me'),
          fetch('/api/vpn/status'),
        ]);

        if (authRes.status === 401) {
          router.push('/login');
          return;
        }
        const authData = await authRes.json();
        if (ignore) return;
        if (authData.authenticated) setUser(authData.user);

        if (vpnRes.ok) {
          const json = await vpnRes.json();
          if (ignore) return;
          if (json.success) setSummary(json.data);
        }
      } catch {
        // Ignore
      } finally {
        if (!ignore) setLoading(false);
      }
    }

    void fetchStatus();
    const interval = setInterval(() => {
      void fetchStatus();
    }, 5000);

    return () => {
      ignore = true;
      clearInterval(interval);
    };
  }, [router]);

  useEffect(() => {
    let ignore = false;
    async function loadTabContent() {
      try {
        if (activeTab === 'wireguard') {
          const res = await fetch('/api/vpn/wireguard');
          if (res.ok) {
            const json = await res.json();
            if (!ignore && json.success) setWgProfiles(json.data);
          }
        } else if (activeTab === 'openvpn') {
          const res = await fetch('/api/vpn/openvpn');
          if (res.ok) {
            const json = await res.json();
            if (!ignore && json.success) setOvpnProfiles(json.data);
          }
        } else if (activeTab === 'vpngate') {
          setVpngateLoading(true);
          const res = await fetch('/api/vpn/vpngate?refresh=false');
          if (res.ok) {
            const json = await res.json();
            if (!ignore && json.success) setVpngateServers(json.data);
          }
          if (!ignore) setVpngateLoading(false);
        } else if (activeTab === 'warp') {
          setWarpLoading(true);
          const res = await fetch('/api/vpn/warp');
          if (res.ok) {
            const json = await res.json();
            if (!ignore && json.success) setWarpStatus(json.data);
          }
          if (!ignore) setWarpLoading(false);
        }
      } catch {
        // Ignore
      }
    }

    void loadTabContent();
    return () => {
      ignore = true;
    };
  }, [activeTab]);

  // Connect Handler
  const handleConnect = async (type: 'wireguard' | 'openvpn' | 'warp', profileId?: string) => {
    setActionError(null);
    setBusyAction(`Connecting ${type.toUpperCase()}...`);
    try {
      const res = await fetch('/api/vpn/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, profileId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data.error || 'Connection failed');
      } else {
        setSummary(data.data);
      }
    } catch {
      setActionError('Network or server error');
    } finally {
      setBusyAction(null);
      await loadStatus();
    }
  };

  // Disconnect Handler
  const handleDisconnect = async () => {
    setActionError(null);
    setBusyAction('Disconnecting VPN...');
    try {
      const res = await fetch('/api/vpn/disconnect', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data.error || 'Disconnection failed');
      } else {
        setSummary(data.data);
      }
    } catch {
      setActionError('Network or server error');
    } finally {
      setBusyAction(null);
      await loadStatus();
    }
  };

  // WireGuard Create
  const handleSaveWireGuard = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    try {
      const res = await fetch('/api/vpn/wireguard', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: wgName, config: wgConfig }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data.error || 'Failed to save WireGuard profile');
        return;
      }
      setWgModal(false);
      setWgName('');
      setWgConfig('');
      await loadWireGuard();
    } catch {
      setActionError('Failed to save profile');
    }
  };

  // OpenVPN Create
  const handleSaveOpenVpn = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    try {
      const res = await fetch('/api/vpn/openvpn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: ovpnName,
          config: ovpnConfig,
          username: ovpnUsername || null,
          password: ovpnPassword || null,
          source: 'uploaded',
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data.error || 'Failed to save OpenVPN profile');
        return;
      }
      setOvpnModal(false);
      setOvpnName('');
      setOvpnConfig('');
      setOvpnUsername('');
      setOvpnPassword('');
      await loadOpenVpn();
    } catch {
      setActionError('Failed to save profile');
    }
  };

  // VPNGate Save as Profile
  const handleSaveVpnGateServer = async (server: VpnGateServer) => {
    setActionError(null);
    try {
      const res = await fetch('/api/vpn/vpngate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `VPNGate ${server.countryLong} (${server.ip})`,
          ovpnConfigBase64: server.ovpnConfigDataBase64,
          country: server.countryShort,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data.error || 'Failed to save VPNGate profile');
      } else {
        alert('Server saved to OpenVPN profiles successfully!');
      }
    } catch {
      setActionError('Failed to save server profile');
    }
  };

  // WARP Action
  const handleWarpAction = async (action: 'register' | 'connect' | 'disconnect' | 'reset') => {
    setActionError(null);
    setBusyAction(`WARP: ${action}...`);
    try {
      const res = await fetch('/api/vpn/warp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setActionError(data.error || `WARP ${action} failed`);
      }
      await loadWarp();
      await loadStatus();
    } catch {
      setActionError(`Network error during WARP ${action}`);
    } finally {
      setBusyAction(null);
    }
  };

  const isConnecting = summary?.status === 'connecting' || busyAction !== null;

  // VPNGate Country List
  const uniqueCountries = Array.from(new Set(vpngateServers.map((s) => s.countryShort))).sort();
  const filteredVpnGate = vpngateServers.filter((s) => {
    const matchesSearch =
      s.countryLong.toLowerCase().includes(vpngateSearch.toLowerCase()) ||
      s.ip.includes(vpngateSearch) ||
      s.hostname.toLowerCase().includes(vpngateSearch.toLowerCase());
    const matchesCountry = vpngateCountryFilter === 'ALL' || s.countryShort === vpngateCountryFilter;
    const matchesPing = s.ping <= maxPing;
    return matchesSearch && matchesCountry && matchesPing;
  });

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
              <h1 className="text-base sm:text-lg font-bold text-white uppercase tracking-tight flex items-center gap-2">
                <Shield className="w-5 h-5" />
                <span>VPN Orchestration</span>
              </h1>
              <p className="text-xs text-neutral-500">
                Single-tunnel VPN engine supporting WireGuard, OpenVPN, VPNGate, and Cloudflare WARP.
              </p>
            </div>

            {/* Global Connection Controls */}
            <div className="flex items-center gap-2">
              {summary?.status === 'connected' ? (
                <button
                  id="btn-global-disconnect"
                  onClick={handleDisconnect}
                  disabled={isConnecting}
                  className="px-3.5 py-2 bg-rose-950 text-rose-300 hover:bg-rose-900 border border-rose-800 text-xs font-bold uppercase tracking-wider flex items-center gap-2 cursor-pointer disabled:opacity-50"
                >
                  <Square className="w-3.5 h-3.5 fill-rose-300" />
                  <span>{isConnecting ? 'Stopping...' : 'Disconnect VPN'}</span>
                </button>
              ) : (
                <button
                  id="btn-global-refresh-status"
                  onClick={loadStatus}
                  disabled={isConnecting}
                  className="px-3.5 py-2 bg-neutral-900 text-neutral-300 hover:text-white border border-neutral-800 text-xs uppercase flex items-center gap-2"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${isConnecting ? 'animate-spin' : ''}`} />
                  <span>Refresh Status</span>
                </button>
              )}
            </div>
          </div>

          {/* Action / Error Banner */}
          {actionError && (
            <div className="p-3 bg-rose-950/50 border border-rose-800 text-rose-300 text-xs flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="flex-1 text-[11px]">{actionError}</div>
              <button onClick={() => setActionError(null)} className="text-neutral-400 hover:text-white">
                ✕
              </button>
            </div>
          )}

          {busyAction && (
            <div className="p-3 bg-amber-950/40 border border-amber-800 text-amber-300 text-xs flex items-center gap-2.5">
              <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
              <span>{busyAction}</span>
            </div>
          )}

          {/* Tabs Navigation */}
          <div className="flex border-b border-neutral-800 text-xs select-none overflow-x-auto">
            <button
              id="tab-vpn-overview"
              onClick={() => setActiveTab('overview')}
              className={`px-4 py-2.5 font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer shrink-0 ${
                activeTab === 'overview'
                  ? 'border-white text-white bg-neutral-900/60'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Overview & Status
            </button>
            <button
              id="tab-vpn-wireguard"
              onClick={() => setActiveTab('wireguard')}
              className={`px-4 py-2.5 font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer shrink-0 ${
                activeTab === 'wireguard'
                  ? 'border-white text-white bg-neutral-900/60'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              WireGuard
            </button>
            <button
              id="tab-vpn-openvpn"
              onClick={() => setActiveTab('openvpn')}
              className={`px-4 py-2.5 font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer shrink-0 ${
                activeTab === 'openvpn'
                  ? 'border-white text-white bg-neutral-900/60'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              OpenVPN
            </button>
            <button
              id="tab-vpn-vpngate"
              onClick={() => setActiveTab('vpngate')}
              className={`px-4 py-2.5 font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer shrink-0 ${
                activeTab === 'vpngate'
                  ? 'border-white text-white bg-neutral-900/60'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              VPNGate (Public)
            </button>
            <button
              id="tab-vpn-warp"
              onClick={() => setActiveTab('warp')}
              className={`px-4 py-2.5 font-bold uppercase tracking-wider border-b-2 transition-colors cursor-pointer shrink-0 ${
                activeTab === 'warp'
                  ? 'border-white text-white bg-neutral-900/60'
                  : 'border-transparent text-neutral-400 hover:text-neutral-200'
              }`}
            >
              Cloudflare WARP
            </button>
          </div>

          {/* TAB 1: OVERVIEW */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {/* State Card */}
                <div className="border border-neutral-800 bg-neutral-950 p-5 space-y-4">
                  <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Active Tunnel Status
                    </span>
                    <span className="text-[10px] text-neutral-500">MUTEX PROTECTED</span>
                  </div>

                  <div className="flex items-center gap-4 py-2">
                    {summary?.status === 'connected' ? (
                      <div className="w-12 h-12 bg-emerald-950 border border-emerald-800 flex items-center justify-center text-emerald-400 shrink-0">
                        <ShieldCheck className="w-6 h-6" />
                      </div>
                    ) : summary?.status === 'connecting' ? (
                      <div className="w-12 h-12 bg-amber-950 border border-amber-800 flex items-center justify-center text-amber-400 shrink-0">
                        <RefreshCw className="w-6 h-6 animate-spin" />
                      </div>
                    ) : summary?.status === 'error' ? (
                      <div className="w-12 h-12 bg-rose-950 border border-rose-800 flex items-center justify-center text-rose-400 shrink-0">
                        <ShieldAlert className="w-6 h-6" />
                      </div>
                    ) : (
                      <div className="w-12 h-12 bg-neutral-900 border border-neutral-800 flex items-center justify-center text-neutral-500 shrink-0">
                        <Shield className="w-6 h-6" />
                      </div>
                    )}

                    <div className="space-y-1 overflow-hidden">
                      <div className="text-sm font-bold uppercase text-white tracking-wide">
                        {summary?.status === 'connected'
                          ? `CONNECTED: ${summary.type.toUpperCase()}`
                          : summary?.status === 'connecting'
                          ? 'CONNECTING TUNNEL...'
                          : summary?.status === 'error'
                          ? 'TUNNEL ERROR'
                          : 'VPN OFF (DIRECT CONNECTION)'}
                      </div>
                      <div className="text-xs text-neutral-400 truncate">
                        {summary?.profileName || 'No profile attached'}
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2 text-xs pt-2 border-t border-neutral-900">
                    <div className="flex justify-between py-1 border-b border-neutral-900">
                      <span className="text-neutral-500">Public IP (Egress)</span>
                      <span className="text-white font-mono">{summary?.publicIp || 'Direct Host IP'}</span>
                    </div>
                    <div className="flex justify-between py-1 border-b border-neutral-900">
                      <span className="text-neutral-500">Connected Since</span>
                      <span className="text-neutral-300">
                        {summary?.connectedSince
                          ? new Date(summary.connectedSince).toLocaleString()
                          : 'N/A'}
                      </span>
                    </div>
                    <div className="flex justify-between py-1">
                      <span className="text-neutral-500">Active Type</span>
                      <span className="text-neutral-300 uppercase">{summary?.type || 'none'}</span>
                    </div>
                  </div>

                  {summary?.lastError && (
                    <div className="p-3 bg-rose-950/40 border border-rose-800 text-rose-300 text-[11px] space-y-1">
                      <span className="font-bold uppercase">Last Failure Message:</span>
                      <p className="break-all">{summary.lastError}</p>
                    </div>
                  )}
                </div>

                {/* Architectural Policy Card */}
                <div className="border border-neutral-800 bg-neutral-950 p-5 space-y-4">
                  <div className="flex items-center gap-2 border-b border-neutral-800 pb-3">
                    <Info className="w-4 h-4 text-white" />
                    <span className="text-xs font-bold uppercase tracking-wider text-white">
                      Single-Tunnel Architecture
                    </span>
                  </div>

                  <div className="text-xs text-neutral-400 space-y-3 leading-relaxed">
                    <p>
                      <strong>Mutual Exclusion:</strong> Only one VPN tunnel (WireGuard, OpenVPN, or WARP) can be active at a time. Activating a new tunnel automatically disconnects any existing tunnel cleanly.
                    </p>
                    <p>
                      <strong>Egress Routing:</strong> When active, all upstream IPTV provider fetches and stream metadata requests route through the VPN tunnel.
                    </p>
                    <p>
                      <strong>Inbound Traffic Preservation:</strong> Administrative UI (port 3000) and proxy streaming port (8080) maintain host routing table rules so management access is never lost.
                    </p>
                  </div>

                  <div className="p-3 bg-black border border-neutral-900 text-[11px] text-neutral-400 space-y-1">
                    <div className="font-bold text-neutral-300 uppercase text-[10px]">Verification Policy:</div>
                    <p>
                      Every VPN connection operation validates real IP egress via external check before confirming status.
                    </p>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* TAB 2: WIREGUARD */}
          {activeTab === 'wireguard' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    WireGuard Profiles
                  </h2>
                  <p className="text-[11px] text-neutral-500">
                    High-performance kernel/userspace WireGuard configurations (.conf)
                  </p>
                </div>
                <button
                  id="btn-add-wireguard"
                  onClick={() => setWgModal(true)}
                  className="px-3.5 py-1.5 bg-white text-black font-bold text-xs uppercase tracking-wider hover:bg-neutral-200 transition-colors border border-white flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Profile</span>
                </button>
              </div>

              <div className="border border-neutral-800 bg-neutral-950">
                {wgProfiles.length === 0 ? (
                  <div className="p-8 text-center text-xs text-neutral-500 space-y-3">
                    <p>No WireGuard profiles configured.</p>
                    <button
                      onClick={() => setWgModal(true)}
                      className="px-3 py-1.5 bg-white text-black font-semibold text-xs uppercase"
                    >
                      Import .conf Profile
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-900 text-neutral-400 uppercase text-[10px] border-b border-neutral-800">
                        <tr>
                          <th className="p-3 font-semibold">Profile Name</th>
                          <th className="p-3 font-semibold">Configuration</th>
                          <th className="p-3 font-semibold">Status</th>
                          <th className="p-3 font-semibold text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-900">
                        {wgProfiles.map((p) => {
                          const isConnected =
                            summary?.type === 'wireguard' &&
                            summary?.profileId === p.id &&
                            summary?.status === 'connected';

                          return (
                            <tr key={p.id} className="hover:bg-neutral-900/40">
                              <td className="p-3 font-medium text-white">{p.name}</td>
                              <td className="p-3 font-mono text-neutral-400 text-[11px]">
                                {p.config.split('\n').filter((l) => l.trim().startsWith('Address') || l.trim().startsWith('Endpoint')).join(' | ') || 'Configured'}
                              </td>
                              <td className="p-3">
                                {isConnected ? (
                                  <span className="text-emerald-400 font-bold text-[10px] uppercase flex items-center gap-1">
                                    <span className="w-2 h-2 bg-emerald-500 inline-block" />
                                    Active Tunnel
                                  </span>
                                ) : (
                                  <span className="text-neutral-500 text-[10px] uppercase">Inactive</span>
                                )}
                              </td>
                              <td className="p-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  {isConnected ? (
                                    <button
                                      onClick={handleDisconnect}
                                      disabled={isConnecting}
                                      className="px-2.5 py-1 bg-rose-950 text-rose-300 border border-rose-800 text-[11px] uppercase hover:bg-rose-900"
                                    >
                                      Disconnect
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => handleConnect('wireguard', p.id)}
                                      disabled={isConnecting}
                                      className="px-2.5 py-1 bg-white text-black font-bold border border-white text-[11px] uppercase hover:bg-neutral-200 flex items-center gap-1"
                                    >
                                      <Play className="w-3 h-3 fill-black" />
                                      Connect
                                    </button>
                                  )}
                                  <button
                                    onClick={async () => {
                                      if (confirm(`Delete WireGuard profile "${p.name}"?`)) {
                                        await fetch(`/api/vpn/wireguard/${p.id}`, { method: 'DELETE' });
                                        await loadWireGuard();
                                      }
                                    }}
                                    className="p-1 text-neutral-500 hover:text-rose-400 border border-neutral-800 bg-black"
                                    title="Delete Profile"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
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
            </div>
          )}

          {/* TAB 3: OPENVPN */}
          {activeTab === 'openvpn' && (
            <div className="space-y-6">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    OpenVPN Profiles
                  </h2>
                  <p className="text-[11px] text-neutral-500">
                    Standard OpenVPN (.ovpn) configuration profiles with credentials support
                  </p>
                </div>
                <button
                  id="btn-add-openvpn"
                  onClick={() => setOvpnModal(true)}
                  className="px-3.5 py-1.5 bg-white text-black font-bold text-xs uppercase tracking-wider hover:bg-neutral-200 transition-colors border border-white flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add Profile</span>
                </button>
              </div>

              <div className="border border-neutral-800 bg-neutral-950">
                {ovpnProfiles.length === 0 ? (
                  <div className="p-8 text-center text-xs text-neutral-500 space-y-3">
                    <p>No OpenVPN profiles configured.</p>
                    <button
                      onClick={() => setOvpnModal(true)}
                      className="px-3 py-1.5 bg-white text-black font-semibold text-xs uppercase"
                    >
                      Import .ovpn Profile
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-900 text-neutral-400 uppercase text-[10px] border-b border-neutral-800">
                        <tr>
                          <th className="p-3 font-semibold">Profile Name</th>
                          <th className="p-3 font-semibold">Source</th>
                          <th className="p-3 font-semibold">Status</th>
                          <th className="p-3 font-semibold text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-900">
                        {ovpnProfiles.map((p) => {
                          const isConnected =
                            summary?.type === 'openvpn' &&
                            summary?.profileId === p.id &&
                            summary?.status === 'connected';

                          return (
                            <tr key={p.id} className="hover:bg-neutral-900/40">
                              <td className="p-3 font-medium text-white">{p.name}</td>
                              <td className="p-3">
                                <span className="bg-black border border-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">
                                  {p.source}
                                </span>
                              </td>
                              <td className="p-3">
                                {isConnected ? (
                                  <span className="text-emerald-400 font-bold text-[10px] uppercase flex items-center gap-1">
                                    <span className="w-2 h-2 bg-emerald-500 inline-block" />
                                    Active Tunnel
                                  </span>
                                ) : (
                                  <span className="text-neutral-500 text-[10px] uppercase">Inactive</span>
                                )}
                              </td>
                              <td className="p-3 text-right">
                                <div className="flex items-center justify-end gap-2">
                                  {isConnected ? (
                                    <button
                                      onClick={handleDisconnect}
                                      disabled={isConnecting}
                                      className="px-2.5 py-1 bg-rose-950 text-rose-300 border border-rose-800 text-[11px] uppercase hover:bg-rose-900"
                                    >
                                      Disconnect
                                    </button>
                                  ) : (
                                    <button
                                      onClick={() => handleConnect('openvpn', p.id)}
                                      disabled={isConnecting}
                                      className="px-2.5 py-1 bg-white text-black font-bold border border-white text-[11px] uppercase hover:bg-neutral-200 flex items-center gap-1"
                                    >
                                      <Play className="w-3 h-3 fill-black" />
                                      Connect
                                    </button>
                                  )}
                                  <button
                                    onClick={async () => {
                                      if (confirm(`Delete OpenVPN profile "${p.name}"?`)) {
                                        await fetch(`/api/vpn/openvpn/${p.id}`, { method: 'DELETE' });
                                        await loadOpenVpn();
                                      }
                                    }}
                                    className="p-1 text-neutral-500 hover:text-rose-400 border border-neutral-800 bg-black"
                                    title="Delete Profile"
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
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
            </div>
          )}

          {/* TAB 4: VPNGATE */}
          {activeTab === 'vpngate' && (
            <div className="space-y-6">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div>
                  <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                    VPNGate Public Relays
                  </h2>
                  <p className="text-[11px] text-neutral-500">
                    Live public OpenVPN mirrors provided by University of Tsukuba VPNGate project.
                  </p>
                </div>
                <button
                  onClick={() => loadVpnGate(true)}
                  disabled={vpngateLoading}
                  className="px-3.5 py-1.5 bg-white text-black font-bold text-xs uppercase tracking-wider hover:bg-neutral-200 transition-colors border border-white flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${vpngateLoading ? 'animate-spin' : ''}`} />
                  <span>Fetch Upstream List</span>
                </button>
              </div>

              {/* Filters Bar */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-neutral-950 border border-neutral-800 p-3 text-xs">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500" />
                  <input
                    type="text"
                    value={vpngateSearch}
                    onChange={(e) => setVpngateSearch(e.target.value)}
                    placeholder="Search by country or IP..."
                    className="w-full pl-9 pr-3 py-1.5 bg-black border border-neutral-800 text-white placeholder-neutral-600 focus:border-white focus:outline-none text-xs"
                  />
                </div>

                <div>
                  <select
                    value={vpngateCountryFilter}
                    onChange={(e) => setVpngateCountryFilter(e.target.value)}
                    className="w-full px-3 py-1.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none text-xs"
                  >
                    <option value="ALL">All Countries ({vpngateServers.length})</option>
                    {uniqueCountries.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-neutral-500 text-[11px] whitespace-nowrap">Max Ping:</span>
                  <input
                    type="range"
                    min="10"
                    max="500"
                    step="10"
                    value={maxPing}
                    onChange={(e) => setMaxPing(parseInt(e.target.value, 10))}
                    className="w-full accent-white"
                  />
                  <span className="text-neutral-300 text-[11px] w-12 text-right">{maxPing}ms</span>
                </div>
              </div>

              <div className="border border-neutral-800 bg-neutral-950">
                {vpngateLoading ? (
                  <div className="p-8 text-center text-xs text-neutral-500 space-y-2">
                    <RefreshCw className="w-4 h-4 animate-spin mx-auto" />
                    <span>Fetching live public servers from VPNGate CSV mirror...</span>
                  </div>
                ) : filteredVpnGate.length === 0 ? (
                  <div className="p-8 text-center text-xs text-neutral-500 space-y-2">
                    <p>No servers match your filters.</p>
                    <button
                      onClick={() => loadVpnGate(true)}
                      className="px-3 py-1.5 bg-white text-black font-semibold text-xs uppercase"
                    >
                      Refresh Mirror
                    </button>
                  </div>
                ) : (
                  <div className="overflow-x-auto max-h-[500px]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-neutral-900 text-neutral-400 uppercase text-[10px] border-b border-neutral-800 sticky top-0">
                        <tr>
                          <th className="p-3 font-semibold">Country</th>
                          <th className="p-3 font-semibold">IP / Host</th>
                          <th className="p-3 font-semibold">Ping</th>
                          <th className="p-3 font-semibold">Throughput</th>
                          <th className="p-3 font-semibold">Sessions</th>
                          <th className="p-3 font-semibold text-right">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-neutral-900">
                        {filteredVpnGate.map((s, idx) => (
                          <tr key={`${s.ip}-${idx}`} className="hover:bg-neutral-900/40">
                            <td className="p-3 font-medium text-white">
                              <div className="flex items-center gap-2">
                                <span className="bg-black border border-neutral-800 px-1.5 py-0.5 text-[10px] uppercase font-bold">
                                  {s.countryShort}
                                </span>
                                <span className="truncate max-w-[140px]">{s.countryLong}</span>
                              </div>
                            </td>
                            <td className="p-3 font-mono text-neutral-300 text-[11px]">{s.ip}</td>
                            <td className="p-3">
                              <span
                                className={`text-[11px] font-semibold ${
                                  s.ping < 50
                                    ? 'text-emerald-400'
                                    : s.ping < 150
                                    ? 'text-amber-400'
                                    : 'text-neutral-400'
                                }`}
                              >
                                {s.ping} ms
                              </span>
                            </td>
                            <td className="p-3 text-neutral-400 text-[11px]">
                              {(s.speed / (1024 * 1024)).toFixed(1)} Mbps
                            </td>
                            <td className="p-3 text-neutral-400">{s.numVpnSessions}</td>
                            <td className="p-3 text-right">
                              <button
                                onClick={() => handleSaveVpnGateServer(s)}
                                className="px-2 py-1 bg-white text-black font-bold border border-white text-[10px] uppercase hover:bg-neutral-200"
                              >
                                Save as Profile
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 5: CLOUDFLARE WARP */}
          {activeTab === 'warp' && (
            <div className="space-y-6">
              <div className="border border-neutral-800 bg-neutral-950 p-5 space-y-4">
                <div className="flex items-center justify-between border-b border-neutral-800 pb-3">
                  <div className="flex items-center gap-2">
                    <Zap className="w-4 h-4 text-amber-400" />
                    <h2 className="text-xs font-bold uppercase tracking-wider text-white">
                      Cloudflare WARP Client
                    </h2>
                  </div>
                  <button
                    onClick={loadWarp}
                    disabled={warpLoading}
                    className="p-1 border border-neutral-800 bg-black text-neutral-400 hover:text-white"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${warpLoading ? 'animate-spin' : ''}`} />
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div className="p-3 bg-black border border-neutral-900 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Binary Installed</span>
                      <span className={warpStatus?.installed ? 'text-emerald-400 font-bold' : 'text-neutral-500'}>
                        {warpStatus?.installed ? 'YES' : 'NOT FOUND'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Registered</span>
                      <span className={warpStatus?.registered ? 'text-emerald-400 font-bold' : 'text-amber-400'}>
                        {warpStatus?.registered ? 'REGISTERED' : 'UNREGISTERED'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">WARP Status</span>
                      <span className={warpStatus?.connected ? 'text-emerald-400 font-bold' : 'text-neutral-400'}>
                        {warpStatus?.connected ? 'CONNECTED' : 'DISCONNECTED'}
                      </span>
                    </div>
                  </div>

                  <div className="p-3 bg-black border border-neutral-900 space-y-2">
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Account Type</span>
                      <span className="text-white">{warpStatus?.accountType || 'Free'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-neutral-500">Device ID</span>
                      <span className="text-neutral-300 font-mono text-[10px] truncate max-w-[140px]">
                        {warpStatus?.deviceId || 'N/A'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex flex-wrap gap-2 pt-2 border-t border-neutral-900">
                  <button
                    onClick={() => handleWarpAction('register')}
                    disabled={isConnecting}
                    className="px-3 py-1.5 bg-neutral-900 text-white border border-neutral-800 text-xs uppercase hover:bg-neutral-800"
                  >
                    Register Client
                  </button>
                  <button
                    onClick={() => handleWarpAction('connect')}
                    disabled={isConnecting}
                    className="px-3 py-1.5 bg-white text-black font-bold border border-white text-xs uppercase hover:bg-neutral-200"
                  >
                    Connect WARP
                  </button>
                  <button
                    onClick={() => handleWarpAction('disconnect')}
                    disabled={isConnecting}
                    className="px-3 py-1.5 bg-rose-950 text-rose-300 border border-rose-800 text-xs uppercase hover:bg-rose-900"
                  >
                    Disconnect
                  </button>
                  <button
                    onClick={() => handleWarpAction('reset')}
                    disabled={isConnecting}
                    className="px-3 py-1.5 bg-black text-neutral-500 border border-neutral-800 text-xs uppercase hover:text-white"
                  >
                    Reset Registration
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>

      {/* WireGuard Upload Modal */}
      {wgModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-xl border border-neutral-800 bg-neutral-950 p-6 space-y-4">
            <h2 className="text-sm font-bold text-white uppercase">Add WireGuard Profile</h2>
            <form onSubmit={handleSaveWireGuard} className="space-y-3 text-xs">
              <div>
                <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                  Profile Name *
                </label>
                <input
                  type="text"
                  value={wgName}
                  onChange={(e) => setWgName(e.target.value)}
                  required
                  placeholder="Mullvad Sweden / ProtonVPN"
                  className="w-full px-3 py-2 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                  WireGuard Configuration (.conf) *
                </label>
                <textarea
                  rows={8}
                  value={wgConfig}
                  onChange={(e) => setWgConfig(e.target.value)}
                  required
                  placeholder="[Interface]&#10;PrivateKey = ...&#10;Address = 10.2.0.2/32&#10;DNS = 1.1.1.1&#10;&#10;[Peer]&#10;PublicKey = ...&#10;Endpoint = 198.51.100.1:51820&#10;AllowedIPs = 0.0.0.0/0"
                  className="w-full px-3 py-2 bg-black border border-neutral-800 text-white font-mono text-xs focus:border-white focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setWgModal(false)}
                  className="px-4 py-2 border border-neutral-800 text-neutral-400 hover:text-white uppercase"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-white text-black font-bold uppercase hover:bg-neutral-200"
                >
                  Save Profile
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* OpenVPN Upload Modal */}
      {ovpnModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs">
          <div className="w-full max-w-xl border border-neutral-800 bg-neutral-950 p-6 space-y-4">
            <h2 className="text-sm font-bold text-white uppercase">Add OpenVPN Profile</h2>
            <form onSubmit={handleSaveOpenVpn} className="space-y-3 text-xs">
              <div>
                <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                  Profile Name *
                </label>
                <input
                  type="text"
                  value={ovpnName}
                  onChange={(e) => setOvpnName(e.target.value)}
                  required
                  placeholder="NordVPN US / Custom Gateway"
                  className="w-full px-3 py-2 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-neutral-400 text-[10px] uppercase mb-1">
                    Auth Username (Optional)
                  </label>
                  <input
                    type="text"
                    value={ovpnUsername}
                    onChange={(e) => setOvpnUsername(e.target.value)}
                    placeholder="user"
                    className="w-full px-2.5 py-1.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-neutral-400 text-[10px] uppercase mb-1">
                    Auth Password (Optional)
                  </label>
                  <input
                    type="password"
                    value={ovpnPassword}
                    onChange={(e) => setOvpnPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-2.5 py-1.5 bg-black border border-neutral-800 text-white focus:border-white focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-neutral-400 text-[11px] font-semibold mb-1 uppercase">
                  OpenVPN Configuration (.ovpn) *
                </label>
                <textarea
                  rows={8}
                  value={ovpnConfig}
                  onChange={(e) => setOvpnConfig(e.target.value)}
                  required
                  placeholder="client&#10;dev tun&#10;proto udp&#10;remote vpn.example.com 1194&#10;resolv-retry infinite&#10;nobind&#10;persist-key&#10;persist-tun&#10;<ca>&#10;-----BEGIN CERTIFICATE-----&#10;...&#10;-----END CERTIFICATE-----&#10;</ca>"
                  className="w-full px-3 py-2 bg-black border border-neutral-800 text-white font-mono text-xs focus:border-white focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-neutral-800">
                <button
                  type="button"
                  onClick={() => setOvpnModal(false)}
                  className="px-4 py-2 border border-neutral-800 text-neutral-400 hover:text-white uppercase"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-white text-black font-bold uppercase hover:bg-neutral-200"
                >
                  Save Profile
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
