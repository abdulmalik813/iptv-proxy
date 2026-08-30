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
const FORBIDDEN_DIRECTIVES = new Set(['preup', 'postup', 'predown', 'postdown']);

export interface WireguardValidationResult {
  valid: boolean;
  error?: string;
  interfaceAddress?: string;
  endpoint?: string;
  hasPrivateKey: boolean;
}

function directiveName(line: string): string | null {
  const match = line.match(/^([A-Za-z][A-Za-z0-9]*)\s*=/);
  return match?.[1]?.toLowerCase() || null;
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
    if (directive === 'address') interfaceAddress = line.split('=').slice(1).join('=').trim();
    if (directive === 'endpoint') endpoint = line.split('=').slice(1).join('=').trim();
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

function runtimeConfig(rawConfig: string): string {
  return rawConfig
    .split(/\r?\n/)
    .filter((line) => {
      const directive = directiveName(line.trim());
      // DNS invokes resolvconf and can replace Docker DNS. Table is normalized so
      // wg-quick uses its predictable policy-routing behavior.
      return directive !== 'dns' && directive !== 'table' && !FORBIDDEN_DIRECTIVES.has(directive || '');
    })
    .join('\n')
    .trim();
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
      fs.writeFileSync(CONFIG_PATH, runtimeConfig(profile.config), { mode: 0o600 });

      await execFileAsync('wg-quick', ['up', CONFIG_PATH], { timeout: 20_000 });
      await execFileAsync('ip', ['link', 'show', 'dev', WG_INTERFACE], { timeout: 5_000 });
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: `WireGuard startup failed: ${message}` };
    }
  }

  static async isConnectionActive(): Promise<boolean> {
    try {
      await execFileAsync('ip', ['link', 'show', 'dev', WG_INTERFACE], { timeout: 3_000 });
      return true;
    } catch {
      return false;
    }
  }

  static async hasRecentHandshake(maxAgeSeconds = 180): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('wg', ['show', WG_INTERFACE, 'latest-handshakes'], { timeout: 5_000 });
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
      if (fs.existsSync(CONFIG_PATH)) {
        try {
          await execFileAsync('wg-quick', ['down', CONFIG_PATH], { timeout: 15_000 });
        } catch {
          try {
            await execFileAsync('ip', ['link', 'delete', 'dev', WG_INTERFACE], { timeout: 5_000 });
          } catch {
            // The interface may already be down.
          }
        }
        try {
          fs.unlinkSync(CONFIG_PATH);
        } catch {
          // Ignore cleanup failure.
        }
      } else {
        try {
          await execFileAsync('ip', ['link', 'delete', 'dev', WG_INTERFACE], { timeout: 5_000 });
        } catch {
          // Not active.
        }
      }
      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, error: message };
    }
  }
}
