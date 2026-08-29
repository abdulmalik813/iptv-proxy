import { VpnGateServer } from '../../db/schema';
import { LogService } from '../log.service';

const VPNGATE_API_URLS = [
  'http://www.vpngate.net/api/iphone/',
  'https://www.vpngate.net/api/iphone/',
];

let cachedServers: VpnGateServer[] = [];
let lastFetchTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes cache

export class VpnGateService {
  /**
   * Fetches the public VPNGate CSV mirror and parses server details
   */
  static async fetchServers(forceRefresh = false): Promise<VpnGateServer[]> {
    const now = Date.now();
    if (!forceRefresh && cachedServers.length > 0 && now - lastFetchTimestamp < CACHE_TTL_MS) {
      return cachedServers;
    }

    let rawCsv = '';
    let lastError: Error | null = null;

    for (const url of VPNGATE_API_URLS) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 12000); // 12s timeout

        const response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'IPTV-Proxy-Manager/1.0',
          },
        });
        clearTimeout(timeoutId);

        if (response.ok) {
          rawCsv = await response.text();
          if (rawCsv && rawCsv.includes('OpenVPN_ConfigData_Base64')) {
            break;
          }
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!rawCsv) {
      await LogService.error(
        'vpngate',
        'fetch',
        `Failed to fetch VPNGate server list: ${lastError?.message || 'Upstream mirrors unreachable'}`
      );
      if (cachedServers.length > 0) {
        return cachedServers; // Return stale cache if available
      }
      throw new Error(`Unable to fetch VPNGate server list: ${lastError?.message || 'Service unavailable'}`);
    }

    try {
      const servers = this.parseCsv(rawCsv);
      cachedServers = servers;
      lastFetchTimestamp = now;

      await LogService.info('vpngate', 'refresh', `Fetched and parsed ${servers.length} VPNGate servers.`);
      return servers;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await LogService.error('vpngate', 'parse', `VPNGate CSV parse error: ${msg}`);
      throw new Error(`Failed to parse VPNGate server response: ${msg}`);
    }
  }

  /**
   * Parses the CSV returned by VPNGate
   */
  private static parseCsv(csvText: string): VpnGateServer[] {
    const lines = csvText.split('\n');
    const servers: VpnGateServer[] = [];

    // Find the header line starting with #HostName or HostName
    let headerIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('#HostName') || line.startsWith('HostName') || line.includes('OpenVPN_ConfigData_Base64')) {
        headerIndex = i;
        break;
      }
    }

    if (headerIndex === -1) {
      throw new Error('Malformed VPNGate CSV header');
    }

    const headers = lines[headerIndex]
      .replace(/^#/, '')
      .split(',')
      .map((h) => h.trim());

    const hostIdx = headers.indexOf('HostName');
    const ipIdx = headers.indexOf('IP');
    const scoreIdx = headers.indexOf('Score');
    const pingIdx = headers.indexOf('Ping');
    const speedIdx = headers.indexOf('Speed');
    const countryLongIdx = headers.indexOf('CountryLong');
    const countryShortIdx = headers.indexOf('CountryShort');
    const sessionsIdx = headers.indexOf('NumVpnSessions');
    const uptimeIdx = headers.indexOf('Uptime');
    const configIdx = headers.indexOf('OpenVPN_ConfigData_Base64');

    for (let i = headerIndex + 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line || line.startsWith('*') || line.startsWith('#')) continue;

      const cols = line.split(',');
      if (cols.length < headers.length) continue;

      const ip = cols[ipIdx]?.trim();
      const ovpnBase64 = cols[configIdx]?.trim();

      if (!ip || !ovpnBase64) continue;

      servers.push({
        hostname: cols[hostIdx]?.trim() || ip,
        ip,
        score: parseInt(cols[scoreIdx] || '0', 10) || 0,
        ping: parseInt(cols[pingIdx] || '0', 10) || 0,
        speed: parseInt(cols[speedIdx] || '0', 10) || 0, // bps
        countryLong: cols[countryLongIdx]?.trim() || 'Unknown',
        countryShort: cols[countryShortIdx]?.trim().toUpperCase() || 'UN',
        sessions: parseInt(cols[sessionsIdx] || '0', 10) || 0,
        uptime: parseInt(cols[uptimeIdx] || '0', 10) || 0,
        ovpnConfigBase64: ovpnBase64,
      });
    }

    return servers;
  }

  /**
   * Decodes the base64 OpenVPN configuration for a given server
   */
  static decodeConfig(base64Config: string): string {
    try {
      const buffer = Buffer.from(base64Config, 'base64');
      return buffer.toString('utf-8');
    } catch {
      throw new Error('Failed to decode base64 OpenVPN configuration');
    }
  }
}
