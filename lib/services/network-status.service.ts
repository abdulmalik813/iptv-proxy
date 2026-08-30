import { SettingsService } from './settings.service';

export interface OutboundNetworkStatus {
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

interface ProbeResult {
  ip: string;
  country?: string;
  region?: string;
  city?: string;
}

declare global {
  var __iptvOutboundNetworkCache:
    | { value: OutboundNetworkStatus; expiresAt: number }
    | undefined;
}

const CACHE_TTL_MS = 8_000;

async function probeIpInfo(timeoutMs: number): Promise<ProbeResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://ipinfo.io/json', {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'IPTV-Proxy-Network-Status/1.0' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      ip?: string;
      country?: string;
      region?: string;
      city?: string;
    };
    if (!data.ip) return null;
    return {
      ip: data.ip,
      country: data.country,
      region: data.region,
      city: data.city,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCloudflare(timeoutMs: number): Promise<ProbeResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://www.cloudflare.com/cdn-cgi/trace', {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'IPTV-Proxy-Network-Status/1.0' },
    });
    if (!response.ok) return null;
    const text = await response.text();
    const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim();
    if (!ip) return null;
    return {
      ip,
      country: text.match(/^loc=(.+)$/m)?.[1]?.trim(),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeIpify(timeoutMs: number): Promise<ProbeResult | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.ipify.org?format=json', {
      signal: controller.signal,
      cache: 'no-store',
      headers: { 'User-Agent': 'IPTV-Proxy-Network-Status/1.0' },
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { ip?: string };
    return data.ip ? { ip: data.ip } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function probeCurrentEgress(): Promise<ProbeResult | null> {
  return (
    (await probeIpInfo(4_000)) ||
    (await probeCloudflare(4_000)) ||
    (await probeIpify(4_000))
  );
}

function buildLocation(probe: ProbeResult | null): string | null {
  if (!probe) return null;
  const parts = [probe.city, probe.region, probe.country].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

export class NetworkStatusService {
  static invalidateCache(): void {
    global.__iptvOutboundNetworkCache = undefined;
  }

  static async getCurrent(forceRefresh = false): Promise<OutboundNetworkStatus> {
    const cached = global.__iptvOutboundNetworkCache;
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const settings = await SettingsService.getSettings();
    const probe = await probeCurrentEgress();
    const server =
      settings.vpn_status === 'connected' || settings.vpn_status === 'connecting'
        ? settings.active_vpn_label || settings.active_vpn_type.toUpperCase()
        : settings.vpn_status === 'error' && settings.active_vpn_label
          ? `${settings.active_vpn_label} (ERROR)`
          : 'DIRECT / HOST NETWORK';

    const value: OutboundNetworkStatus = {
      ip: probe?.ip || settings.vpn_public_ip || null,
      country: probe?.country || settings.vpn_country || null,
      region: probe?.region || null,
      city: probe?.city || null,
      location: buildLocation(probe) || settings.vpn_country || null,
      server,
      vpnStatus: settings.vpn_status,
      vpnType: settings.active_vpn_type,
      checkedAt: new Date().toISOString(),
    };

    global.__iptvOutboundNetworkCache = {
      value,
      expiresAt: Date.now() + CACHE_TTL_MS,
    };

    return value;
  }
}
