import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, initDatabase } from '../../db';
import { WireguardProfile } from '../../db/schema';
import { LogService } from '../log.service';

const RUNTIME_DIR = '/tmp/vpn/wireguard';
const WG_INTERFACE = 'wg0';

export interface WireguardValidationResult {
  valid: boolean;
  error?: string;
  interfaceAddress?: string;
  endpoint?: string;
  hasPrivateKey: boolean;
}

export function validateWireguardConfig(rawConfig: string): WireguardValidationResult {
  const lines = rawConfig.split('\n').map((l) => l.trim());
  let hasInterface = false;
  let hasPrivateKey = false;
  let interfaceAddress = '';
  let endpoint = '';

  for (const line of lines) {
    if (line.startsWith('#') || !line) continue;
    if (line.toLowerCase() === '[interface]') {
      hasInterface = true;
    }
    if (line.toLowerCase().startsWith('privatekey')) {
      hasPrivateKey = true;
    }
    if (line.toLowerCase().startsWith('address')) {
      const parts = line.split('=');
      if (parts[1]) interfaceAddress = parts[1].trim();
    }
    if (line.toLowerCase().startsWith('endpoint')) {
      const parts = line.split('=');
      if (parts[1]) endpoint = parts[1].trim();
    }
  }

  if (!hasInterface) {
    return { valid: false, error: 'Configuration must contain an [Interface] section', hasPrivateKey: false };
  }
  if (!hasPrivateKey) {
    return { valid: false, error: 'Configuration missing required PrivateKey directive', hasPrivateKey: false };
  }

  return {
    valid: true,
    interfaceAddress,
    endpoint,
    hasPrivateKey,
  };
}

export class WireguardService {
  static async getAllProfiles(): Promise<WireguardProfile[]> {
    await initDatabase();
    const db = getDb();
    const res = await db.execute('SELECT * FROM wireguard_profiles ORDER BY name ASC');

    return res.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      config: String(row.config),
      enabled: Number(row.enabled ?? 1),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));
  }

  static async getProfileById(id: string): Promise<WireguardProfile | null> {
    await initDatabase();
    const db = getDb();
    const res = await db.execute({
      sql: 'SELECT * FROM wireguard_profiles WHERE id = ?',
      args: [id],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      config: String(row.config),
      enabled: Number(row.enabled ?? 1),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  static async createProfile(name: string, config: string): Promise<WireguardProfile> {
    const validation = validateWireguardConfig(config);
    if (!validation.valid) {
      throw new Error(`Invalid WireGuard configuration: ${validation.error}`);
    }

    await initDatabase();
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.execute({
      sql: `INSERT INTO wireguard_profiles (id, name, config, enabled, created_at, updated_at)
            VALUES (?, ?, ?, 1, ?, ?)`,
      args: [id, name.trim(), config.trim(), now, now],
    });

    await LogService.info('wireguard', 'profile', `WireGuard profile "${name.trim()}" created.`, {
      profile_id: id,
      endpoint: validation.endpoint,
    });

    return (await this.getProfileById(id))!;
  }

  static async updateProfile(id: string, name?: string, config?: string, enabled?: boolean): Promise<WireguardProfile> {
    const existing = await this.getProfileById(id);
    if (!existing) throw new Error('WireGuard profile not found');

    if (config) {
      const validation = validateWireguardConfig(config);
      if (!validation.valid) {
        throw new Error(`Invalid WireGuard configuration: ${validation.error}`);
      }
    }

    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    const newName = name !== undefined ? name.trim() : existing.name;
    const newConfig = config !== undefined ? config.trim() : existing.config;
    const newEnabled = enabled !== undefined ? (enabled ? 1 : 0) : existing.enabled;

    await db.execute({
      sql: `UPDATE wireguard_profiles SET name = ?, config = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      args: [newName, newConfig, newEnabled, now, id],
    });

    await LogService.info('wireguard', 'profile', `WireGuard profile "${newName}" updated.`, { profile_id: id });
    return (await this.getProfileById(id))!;
  }

  static async deleteProfile(id: string): Promise<void> {
    await initDatabase();
    const db = getDb();
    const existing = await this.getProfileById(id);
    if (!existing) throw new Error('Profile not found');

    await db.execute({
      sql: 'DELETE FROM wireguard_profiles WHERE id = ?',
      args: [id],
    });

    await LogService.warn('wireguard', 'profile', `WireGuard profile "${existing.name}" deleted.`, { profile_id: id });
  }

  /**
   * Starts WireGuard connection using wg-quick or wg tool
   */
  static async startConnection(profile: WireguardProfile): Promise<{ success: boolean; error?: string }> {
    try {
      if (!fs.existsSync(RUNTIME_DIR)) {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      }

      const confPath = path.join(RUNTIME_DIR, `${WG_INTERFACE}.conf`);
      fs.writeFileSync(confPath, profile.config, { mode: 0o600 });

      // Run wg-quick up
      return new Promise((resolve) => {
        const proc = spawn('wg-quick', ['up', confPath]);
        let stderr = '';

        proc.stderr?.on('data', (data) => {
          stderr += data.toString();
        });

        proc.on('error', (err) => {
          resolve({
            success: false,
            error: `WireGuard tool execution failed (is wg-quick installed & NET_ADMIN enabled?): ${err.message}`,
          });
        });

        proc.on('close', (code) => {
          if (code === 0) {
            resolve({ success: true });
          } else {
            resolve({
              success: false,
              error: `wg-quick exited with code ${code}: ${stderr.trim() || 'Command failed'}`,
            });
          }
        });
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Stops WireGuard connection cleanly
   */
  static async stopConnection(): Promise<{ success: boolean; error?: string }> {
    return new Promise((resolve) => {
      const confPath = path.join(RUNTIME_DIR, `${WG_INTERFACE}.conf`);
      const proc = spawn('wg-quick', ['down', confPath]);

      proc.on('error', () => {
        // Fallback: try deleting interface directly if wg-quick fails
        const fallback = spawn('ip', ['link', 'delete', 'dev', WG_INTERFACE]);
        fallback.on('close', () => resolve({ success: true }));
      });

      proc.on('close', () => {
        if (fs.existsSync(confPath)) {
          try {
            fs.unlinkSync(confPath);
          } catch {
            // Ignore
          }
        }
        resolve({ success: true });
      });
    });
  }
}
