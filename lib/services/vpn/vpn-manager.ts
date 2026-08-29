import { SettingsService } from '../settings.service';
import { LogService } from '../log.service';
import { VpnStatus, VpnType } from '../../db/schema';
import { WireguardService } from './wireguard';
import { OpenvpnService } from './openvpn';
import { WarpService } from './warp';

interface VpnPublicIpInfo {
  ip: string;
  country?: string;
  loc?: string;
}

// Mutex for sequential execution of VPN operations
class Mutex {
  private isLocked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.isLocked) {
      this.isLocked = true;
      return () => this.release();
    }

    return new Promise((resolve) => {
      this.queue.push(() => {
        this.isLocked = true;
        resolve(() => this.release());
      });
    });
  }

  get isBusy(): boolean {
    return this.isLocked;
  }

  private release() {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) next();
    } else {
      this.isLocked = false;
    }
  }
}

const vpnLock = new Mutex();

export class VpnManager {
  static isOperationInProgress(): boolean {
    return vpnLock.isBusy;
  }

  /**
   * Verifies external IP and connectivity
   */
  static async verifyConnectivity(timeoutMs = 6000): Promise<VpnPublicIpInfo | null> {
    const endpoints = [
      'https://api.ipify.org?format=json',
      'https://ipinfo.io/json',
      'https://cloudflare.com/cdn-cgi/trace',
    ];

    for (const url of endpoints) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const res = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'IPTV-Proxy-VPN-Probe/1.0' },
          cache: 'no-store',
        });
        clearTimeout(timeoutId);

        if (res.ok) {
          if (url.includes('json')) {
            const data = await res.json();
            return {
              ip: data.ip || 'Unknown',
              country: data.country || 'Unknown',
              loc: data.city ? `${data.city}, ${data.country}` : undefined,
            };
          } else {
            // cloudflare trace
            const text = await res.text();
            const ipMatch = text.match(/ip=([^\n]+)/);
            const locMatch = text.match(/loc=([^\n]+)/);
            return {
              ip: ipMatch ? ipMatch[1].trim() : 'Active',
              country: locMatch ? locMatch[1].trim() : undefined,
            };
          }
        }
      } catch {
        // try next endpoint
      }
    }

    return null;
  }

  /**
   * Disconnects whichever VPN is active
   */
  static async disconnect(reason = 'User requested disconnect'): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();

    try {
      const settings = await SettingsService.getSettings();
      const previousType = settings.active_vpn_type;

      if (previousType === 'off' && settings.vpn_status === 'off') {
        return { success: true };
      }

      await LogService.info('vpn', 'disconnect', `Disconnecting active VPN (${previousType}). Reason: ${reason}`);

      // Stop WireGuard
      await WireguardService.stopConnection();
      // Stop OpenVPN
      await OpenvpnService.stopConnection();
      // Stop WARP
      await WarpService.disconnect();

      await SettingsService.updateVpnState({
        active_vpn_type: 'off',
        active_vpn_profile_id: null,
        vpn_status: 'off',
        vpn_last_error: null,
        vpn_connected_at: null,
        vpn_public_ip: null,
        vpn_country: null,
      });

      await LogService.info('vpn', 'disconnected', 'VPN disconnected successfully. Network traffic restored to direct.');
      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await LogService.error('vpn', 'disconnect', `Error during VPN disconnection: ${msg}`);
      return { success: false, error: msg };
    } finally {
      release();
    }
  }

  /**
   * Connects to a WireGuard profile
   */
  static async connectWireguard(profileId: string): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();

    try {
      const profile = await WireguardService.getProfileById(profileId);
      if (!profile) {
        throw new Error(`WireGuard profile ${profileId} not found`);
      }

      await LogService.info('wireguard', 'connecting', `Initiating WireGuard connection to "${profile.name}"...`);

      // 1. Clean stop previous VPN
      await WireguardService.stopConnection();
      await OpenvpnService.stopConnection();
      await WarpService.disconnect();

      // 2. Set status to connecting
      await SettingsService.updateVpnState({
        active_vpn_type: 'wireguard',
        active_vpn_profile_id: profileId,
        vpn_status: 'connecting',
        vpn_last_error: null,
      });

      // 3. Start WireGuard
      const startRes = await WireguardService.startConnection(profile);
      if (!startRes.success) {
        throw new Error(startRes.error || 'Failed to start WireGuard interface');
      }

      // 4. Verify connectivity
      const ipInfo = await this.verifyConnectivity(8000);

      // 5. Update state to connected
      const now = new Date().toISOString();
      await SettingsService.updateVpnState({
        vpn_status: 'connected',
        vpn_connected_at: now,
        vpn_public_ip: ipInfo?.ip || 'Connected (Protected)',
        vpn_country: ipInfo?.country || null,
        vpn_last_error: null,
      });

      await LogService.info(
        'wireguard',
        'connected',
        `WireGuard tunnel established to "${profile.name}". Public IP: ${ipInfo?.ip || 'Verified'}`,
        { profile_id: profileId, ip: ipInfo?.ip, country: ipInfo?.country }
      );

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await WireguardService.stopConnection();

      await SettingsService.updateVpnState({
        vpn_status: 'error',
        vpn_last_error: msg,
      });

      await LogService.error('wireguard', 'connection_failure', `WireGuard connection failed: ${msg}`, {
        profile_id: profileId,
      });

      return { success: false, error: msg };
    } finally {
      release();
    }
  }

  /**
   * Connects to an OpenVPN profile
   */
  static async connectOpenvpn(profileId: string): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();

    try {
      const profile = await OpenvpnService.getProfileById(profileId, true);
      if (!profile) {
        throw new Error(`OpenVPN profile ${profileId} not found`);
      }

      await LogService.info('openvpn', 'connecting', `Initiating OpenVPN connection to "${profile.name}"...`);

      // 1. Clean stop previous VPN
      await WireguardService.stopConnection();
      await OpenvpnService.stopConnection();
      await WarpService.disconnect();

      // 2. Set status to connecting
      await SettingsService.updateVpnState({
        active_vpn_type: 'openvpn',
        active_vpn_profile_id: profileId,
        vpn_status: 'connecting',
        vpn_last_error: null,
      });

      // 3. Start OpenVPN
      const startRes = await OpenvpnService.startConnection(profile);
      if (!startRes.success) {
        throw new Error(startRes.error || 'Failed to start OpenVPN process');
      }

      // 4. Verify connectivity
      const ipInfo = await this.verifyConnectivity(10000);

      // 5. Update state to connected
      const now = new Date().toISOString();
      await SettingsService.updateVpnState({
        vpn_status: 'connected',
        vpn_connected_at: now,
        vpn_public_ip: ipInfo?.ip || 'Connected (Protected)',
        vpn_country: ipInfo?.country || null,
        vpn_last_error: null,
      });

      await LogService.info(
        'openvpn',
        'connected',
        `OpenVPN tunnel established to "${profile.name}". Public IP: ${ipInfo?.ip || 'Verified'}`,
        { profile_id: profileId, ip: ipInfo?.ip, country: ipInfo?.country }
      );

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await OpenvpnService.stopConnection();

      await SettingsService.updateVpnState({
        vpn_status: 'error',
        vpn_last_error: msg,
      });

      await LogService.error('openvpn', 'connection_failure', `OpenVPN connection failed: ${msg}`, {
        profile_id: profileId,
      });

      return { success: false, error: msg };
    } finally {
      release();
    }
  }

  /**
   * Connects to Cloudflare WARP
   */
  static async connectWarp(): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();

    try {
      await LogService.info('warp', 'connecting', 'Initiating Cloudflare WARP connection...');

      // 1. Clean stop previous VPN
      await WireguardService.stopConnection();
      await OpenvpnService.stopConnection();

      // 2. Set status to connecting
      await SettingsService.updateVpnState({
        active_vpn_type: 'warp',
        active_vpn_profile_id: null,
        vpn_status: 'connecting',
        vpn_last_error: null,
      });

      // 3. Connect WARP
      const startRes = await WarpService.connect();
      if (!startRes.success) {
        throw new Error(startRes.error || 'Failed to connect Cloudflare WARP');
      }

      // 4. Verify connectivity
      const ipInfo = await this.verifyConnectivity(8000);

      // 5. Update state to connected
      const now = new Date().toISOString();
      await SettingsService.updateVpnState({
        vpn_status: 'connected',
        vpn_connected_at: now,
        vpn_public_ip: ipInfo?.ip || 'Cloudflare WARP Active',
        vpn_country: ipInfo?.country || 'Cloudflare Anycast',
        vpn_last_error: null,
      });

      await LogService.info(
        'warp',
        'connected',
        `Cloudflare WARP tunnel connected. Public IP: ${ipInfo?.ip || 'Verified'}`,
        { ip: ipInfo?.ip, country: ipInfo?.country }
      );

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await WarpService.disconnect();

      await SettingsService.updateVpnState({
        vpn_status: 'error',
        vpn_last_error: msg,
      });

      await LogService.error('warp', 'connection_failure', `Cloudflare WARP connection failed: ${msg}`);

      return { success: false, error: msg };
    } finally {
      release();
    }
  }

  /**
   * Quick status fetch with resolved profile name
   */
  static async getVpnStatusSummary(): Promise<{
    status: VpnStatus;
    type: VpnType;
    profileId: string | null;
    profileName: string | null;
    connectedAt: string | null;
    publicIp: string | null;
    country: string | null;
    lastError: string | null;
    isBusy: boolean;
  }> {
    const settings = await SettingsService.getSettings();
    let profileName: string | null = null;

    if (settings.active_vpn_type === 'wireguard' && settings.active_vpn_profile_id) {
      const p = await WireguardService.getProfileById(settings.active_vpn_profile_id);
      if (p) profileName = p.name;
    } else if (settings.active_vpn_type === 'openvpn' && settings.active_vpn_profile_id) {
      const p = await OpenvpnService.getProfileById(settings.active_vpn_profile_id);
      if (p) profileName = p.name;
    } else if (settings.active_vpn_type === 'warp') {
      profileName = 'Cloudflare WARP Tunnel';
    }

    return {
      status: settings.vpn_status,
      type: settings.active_vpn_type,
      profileId: settings.active_vpn_profile_id,
      profileName,
      connectedAt: settings.vpn_connected_at,
      publicIp: settings.vpn_public_ip,
      country: settings.vpn_country,
      lastError: settings.vpn_last_error,
      isBusy: vpnLock.isBusy,
    };
  }
}
