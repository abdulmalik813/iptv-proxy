import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, initDatabase } from '../../db';
import { WireguardProfile, WireguardProfileSummary } from '../../db/schema';
import { LogService } from '../log.service';

const execFileAsync = promisify(execFile);
const RUNTIME_DIR = '/tmp/vpn/wireguard';
const WG_INTERFACE = 'wg0';
const CONFIG_PATH = path.join(RUNTIME_DIR, `${WG_INTERFACE}.conf`);
const WG_SETCONF_PATH = path.join(RUNTIME_DIR, `${WG_INTERFACE}.setconf`);
const ENDPOINT_ROUTE_PATH = path.join(RUNTIME_DIR, `${WG_INTERFACE}.endpoint-route`);
const FORBIDDEN_DIRECTIVES = new Set(['preup', 'postup', 'predown', 'postdown']);

export interface WireguardValidationResult {
  valid: boolean;
  error?: string;
  interfaceAddress?: string;
  endpoint?: string;
  hasPrivateKey: boolean;
}

type RuntimeWireguardConfig = {
  setconf: string;
  addresses: string[];
  mtu: number;
  endpointHost: string | null;
  allowedIps: string[];
};

function directiveName(line: string): string | null {
  const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*=/);
  return match?.[1]?.toLowerCase() || null;
}

function directiveValue(line: string): string {
  return line.split('=').slice(1).join('=').trim();
}

export function validateWireguardConfig(rawConfig: string): WireguardValidationResult {
  if (rawConfig.length > 256_000) {
    return { valid: false, error: 'WireGuard configuration is too large.', hasPrivateKey: false };
  }

  const lines = rawConfig.split(/\r?\n/).map((line) => line.trim());
  let hasInterface = false;
  let hasPeer = false;
  let hasPrivateKey = false;
  let interfaceAddress = '';
  let endpoint = '';

  for (const line of lines) {
    if (!line || line.startsWith('#')) continue;
    const lower = line.toLowerCase();
    if (lower === '[interface]') hasInterface = true;
    if (lower === '[peer]') hasPeer = true;

    const directive = directiveName(line);
    if (directive && FORBIDDEN_DIRECTIVES.has(directive)) {
      return {
        valid: false,
        error: `${directive} hooks are not allowed because VPN profiles must not execute shell commands.`,
        hasPrivateKey,
      };
    }

    if (directive === 'privatekey') hasPrivateKey = true;
    if (directive === 'address') interfaceAddress = directiveValue(line);
    if (directive === 'endpoint') endpoint = directiveValue(line);
  }

  if (!hasInterface) {
    return { valid: false, error: 'Configuration must contain an [Interface] section.', hasPrivateKey };
  }
  if (!hasPeer) {
    return { valid: false, error: 'Configuration must contain at least one [Peer] section.', hasPrivateKey };
  }
  if (!hasPrivateKey) {
    return { valid: false, error: 'Configuration is missing the Interface PrivateKey.', hasPrivateKey: false };
  }

  return { valid: true, interfaceAddress, endpoint, hasPrivateKey };
}

function buildRuntimeConfig(rawConfig: string): RuntimeWireguardConfig {
  const addresses: string[] = [];
  const allowedIps: string[] = [];
  let mtu = 1420;
  let endpointHost: string | null = null;
  const setconfLines: string[] = [];

  for (const originalLine of rawConfig.split(/\r?\n/)) {
    const line = originalLine.trim();
    const directive = directiveName(line);

    if (!line || line.startsWith('#')) {
      setconfLines.push(originalLine);
      continue;
    }

    if (directive && FORBIDDEN_DIRECTIVES.has(directive)) continue;

    if (directive === 'address') {
      addresses.push(...directiveValue(line).split(',').map((value) => value.trim()).filter(Boolean));
      continue;
    }
    if (directive === 'dns' || directive === 'table') continue;
    if (directive === 'mtu') {
      const parsed = Number.parseInt(directiveValue(line), 10);
      if (Number.isInteger(parsed) && parsed >= 576 && parsed <= 9000) mtu = parsed;
      continue;
    }
    if (directive === 'endpoint') {
      const endpoint = directiveValue(line);
      const bracketed = endpoint.match(/^\[([^\]]+)\]:(\d+)$/);
      const regular = endpoint.match(/^(.+):(\d+)$/);
      endpointHost = bracketed?.[1] || regular?.[1] || endpoint;
      setconfLines.push(originalLine);
      continue;
    }
    if (directive === 'allowedips') {
      allowedIps.push(...directiveValue(line).split(',').map((value) => value.trim()).filter(Boolean));
      setconfLines.push(originalLine);
      continue;
    }

    setconfLines.push(originalLine);
  }

  if (addresses.length === 0) throw new Error('WireGuard configuration must include an Interface Address.');
  if (allowedIps.length === 0) throw new Error('WireGuard configuration must include Peer AllowedIPs.');

  return {
    setconf: setconfLines.join('\n').trim(),
    addresses,
    mtu,
    endpointHost,
    allowedIps,
  };
}

async function run(command: string, args: string[], timeout = 8_000): Promise<string> {
  const { stdout } = await execFileAsync(command, args, { timeout });
  return stdout.trim();
}

async function resolveEndpointIpv4(host: string): Promise<string | null> {
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return host;
  try {
    const output = await run('getent', ['ahostsv4', host], 5_000);
    const first = output.split('\n').map((line) => line.trim()).find(Boolean);
    return first?.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

async function getDefaultRoute(): Promise<{ gateway: string | null; device: string | null }> {
  const output = await run('ip', ['-4', 'route', 'show', 'default'], 5_000);
  const line = output.split('\n').map((entry) => entry.trim()).find(Boolean) || '';
  const via = line.match(/\bvia\s+(\S+)/)?.[1] || null;
  const dev = line.match(/\bdev\s+(\S+)/)?.[1] || null;
  return { gateway: via, device: dev };
}

async function addEndpointBypassRoute(endpointHost: string | null): Promise<void> {
  if (!endpointHost || endpointHost.includes(':')) return;
  const endpointIp = await resolveEndpointIpv4(endpointHost);
  if (!endpointIp) throw new Error(`Unable to resolve WireGuard endpoint ${endpointHost}.`);

  const { gateway, device } = await getDefaultRoute();
  if (!device) throw new Error('Unable to determine the container default network interface.');

  const args = ['-4', 'route', 'replace', `${endpointIp}/32`];
  if (gateway) args.push('via', gateway);
  args.push('dev', device);
  await run('ip', args);
  fs.writeFileSync(ENDPOINT_ROUTE_PATH, endpointIp, { mode: 0o600 });
}

async function installAllowedIpRoutes(allowedIps: string[]): Promise<void> {
  for (const cidr of allowedIps) {
    if (cidr.includes(':')) continue;
    if (cidr === '0.0.0.0/0') {
      await run('ip', ['-4', 'route', 'replace', '0.0.0.0/1', 'dev', WG_INTERFACE]);
      await run('ip', ['-4', 'route', 'replace', '128.0.0.0/1', 'dev', WG_INTERFACE]);
      continue;
    }
    await run('ip', ['-4', 'route', 'replace', cidr, 'dev', WG_INTERFACE]);
  }
}

async function cleanupRuntimeNetwork(): Promise<void> {
  try {
    await run('ip', ['link', 'delete', 'dev', WG_INTERFACE], 5_000);
  } catch {
    // Interface may already be absent.
  }

  try {
    if (fs.existsSync(ENDPOINT_ROUTE_PATH)) {
      const endpointIp = fs.readFileSync(ENDPOINT_ROUTE_PATH, 'utf8').trim();
      if (endpointIp) {
        try {
          await run('ip', ['-4', 'route', 'delete', `${endpointIp}/32`], 5_000);
        } catch {
          // Route may already be absent.
        }
      }
    }
  } catch {
    // Best-effort cleanup only.
  }

  for (const file of [CONFIG_PATH, WG_SETCONF_PATH, ENDPOINT_ROUTE_PATH]) {
    try {
      if (fs.existsSync(/* turbopackIgnore: true */ file)) fs.unlinkSync(file);
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function rowToProfile(row: Record<string, unknown>): WireguardProfile {
  return {
    id: String(row.id),
    name: String(row.name),
    config: String(row.config),
    enabled: Number(row.enabled ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export class WireguardService {
  static toSummary(profile: WireguardProfile): WireguardProfileSummary {
    const validation = validateWireguardConfig(profile.config);
    return {
      id: profile.id,
      name: profile.name,
      address: validation.interfaceAddress || null,
      endpoint: validation.endpoint || null,
      enabled: profile.enabled,
      created_at: profile.created_at,
      updated_at: profile.updated_at,
    };
  }

  static async getAllProfiles(): Promise<WireguardProfile[]> {
    await initDatabase();
    const res = await getDb().execute('SELECT * FROM wireguard_profiles ORDER BY name ASC');
    return res.rows.map((row) => rowToProfile(row as unknown as Record<string, unknown>));
  }

  static async getAllProfileSummaries(): Promise<WireguardProfileSummary[]> {
    return (await this.getAllProfiles()).map((profile) => this.toSummary(profile));
  }

  static async getProfileById(id: string): Promise<WireguardProfile | null> {
    await initDatabase();
    const res = await getDb().execute({ sql: 'SELECT * FROM wireguard_profiles WHERE id = ?', args: [id] });
    return res.rows.length ? rowToProfile(res.rows[0] as unknown as Record<string, unknown>) : null;
  }

  static async createProfile(name: string, config: string): Promise<WireguardProfile> {
    const validation = validateWireguardConfig(config);
    if (!validation.valid) throw new Error(`Invalid WireGuard configuration: ${validation.error}`);

    await initDatabase();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const cleanName = name.trim();
    if (!cleanName) throw new Error('Profile name is required.');

    await getDb().execute({
      sql: `INSERT INTO wireguard_profiles (id, name, config, enabled, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)`,
      args: [id, cleanName, config.trim(), now, now],
    });

    await LogService.info('wireguard', 'profile', `WireGuard profile "${cleanName}" created.`, {
      profile_id: id,
      endpoint: validation.endpoint,
    });

    const created = await this.getProfileById(id);
    if (!created) throw new Error('WireGuard profile could not be reloaded.');
    return created;
  }

  static async updateProfile(id: string, name?: string, config?: string, enabled?: boolean): Promise<WireguardProfile> {
    const existing = await this.getProfileById(id);
    if (!existing) throw new Error('WireGuard profile not found.');

    if (config !== undefined) {
      const validation = validateWireguardConfig(config);
      if (!validation.valid) throw new Error(`Invalid WireGuard configuration: ${validation.error}`);
    }

    const newName = name !== undefined ? name.trim() : existing.name;
    if (!newName) throw new Error('Profile name cannot be empty.');
    const newConfig = config !== undefined ? config.trim() : existing.config;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;
    const now = new Date().toISOString();

    await getDb().execute({
      sql: 'UPDATE wireguard_profiles SET name = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?',
      args: [newName, newConfig, newEnabled, now, id],
    });
    await LogService.info('wireguard', 'profile', `WireGuard profile "${newName}" updated.`, { profile_id: id });

    const updated = await this.getProfileById(id);
    if (!updated) throw new Error('WireGuard profile could not be reloaded.');
    return updated;
  }

  static async deleteProfile(id: string): Promise<void> {
    const existing = await this.getProfileById(id);
    if (!existing) throw new Error('WireGuard profile not found.');
    await getDb().execute({ sql: 'DELETE FROM wireguard_profiles WHERE id = ?', args: [id] });
    await LogService.warn('wireguard', 'profile', `WireGuard profile "${existing.name}" deleted.`, { profile_id: id });
  }

  static async startConnection(profile: WireguardProfile): Promise<{ success: boolean; error?: string }> {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
      await cleanupRuntimeNetwork();

      const runtime = buildRuntimeConfig(profile.config);
      fs.writeFileSync(CONFIG_PATH, profile.config.trim(), { mode: 0o600 });
      fs.writeFileSync(WG_SETCONF_PATH, runtime.setconf, { mode: 0o600 });

      await addEndpointBypassRoute(runtime.endpointHost);
      await run('ip', ['link', 'add', WG_INTERFACE, 'type', 'wireguard'], 5_000);
      await run('wg', ['setconf', WG_INTERFACE, WG_SETCONF_PATH], 8_000);

      for (const address of runtime.addresses) {
        if (address.includes(':')) continue;
        await run('ip', ['-4', 'address', 'add', address, 'dev', WG_INTERFACE], 5_000);
      }

      await run('ip', ['link', 'set', 'mtu', String(runtime.mtu), 'up', 'dev', WG_INTERFACE], 5_000);
      await installAllowedIpRoutes(runtime.allowedIps);
      await run('ip', ['link', 'show', 'dev', WG_INTERFACE], 5_000);

      await LogService.info('wireguard', 'connect', `WireGuard interface ${WG_INTERFACE} started without wg-quick policy sysctls.`, {
        profile_id: profile.id,
        endpoint: runtime.endpointHost,
        addresses: runtime.addresses,
      });
      return { success: true };
    } catch (error) {
      await cleanupRuntimeNetwork();
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `WireGuard startup failed: ${message}` };
    }
  }

  static async isConnectionActive(): Promise<boolean> {
    try {
      await run('ip', ['link', 'show', 'dev', WG_INTERFACE], 3_000);
      return true;
    } catch {
      return false;
    }
  }

  static async hasRecentHandshake(maxAgeSeconds = 180): Promise<boolean> {
    try {
      const stdout = await run('wg', ['show', WG_INTERFACE, 'latest-handshakes'], 5_000);
      const nowSeconds = Math.floor(Date.now() / 1000);
      return stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          const timestamp = Number.parseInt(line.trim().split(/\s+/).pop() || '0', 10);
          return timestamp > 0 && nowSeconds - timestamp <= maxAgeSeconds;
        });
    } catch {
      return false;
    }
  }

  static async stopConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      await cleanupRuntimeNetwork();
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }
}
