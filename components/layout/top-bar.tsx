'use client';

import React, { useEffect, useState } from 'react';
import { Shield, ShieldAlert, ShieldCheck, RefreshCw, Menu, Globe, Tv } from 'lucide-react';
import Link from 'next/link';

interface TopBarProps {
  onToggleMobile?: () => void;
}

interface VpnStatusData {
  status: 'off' | 'connecting' | 'connected' | 'error';
  type: 'off' | 'wireguard' | 'openvpn' | 'warp';
  profileName: string | null;
  publicIp: string | null;
  country: string | null;
  lastError: string | null;
  isBusy: boolean;
}

export function TopBar({ onToggleMobile }: TopBarProps) {
  const [vpn, setVpn] = useState<VpnStatusData | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchVpnStatus = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/vpn/status');
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          setVpn(json.data);
        }
      }
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    let isMounted = true;
    const updateStatus = async () => {
      try {
        const res = await fetch('/api/vpn/status');
        if (res.ok && isMounted) {
          const json = await res.json();
          if (json.success) {
            setVpn(json.data);
          }
        }
      } catch {
        // Ignore
      }
    };

    updateStatus();
    const interval = setInterval(updateStatus, 8000);
    return () => {
      isMounted = false;
      clearInterval(interval);
    };
  }, []);

  return (
    <header
      id="app-topbar"
      className="h-16 border-b border-neutral-800 bg-neutral-950 text-neutral-200 px-4 sm:px-6 flex items-center justify-between font-mono select-none"
    >
      <div className="flex items-center gap-3">
        <button
          id="btn-mobile-menu"
          onClick={onToggleMobile}
          className="md:hidden p-2 text-neutral-400 hover:text-white border border-neutral-800 bg-black cursor-pointer"
          aria-label="Toggle navigation menu"
        >
          <Menu className="w-4 h-4" />
        </button>

        <div className="flex items-center gap-2 text-xs">
          <span className="text-neutral-500 hidden sm:inline">ENVIRONMENT:</span>
          <span className="bg-neutral-900 border border-neutral-800 px-2 py-0.5 text-neutral-300 text-[11px] uppercase tracking-wider">
            PRODUCTION (DOCKER)
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3 text-xs">
        {/* VPN Global Status Indicator */}
        <Link
          href="/vpn"
          id="topbar-vpn-indicator"
          className="flex items-center gap-2 px-3 py-1.5 border border-neutral-800 bg-black hover:border-neutral-700 transition-colors"
        >
          {vpn?.status === 'connected' ? (
            <>
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-emerald-400 uppercase text-[11px]">VPN: ACTIVE</span>
                <span className="text-neutral-500 hidden lg:inline">({vpn.type.toUpperCase()})</span>
                {vpn.publicIp && (
                  <span className="text-neutral-400 text-[10px] hidden md:inline ml-1">
                    [{vpn.publicIp}]
                  </span>
                )}
              </div>
            </>
          ) : vpn?.status === 'connecting' ? (
            <>
              <RefreshCw className="w-4 h-4 text-amber-400 animate-spin shrink-0" />
              <span className="font-semibold text-amber-400 uppercase text-[11px]">VPN: CONNECTING...</span>
            </>
          ) : vpn?.status === 'error' ? (
            <>
              <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0" />
              <span className="font-semibold text-rose-400 uppercase text-[11px]">VPN: ERROR</span>
            </>
          ) : (
            <>
              <Shield className="w-4 h-4 text-neutral-500 shrink-0" />
              <span className="text-neutral-400 uppercase text-[11px]">VPN: OFF (DIRECT)</span>
            </>
          )}
        </Link>

        {/* Refresh Status */}
        <button
          id="btn-refresh-topbar"
          onClick={fetchVpnStatus}
          disabled={loading}
          title="Refresh Network Status"
          className="p-1.5 border border-neutral-800 bg-black hover:bg-neutral-900 text-neutral-400 hover:text-white transition-colors cursor-pointer disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>
    </header>
  );
}
