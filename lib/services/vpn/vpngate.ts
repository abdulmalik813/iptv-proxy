import crypto from 'crypto';
import { PublicVpnGateServer, VpnGateServer } from '../../db/schema';
import { LogService } from '../log.service';

const VPNGATE_API_URL = 'https://www.vpngate.net/api/iphone/';
const CACHE_TTL_MS = 5 * 60 * 1000;
let cachedServers: VpnGateServer[] = [];
let lastFetchTimestamp = 0;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let quoted = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        quoted = !quoted;
      }
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  values.push(current);
  return values;
}

function serverId(ip: string, hostname: string, config: string): string {
  return crypto.createHash('sha256').update(`${ip}|${hostname}|${config}`).digest('hex').slice(0, 24);
}

export class VpnGateService {
  static async fetchServers(forceRefresh = false): Promise<VpnGateServer[]> {
    const now = Date.now();
    if (!forceRefresh && cachedServers.length && now - lastFetchTimestamp < CACHE_TTL_MS) {
      return cachedServers;
    }

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      const response = await fetch(VPNGATE_API_URL, {
        signal: controller.signal,
        cache: 'no-store',
        headers: { 'User-Agent': 'IPTV-Proxy-Manager/1.0' },
      });
      clearTimeout(timeout);

      if (!response.ok) throw new Error(`VPNGate returned HTTP ${response.status}.`);
      const rawCsv = await response.text();
      const servers = this.parseCsv(rawCsv);
      if (!servers.length) throw new Error('VPNGate returned no usable OpenVPN servers.');

      cachedServers = servers;
      lastFetchTimestamp = Date.now();
      await LogService.info('vpngate', 'refresh', `Fetched ${servers.length} VPNGate OpenVPN relays.`);
      return servers;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await LogService.error('vpngate', 'fetch', `Failed to refresh VPNGate servers: ${message}`);
      if (cachedServers.length) return cachedServers;
      throw new Error(`Unable to fetch VPNGate servers: ${message}`);
    }
  }

  static async getPublicServers(forceRefresh = false): Promise<PublicVpnGateServer[]> {
    return (await this.fetchServers(forceRefresh)).map(({ ovpnConfigBase64: _config, ...server }) => server);
  }

  static async getServerById(id: string): Promise<VpnGateServer | null> {
    let server = cachedServers.find((item) => item.id === id) || null;
    if (server) return server;
    await this.fetchServers(false);
    server = cachedServers.find((item) => item.id === id) || null;
    return server;
  }

  private static parseCsv(csvText: string): VpnGateServer[] {
    const lines = csvText.split(/\r?\n/);
    const headerIndex = lines.findIndex((line) => line.includes('OpenVPN_ConfigData_Base64'));
    if (headerIndex < 0) throw new Error('Malformed VPNGate CSV header.');

    const headers = parseCsvLine(lines[headerIndex].replace(/^#/, '')).map((header) => header.trim());
    const index = (name: string) => headers.indexOf(name);
    const hostIdx = index('HostName');
    const ipIdx = index('IP');
    const scoreIdx = index('Score');
    const pingIdx = index('Ping');
    const speedIdx = index('Speed');
    const countryLongIdx = index('CountryLong');
    const countryShortIdx = index('CountryShort');
    const sessionsIdx = index('NumVpnSessions');
    const uptimeIdx = index('Uptime');
    const configIdx = index('OpenVPN_ConfigData_Base64');

    if ([hostIdx, ipIdx, configIdx].some((value) => value < 0)) {
      throw new Error('VPNGate CSV is missing required columns.');
    }

    const servers: VpnGateServer[] = [];
    for (let i = headerIndex + 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line || line.startsWith('*') || line.startsWith('#')) continue;
      const columns = parseCsvLine(line);
      const ip = columns[ipIdx]?.trim();
      const config = columns[configIdx]?.trim();
      if (!ip || !config) continue;
      const hostname = columns[hostIdx]?.trim() || ip;

      servers.push({
        id: serverId(ip, hostname, config),
        hostname,
        ip,
        score: Number.parseInt(columns[scoreIdx] || '0', 10) || 0,
        ping: Number.parseInt(columns[pingIdx] || '0', 10) || 0,
        speed: Number.parseInt(columns[speedIdx] || '0', 10) || 0,
        countryLong: columns[countryLongIdx]?.trim() || 'Unknown',
        countryShort: columns[countryShortIdx]?.trim().toUpperCase() || 'UN',
        sessions: Number.parseInt(columns[sessionsIdx] || '0', 10) || 0,
        uptime: Number.parseInt(columns[uptimeIdx] || '0', 10) || 0,
        ovpnConfigBase64: config,
      });
    }

    return servers;
  }

  static decodeConfig(base64Config: string): string {
    if (!base64Config || base64Config.length > 2_000_000) throw new Error('Invalid VPNGate OpenVPN configuration.');
    const decoded = Buffer.from(base64Config, 'base64').toString('utf8');
    if (!decoded.trim()) throw new Error('VPNGate OpenVPN configuration decoded to an empty file.');
    return decoded;
  }
}
