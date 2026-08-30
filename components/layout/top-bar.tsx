'use client';

import * as React from 'react';
import Link from 'next/link';
import { Activity, Globe2, Menu, Moon, RefreshCw, Shield, Sun } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { apiPath, readJson } from '@/lib/client/api';
import { cn } from '@/lib/utils';

interface TopBarProps {
  onToggleMobile?: () => void;
}

interface VpnStatusData {
  status: 'off' | 'connecting' | 'connected' | 'error';
  type: 'off' | 'wireguard' | 'openvpn' | 'warp';
  profileName: string | null;
}

interface NetworkStatusData {
  ip: string | null;
  location: string | null;
  country: string | null;
}

interface SystemStatusData {
  go: {
    running: boolean;
    status: 'running' | 'unhealthy' | 'offline';
    latencyMs: number;
    activeStreams?: number;
    viewers?: number;
  };
}

type Theme = 'dark' | 'light';

type ApiEnvelope<T> = {
  success?: boolean;
  data?: T;
};

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark');
  document.documentElement.dataset.theme = theme;
}

export function TopBar({ onToggleMobile }: TopBarProps) {
  const [vpn, setVpn] = React.useState<VpnStatusData | null>(null);
  const [network, setNetwork] = React.useState<NetworkStatusData | null>(null);
  const [system, setSystem] = React.useState<SystemStatusData | null>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [theme, setTheme] = React.useState<Theme>('dark');

  React.useEffect(() => {
    const stored = window.localStorage.getItem('iptv-proxy-theme');
    const initial: Theme = stored === 'light' || stored === 'dark'
      ? stored
      : window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
    applyTheme(initial);
    setTheme(initial);
  }, []);

  const toggleTheme = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    window.localStorage.setItem('iptv-proxy-theme', next);
    setTheme(next);
  };

  const refreshStatus = React.useCallback(async (forceNetwork = false) => {
    setRefreshing(true);
    try {
      const [vpnResponse, networkResponse, systemResponse] = await Promise.all([
        fetch(apiPath('/api/vpn/status'), { cache: 'no-store' }),
        fetch(apiPath(`/api/network/status${forceNetwork ? '?refresh=true' : ''}`), { cache: 'no-store' }),
        fetch(apiPath('/api/system/status'), { cache: 'no-store' }),
      ]);

      if (vpnResponse.ok) {
        const payload = await readJson<ApiEnvelope<VpnStatusData>>(vpnResponse);
        if (payload.success && payload.data) setVpn(payload.data);
      }
      if (networkResponse.ok) {
        const payload = await readJson<ApiEnvelope<NetworkStatusData>>(networkResponse);
        if (payload.success && payload.data) setNetwork(payload.data);
      }
      if (systemResponse.ok) {
        const payload = await readJson<ApiEnvelope<SystemStatusData>>(systemResponse);
        if (payload.success && payload.data) setSystem(payload.data);
      }
    } finally {
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    void refreshStatus();
    const interval = window.setInterval(() => void refreshStatus(), 10_000);
    return () => window.clearInterval(interval);
  }, [refreshStatus]);

  const goRunning = system?.go.running === true;
  const vpnStatus = vpn?.status || 'off';
  const location = network?.location || network?.country || 'Unknown location';
  const outboundIp = network?.ip || 'IP unavailable';
  const liveViewers = system?.go.viewers || 0;

  return (
    <header id="app-topbar" className="sticky top-0 z-40 border-b bg-background/90 backdrop-blur supports-[backdrop-filter]:bg-background/75">
      <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
        <Button id="btn-mobile-menu" variant="ghost" size="icon" className="md:hidden" onClick={onToggleMobile} aria-label="Open navigation">
          <Menu className="size-4" />
        </Button>

        <div className="hidden min-w-0 items-center gap-2 text-sm text-muted-foreground sm:flex">
          <Globe2 className="size-4" />
          <span className="truncate font-mono text-xs text-foreground">{outboundIp}</span>
          <span className="hidden truncate text-xs lg:inline">· {location}</span>
        </div>

        <div className="ml-auto flex items-center gap-2">
          {liveViewers > 0 && (
            <Badge variant="secondary" className="hidden gap-1.5 sm:inline-flex">
              <Activity className="size-3" />
              {liveViewers} viewer{liveViewers === 1 ? '' : 's'}
            </Badge>
          )}

          <Badge id="topbar-go-status" variant={goRunning ? 'success' : 'destructive'} className="gap-1.5">
            <span className={cn('size-1.5 rounded-full', goRunning ? 'bg-emerald-500' : 'bg-destructive')} />
            Go {goRunning ? 'online' : 'offline'}
          </Badge>

          <Link
            id="topbar-vpn-indicator"
            href="/vpn"
            className={buttonVariants({ variant: 'outline', size: 'sm', className: 'gap-2' })}
          >
            <Shield className="size-4" />
            <span className="hidden sm:inline">
              {vpnStatus === 'connected'
                ? vpn?.profileName || vpn.type
                : vpnStatus === 'connecting'
                  ? 'Connecting'
                  : vpnStatus === 'error'
                    ? 'VPN error'
                    : 'Direct'}
            </span>
          </Link>

          <Button id="btn-theme-toggle" variant="ghost" size="icon" onClick={toggleTheme} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>
            {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>

          <Button id="btn-refresh-topbar" variant="ghost" size="icon" onClick={() => void refreshStatus(true)} disabled={refreshing} aria-label="Refresh runtime status">
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
        </div>
      </div>
    </header>
  );
}
