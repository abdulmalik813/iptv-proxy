import { SettingsService } from '../settings.service';
import { LogService } from '../log.service';
import { AppSettings, OpenvpnProfile, VpnStatus, VpnType } from '../../db/schema';
import { WireguardService } from './wireguard';
import { OpenvpnService } from './openvpn';
import { WarpService } from './warp';
import { VpnGateService } from './vpngate';
import { RoutingService } from './routing';

interface VpnPublicIpInfo {
  ip: string;
  country?: string;
  loc?: string;
}

type RuntimeTunnel = Exclude<VpnType, 'off'>;

class Mutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queue.push(() => {
        this.locked = true;
        resolve(() => this.release());
      });
    });
  }

  get isBusy(): boolean {
    return this.locked;
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) next();
    else this.locked = false;
  }
}

class VpnConflictError extends Error {}

const vpnLock = new Mutex();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let lastReconcileWarning = '';
let lastReconcileWarningAt = 0;

export class VpnManager {
  static isOperationInProgress(): boolean {
    return vpnLock.isBusy;
  }

  static async verifyConnectivity(timeoutMs = 6_000): Promise<VpnPublicIpInfo | null> {
    const endpoints = [
      { url: 'https://ipinfo.io/json', kind: 'json' as const },
      { url: 'https://api.ipify.org?format=json', kind: 'json' as const },
      { url: 'https://www.cloudflare.com/cdn-cgi/trace', kind: 'trace' as const },
    ];

    for (const endpoint of endpoints) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint.url, {
          signal: controller.signal,
          cache: 'no-store',
          headers: { 'User-Agent': 'IPTV-Proxy-VPN-Probe/1.0' },
        });
        if (!response.ok) continue;

        if (endpoint.kind === 'json') {
          const data = (await response.json()) as { ip?: string; country?: string; city?: string };
          if (!data.ip) continue;
          return {
            ip: data.ip,
            country: data.country,
            loc: data.city && data.country ? `${data.city}, ${data.country}` : undefined,
          };
        }

        const text = await response.text();
        const ip = text.match(/^ip=(.+)$/m)?.[1]?.trim();
        if (ip) return { ip, country: text.match(/^loc=(.+)$/m)?.[1]?.trim() };
      } catch {
        // Try the next independent endpoint.
      } finally {
        clearTimeout(timeout);
      }
    }
    return null;
  }

  private static async getRuntimeTunnels(): Promise<RuntimeTunnel[]> {
    const [wireguard, openvpn, warp] = await Promise.all([
      WireguardService.isConnectionActive().catch(() => false),
      OpenvpnService.isConnectionActive().catch(() => false),
      WarpService.getStatus().then((status) => status.connected).catch(() => false),
    ]);
    const active: RuntimeTunnel[] = [];
    if (wireguard) active.push('wireguard');
    if (openvpn) active.push('openvpn');
    if (warp) active.push('warp');
    return active;
  }

  private static async stopAllTunnels(): Promise<void> {
    await WireguardService.stopConnection();
    await OpenvpnService.stopConnection();
    await WarpService.disconnect();
    await sleep(400);
  }

  private static async prepareForConnection(): Promise<VpnPublicIpInfo | null> {
    // This is only called after assertCanStartConnection has verified that no
    // real tunnel is active. Cleanup here is therefore stale-process cleanup,
    // never an implicit VPN switch.
    await this.stopAllTunnels();
    await RoutingService.cleanupBypassRouting();
    const baseline = await this.verifyConnectivity(5_000);
    await RoutingService.prepareBypassRouting();
    return baseline;
  }

  private static async markError(type: VpnType, profileId: string | null, label: string | null, message: string): Promise<void> {
    await SettingsService.updateVpnState({
      active_vpn_type: type,
      active_vpn_profile_id: profileId,
      active_vpn_label: label,
      vpn_status: 'error',
      vpn_last_error: message,
      vpn_connected_at: null,
      vpn_public_ip: null,
      vpn_country: null,
    });
  }

  private static async warnReconcileOnce(message: string, metadata?: Record<string, unknown>): Promise<void> {
    const key = `${message}:${JSON.stringify(metadata || {})}`;
    const now = Date.now();
    if (key === lastReconcileWarning && now - lastReconcileWarningAt < 10_000) return;
    lastReconcileWarning = key;
    lastReconcileWarningAt = now;
    await LogService.warn('vpn', 'reconcile', message, metadata);
  }

  private static async reconcileRuntimeState(settings?: AppSettings): Promise<AppSettings> {
    let current = settings || (await SettingsService.getSettings());
    const runtime = await this.getRuntimeTunnels();

    if (runtime.length > 1) {
      const message = `Multiple VPN tunnels are active at runtime (${runtime.join(', ')}). Manual disconnect is required.`;
      await SettingsService.updateVpnState({
        vpn_status: 'error',
        vpn_last_error: message,
        vpn_connected_at: null,
        vpn_public_ip: null,
        vpn_country: null,
      });
      await this.warnReconcileOnce(message, { runtime });
      return SettingsService.getSettings();
    }

    if (runtime.length === 0) {
      if (current.vpn_status === 'connected') {
        const message = 'Stored VPN state was connected, but the tunnel process/interface is no longer active.';
        await SettingsService.updateVpnState({
          vpn_status: 'error',
          vpn_last_error: message,
          vpn_connected_at: null,
          vpn_public_ip: null,
          vpn_country: null,
        });
        await this.warnReconcileOnce(message, { type: current.active_vpn_type });
        current = await SettingsService.getSettings();
      }
      return current;
    }

    const actual = runtime[0];
    if (current.vpn_status !== 'connected' || current.active_vpn_type !== actual) {
      const ipInfo = await this.verifyConnectivity(4_000);
      const message = `Detected an active ${actual} tunnel that did not match stored VPN state; state was reconciled.`;
      await SettingsService.updateVpnState({
        active_vpn_type: actual,
        active_vpn_profile_id: current.active_vpn_type === actual ? current.active_vpn_profile_id : null,
        active_vpn_label: current.active_vpn_type === actual ? current.active_vpn_label : actual === 'warp' ? 'Cloudflare WARP' : `Recovered ${actual}`,
        vpn_status: 'connected',
        vpn_last_error: null,
        vpn_connected_at: current.vpn_connected_at || new Date().toISOString(),
        vpn_public_ip: ipInfo?.ip || current.vpn_public_ip,
        vpn_country: ipInfo?.country || current.vpn_country,
      });
      await this.warnReconcileOnce(message, { actual, stored: current.active_vpn_type, storedStatus: current.vpn_status });
      current = await SettingsService.getSettings();
    }

    return current;
  }

  private static async assertCanStartConnection(): Promise<void> {
    const current = await this.reconcileRuntimeState();
    const runtime = await this.getRuntimeTunnels();

    if (current.vpn_status === 'connecting') {
      throw new VpnConflictError('A VPN connection is already being established. Wait for it to finish or disconnect it first.');
    }
    if (runtime.length > 0 || current.vpn_status === 'connected') {
      const label = current.active_vpn_label || current.active_vpn_type || runtime[0];
      throw new VpnConflictError(`${label} is already connected. Disconnect the current VPN before connecting another one.`);
    }
  }

  static async assertWarpMaintenanceAllowed(action: 'register' | 'reset'): Promise<void> {
    if (vpnLock.isBusy) throw new VpnConflictError('Another VPN operation is already in progress.');
    const current = await this.reconcileRuntimeState();
    const runtime = await this.getRuntimeTunnels();
    if (current.vpn_status === 'connecting' || runtime.length > 0 || current.vpn_status === 'connected') {
      const label = current.active_vpn_label || current.active_vpn_type || runtime[0];
      throw new VpnConflictError(`Cannot ${action} Cloudflare WARP while ${label} is active. Disconnect the current VPN first.`);
    }
  }

  static async disconnect(reason = 'User requested disconnect'): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();
    try {
      const current = await SettingsService.getSettings();
      if (current.vpn_status !== 'off' || current.active_vpn_type !== 'off') {
        await LogService.info('vpn', 'disconnect', `Disconnecting ${current.active_vpn_label || current.active_vpn_type}.`, { reason });
      }

      await this.stopAllTunnels();
      await RoutingService.cleanupBypassRouting();
      await SettingsService.updateVpnState({
        active_vpn_type: 'off',
        active_vpn_profile_id: null,
        active_vpn_label: null,
        vpn_status: 'off',
        vpn_last_error: null,
        vpn_connected_at: null,
        vpn_public_ip: null,
        vpn_country: null,
      });
      await LogService.info('vpn', 'disconnected', 'VPN disconnected. Traffic is using the direct container route.');
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await LogService.error('vpn', 'disconnect', `VPN disconnect failed: ${message}`);
      return { success: false, error: message };
    } finally {
      release();
    }
  }

  static async connectWireguard(profileId: string): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();
    let label = 'WireGuard';
    try {
      const profile = await WireguardService.getProfileById(profileId);
      if (!profile) throw new Error('WireGuard profile not found.');
      if (!profile.enabled) throw new Error('WireGuard profile is disabled.');
      label = profile.name;

      await this.assertCanStartConnection();
      await LogService.info('wireguard', 'connecting', `Connecting WireGuard profile "${profile.name}".`);
      const baseline = await this.prepareForConnection();
      await SettingsService.updateVpnState({
        active_vpn_type: 'wireguard', active_vpn_profile_id: profileId, active_vpn_label: profile.name,
        vpn_status: 'connecting', vpn_last_error: null, vpn_connected_at: null, vpn_public_ip: null, vpn_country: null,
      });

      const started = await WireguardService.startConnection(profile);
      if (!started.success) throw new Error(started.error || 'WireGuard failed to start.');

      let ipInfo: VpnPublicIpInfo | null = null;
      let handshake = false;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        ipInfo = await this.verifyConnectivity(4_000);
        handshake = await WireguardService.hasRecentHandshake();
        if (ipInfo && (handshake || !baseline || ipInfo.ip !== baseline.ip)) break;
        await sleep(700);
      }

      if (!(await WireguardService.isConnectionActive())) throw new Error('WireGuard interface disappeared after startup.');
      if (!ipInfo) throw new Error('WireGuard is up but external connectivity could not be verified.');
      if (!handshake && baseline && ipInfo.ip === baseline.ip) throw new Error('WireGuard is up, but no peer handshake or VPN egress change was verified.');

      await SettingsService.updateVpnState({ vpn_status: 'connected', vpn_connected_at: new Date().toISOString(), vpn_public_ip: ipInfo.ip, vpn_country: ipInfo.country || null, vpn_last_error: null });
      await LogService.info('wireguard', 'connected', `WireGuard connected to "${profile.name}".`, { profile_id: profileId, public_ip: ipInfo.ip, country: ipInfo.country, handshake_verified: handshake });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof VpnConflictError) {
        await LogService.warn('wireguard', 'connection_blocked', message, { profile_id: profileId });
        return { success: false, error: message };
      }
      await WireguardService.stopConnection();
      await RoutingService.cleanupBypassRouting();
      await this.markError('wireguard', profileId, label, message);
      await LogService.error('wireguard', 'connection_failure', `WireGuard connection failed: ${message}`, { profile_id: profileId });
      return { success: false, error: message };
    } finally { release(); }
  }

  static async connectOpenvpn(profileId: string): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();
    let label = 'OpenVPN';
    try {
      const profile = await OpenvpnService.getProfileById(profileId, true);
      if (!profile) throw new Error('OpenVPN profile not found.');
      if (!profile.enabled) throw new Error('OpenVPN profile is disabled.');
      label = profile.name;

      await this.assertCanStartConnection();
      await LogService.info('openvpn', 'connecting', `Connecting OpenVPN profile "${profile.name}".`);
      await this.prepareForConnection();
      await SettingsService.updateVpnState({
        active_vpn_type: 'openvpn', active_vpn_profile_id: profileId, active_vpn_label: profile.name,
        vpn_status: 'connecting', vpn_last_error: null, vpn_connected_at: null, vpn_public_ip: null, vpn_country: null,
      });

      const started = await OpenvpnService.startConnection(profile);
      if (!started.success) throw new Error(started.error || 'OpenVPN failed to start.');
      if (!(await OpenvpnService.isConnectionActive())) throw new Error('OpenVPN process did not remain connected.');
      const ipInfo = await this.verifyConnectivity(8_000);
      if (!ipInfo) throw new Error('OpenVPN connected but external connectivity could not be verified.');

      await SettingsService.updateVpnState({ vpn_status: 'connected', vpn_connected_at: new Date().toISOString(), vpn_public_ip: ipInfo.ip, vpn_country: ipInfo.country || null, vpn_last_error: null });
      await LogService.info('openvpn', 'connected', `OpenVPN connected to "${profile.name}".`, { profile_id: profileId, public_ip: ipInfo.ip, country: ipInfo.country });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof VpnConflictError) {
        await LogService.warn('openvpn', 'connection_blocked', message, { profile_id: profileId });
        return { success: false, error: message };
      }
      await OpenvpnService.stopConnection();
      await RoutingService.cleanupBypassRouting();
      await this.markError('openvpn', profileId, label, message);
      await LogService.error('openvpn', 'connection_failure', `OpenVPN connection failed: ${message}`, { profile_id: profileId });
      return { success: false, error: message };
    } finally { release(); }
  }

  static async connectVpnGateServer(serverId: string): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();
    let label = 'VPNGate';
    const runtimeId = `vpngate:${serverId}`;
    try {
      const server = await VpnGateService.getServerById(serverId);
      if (!server) throw new Error('VPNGate server is no longer available. Refresh the server list.');
      label = `VPNGate ${server.countryShort} ${server.ip}`;
      const now = new Date().toISOString();
      const profile: OpenvpnProfile = {
        id: runtimeId, name: label, config: VpnGateService.decodeConfig(server.ovpnConfigBase64),
        username: 'vpn', password: 'vpn', source: 'vpngate', enabled: 1, created_at: now, updated_at: now,
      };

      await this.assertCanStartConnection();
      await LogService.info('vpngate', 'connecting', `Connecting directly to ${label}.`, { server_id: serverId });
      await this.prepareForConnection();
      await SettingsService.updateVpnState({
        active_vpn_type: 'openvpn', active_vpn_profile_id: runtimeId, active_vpn_label: label,
        vpn_status: 'connecting', vpn_last_error: null, vpn_connected_at: null, vpn_public_ip: null, vpn_country: null,
      });

      const started = await OpenvpnService.startConnection(profile);
      if (!started.success) throw new Error(started.error || 'VPNGate OpenVPN connection failed to start.');
      if (!(await OpenvpnService.isConnectionActive())) throw new Error('VPNGate OpenVPN process did not remain connected.');
      const ipInfo = await this.verifyConnectivity(8_000);
      if (!ipInfo) throw new Error('VPNGate connected but external connectivity could not be verified.');

      await SettingsService.updateVpnState({ vpn_status: 'connected', vpn_connected_at: new Date().toISOString(), vpn_public_ip: ipInfo.ip, vpn_country: ipInfo.country || server.countryShort, vpn_last_error: null });
      await LogService.info('vpngate', 'connected', `Connected to ${label}.`, { server_id: serverId, public_ip: ipInfo.ip });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof VpnConflictError) {
        await LogService.warn('vpngate', 'connection_blocked', message, { server_id: serverId });
        return { success: false, error: message };
      }
      await OpenvpnService.stopConnection();
      await RoutingService.cleanupBypassRouting();
      await this.markError('openvpn', runtimeId, label, message);
      await LogService.error('vpngate', 'connection_failure', `VPNGate connection failed: ${message}`, { server_id: serverId });
      return { success: false, error: message };
    } finally { release(); }
  }

  static async connectWarp(): Promise<{ success: boolean; error?: string }> {
    const release = await vpnLock.acquire();
    const label = 'Cloudflare WARP';
    try {
      await this.assertCanStartConnection();
      await LogService.info('warp', 'connecting', 'Connecting Cloudflare WARP.');
      await this.prepareForConnection();
      await SettingsService.updateVpnState({
        active_vpn_type: 'warp', active_vpn_profile_id: null, active_vpn_label: label,
        vpn_status: 'connecting', vpn_last_error: null, vpn_connected_at: null, vpn_public_ip: null, vpn_country: null,
      });

      const started = await WarpService.connect();
      if (!started.success) throw new Error(started.error || 'Cloudflare WARP failed to connect.');
      const warpStatus = await WarpService.getStatus();
      if (!warpStatus.connected) throw new Error('warp-cli did not report Connected state.');
      const ipInfo = await this.verifyConnectivity(8_000);
      if (!ipInfo) throw new Error('WARP connected but external connectivity could not be verified.');

      await SettingsService.updateVpnState({ vpn_status: 'connected', vpn_connected_at: new Date().toISOString(), vpn_public_ip: ipInfo.ip, vpn_country: ipInfo.country || null, vpn_last_error: null });
      await LogService.info('warp', 'connected', 'Cloudflare WARP connected.', { public_ip: ipInfo.ip, country: ipInfo.country });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof VpnConflictError) {
        await LogService.warn('warp', 'connection_blocked', message);
        return { success: false, error: message };
      }
      await WarpService.disconnect();
      await RoutingService.cleanupBypassRouting();
      await this.markError('warp', null, label, message);
      await LogService.error('warp', 'connection_failure', `Cloudflare WARP connection failed: ${message}`);
      return { success: false, error: message };
    } finally { release(); }
  }

  static async getVpnStatusSummary(): Promise<{
    status: VpnStatus;
    type: VpnType;
    profileId: string | null;
    profileName: string | null;
    connectedSince: string | null;
    publicIp: string | null;
    country: string | null;
    lastError: string | null;
    isBusy: boolean;
  }> {
    const settings = await this.reconcileRuntimeState();

    let profileName = settings.active_vpn_label;
    if (!profileName && settings.active_vpn_type === 'wireguard' && settings.active_vpn_profile_id) {
      profileName = (await WireguardService.getProfileById(settings.active_vpn_profile_id))?.name || null;
    } else if (!profileName && settings.active_vpn_type === 'openvpn' && settings.active_vpn_profile_id && !settings.active_vpn_profile_id.startsWith('vpngate:')) {
      profileName = (await OpenvpnService.getProfileById(settings.active_vpn_profile_id))?.name || null;
    } else if (!profileName && settings.active_vpn_type === 'warp') {
      profileName = 'Cloudflare WARP';
    }

    return {
      status: settings.vpn_status,
      type: settings.active_vpn_type,
      profileId: settings.active_vpn_profile_id,
      profileName,
      connectedSince: settings.vpn_connected_at,
      publicIp: settings.vpn_public_ip,
      country: settings.vpn_country,
      lastError: settings.vpn_last_error,
      isBusy: vpnLock.isBusy,
    };
  }
}
