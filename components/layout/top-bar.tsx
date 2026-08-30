'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Globe2, MapPin, Menu, RefreshCw, Server, Shield, ShieldAlert, ShieldCheck } from 'lucide-react';
import Link from 'next/link';

interface TopBarProps {
  onToggleMobile?: () => void;
}

interface VpnStatusData {
  status: 'off' | 'connecting' | 'connected' | 'error';
  type: 'off' | 'wireguard' | 'openvpn' | 'warp';
  profileName: string | null;
  lastError: string | null;
  isBusy: boolean;
}

interface NetworkStatusData {
  ip: string | null;
  country: string | null;
  region: string | null;
  city: string | null;
  location: string | null;
  server: string;
  vpnStatus: 'off' | 'connecting' | 'connected' | 'error';
  vpnType: 'off' | 'wireguard' | 'openvpn' | 'warp';
  checkedAt: string;
}

export function TopBar({ onToggleMobile }: TopBarProps) {
  const [vpn, setVpn] = useState<VpnStatusData | null>(null);
  const [network, setNetwork] = useState<NetworkStatusData | null>(null);
  const [loading, setLoading] = useState(false);

  const refreshStatus = useCallback(async (forceNetwork = false) => {
    try {
      setLoading(true);
      const [vpnRes, networkRes] = await Promise.all([
        fetch('/api/vpn/status', { cache: 'no-store' }),
        fetch(`/api/network/status${forceNetwork ? '?refresh=true' : ''}`, { cache: 'no-store' }),
      ]);

      if (vpnRes.ok) {
        const json = await vpnRes.json();
        if (json.success) setVpn(json.data);
      }

      if (networkRes.ok) {
        const json = await networkRes.json();
        if (json.success) setNetwork(json.data);
      }
    } catch {
      // Keep the last known network state visible if a refresh fails.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus(false);
    const interval = setInterval(() => void refreshStatus(false), 10_000);
    return () => clearInterval(interval);
  }, [refreshStatus]);

  const status = vpn?.status || network?.vpnStatus || 'off';
  const location = network?.location || network?.country || 'LOCATION UNKNOWN';
  const outboundIp = network?.ip || 'IP UNAVAILABLE';
  const serverLabel = network?.server || (status === 'off' ? 'DIRECT / HOST NETWORK' : vpn?.profileName || 'UNKNOWN');

  return (
    <header
      id="app-topbar"
      className="min-h-16 border-b border-neutral-800 bg-neutral-950 px-4 py-2 font-mono text-neutral-200 select-none sm:px-6"
    >
      <div className="flex min-h-12 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <button
            id="btn-mobile-menu"
            onClick={onToggleMobile}
            className="border border-neutral-800 bg-black p-2 text-neutral-400 hover:text-white md:hidden"
            aria-label="Toggle navigation menu"
          >
            <Menu className="h-4 w-4" />
          </button>

          <div className="hidden items-center gap-2 text-xs sm:flex">
            <span className="text-neutral-500">ENVIRONMENT:</span>
            <span className="border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-[11px] uppercase tracking-wider text-neutral-300">
              DOCKER
            </span>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 items-center justify-end gap-2 overflow-x-auto text-xs">
          <div
            id="topbar-egress-status"
            className="hidden min-w-0 items-center gap-3 border border-neutral-800 bg-black px-3 py-1.5 lg:flex"
            title={`Current outbound IP: ${outboundIp}\nServer: ${serverLabel}\nLocation: ${location}`}
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <Globe2 className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <span className="text-[10px] uppercase text-neutral-500">OUT:</span>
              <span className="truncate text-[11px] font-semibold text-white">{outboundIp}</span>
            </div>
            <div className="h-4 w-px shrink-0 bg-neutral-800" />
            <div className="flex min-w-0 items-center gap-1.5">
              <Server className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <span className="max-w-48 truncate text-[10px] text-neutral-300">{serverLabel}</span>
            </div>
            <div className="h-4 w-px shrink-0 bg-neutral-800" />
            <div className="flex min-w-0 items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-neutral-400" />
              <span className="max-w-48 truncate text-[10px] text-neutral-300">{location}</span>
            </div>
          </div>

          <Link
            href="/vpn"
            id="topbar-vpn-indicator"
            title={`Outbound IP: ${outboundIp} | Server: ${serverLabel} | Location: ${location}`}
            className="flex shrink-0 items-center gap-2 border border-neutral-800 bg-black px-3 py-1.5 transition-colors hover:border-neutral-600"
          >
            {status === 'connected' ? (
              <>
                <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-400" />
                <span className="text-[11px] font-semibold uppercase text-emerald-400">VPN ACTIVE</span>
              </>
            ) : status === 'connecting' ? (
              <>
                <RefreshCw className="h-4 w-4 shrink-0 animate-spin text-amber-400" />
                <span className="text-[11px] font-semibold uppercase text-amber-400">CONNECTING</span>
              </>
            ) : status === 'error' ? (
              <>
                <ShieldAlert className="h-4 w-4 shrink-0 text-rose-400" />
                <span className="text-[11px] font-semibold uppercase text-rose-400">VPN ERROR</span>
              </>
            ) : (
              <>
                <Shield className="h-4 w-4 shrink-0 text-neutral-500" />
                <span className="text-[11px] uppercase text-neutral-400">DIRECT</span>
              </>
            )}
            <span className="hidden max-w-32 truncate text-[10px] text-neutral-500 md:inline">{outboundIp}</span>
          </Link>

          <button
            id="btn-refresh-topbar"
            onClick={() => void refreshStatus(true)}
            disabled={loading}
            title="Refresh current outgoing IP, server, location, and VPN status"
            className="shrink-0 border border-neutral-800 bg-black p-1.5 text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-white disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 overflow-x-auto border-t border-neutral-900 pt-1.5 text-[10px] lg:hidden">
        <span className="flex shrink-0 items-center gap-1 text-neutral-500"><Globe2 className="h-3 w-3" /> OUT</span>
        <span className="shrink-0 font-semibold text-white">{outboundIp}</span>
        <span className="text-neutral-700">|</span>
        <span className="max-w-40 shrink-0 truncate text-neutral-400">{serverLabel}</span>
        <span className="text-neutral-700">|</span>
        <span className="max-w-40 shrink-0 truncate text-neutral-400">{location}</span>
      </div>
    </header>
  );
}
