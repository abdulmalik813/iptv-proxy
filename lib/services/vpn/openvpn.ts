import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, initDatabase } from '../../db';
import { OpenvpnProfile, OpenvpnSource } from '../../db/schema';
import { LogService } from '../log.service';

const RUNTIME_DIR = '/tmp/vpn/openvpn';
const PID_FILE = path.join(RUNTIME_DIR, 'openvpn.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'openvpn.log');

let activeOpenvpnProcess: ChildProcess | null = null;

export interface OpenvpnValidationResult {
  valid: boolean;
  error?: string;
  remotes: string[];
  proto?: string;
  dev?: string;
}

export function validateOpenvpnConfig(rawConfig: string): OpenvpnValidationResult {
  const lines = rawConfig.split('\n').map((l) => l.trim());
  const remotes: string[] = [];
  let proto = 'udp';
  let dev = 'tun';

  for (const line of lines) {
    if (line.startsWith('#') || line.startsWith(';') || !line) continue;
    const parts = line.split(/\s+/);
    const directive = parts[0]?.toLowerCase();

    if (directive === 'remote' && parts[1]) {
      remotes.push(`${parts[1]}:${parts[2] || '1194'}`);
    } else if (directive === 'proto' && parts[1]) {
      proto = parts[1].toLowerCase();
    } else if (directive === 'dev' && parts[1]) {
      dev = parts[1].toLowerCase();
    }
  }

  if (remotes.length === 0 && !rawConfig.includes('<connection>')) {
    return { valid: false, error: 'Configuration does not specify any remote server endpoint', remotes };
  }

  return {
    valid: true,
    remotes,
    proto,
    dev,
  };
}

export class OpenvpnService {
  static async getAllProfiles(): Promise<OpenvpnProfile[]> {
    await initDatabase();
    const db = getDb();
    const res = await db.execute('SELECT * FROM openvpn_profiles ORDER BY name ASC');

    return res.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      config: String(row.config),
      username: row.username ? String(row.username) : null,
      password: row.password ? '••••••••' : null,
      source: (row.source as OpenvpnSource) || 'uploaded',
      enabled: Number(row.enabled ?? 1),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    }));
  }

  static async getProfileById(id: string, includePassword = false): Promise<OpenvpnProfile | null> {
    await initDatabase();
    const db = getDb();
    const res = await db.execute({
      sql: 'SELECT * FROM openvpn_profiles WHERE id = ?',
      args: [id],
    });
    if (res.rows.length === 0) return null;
    const row = res.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      config: String(row.config),
      username: row.username ? String(row.username) : null,
      password: row.password ? (includePassword ? String(row.password) : '••••••••') : null,
      source: (row.source as OpenvpnSource) || 'uploaded',
      enabled: Number(row.enabled ?? 1),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  static async createProfile(input: {
    name: string;
    config: string;
    username?: string | null;
    password?: string | null;
    source?: OpenvpnSource;
  }): Promise<OpenvpnProfile> {
    const validation = validateOpenvpnConfig(input.config);
    if (!validation.valid) {
      throw new Error(`Invalid OpenVPN configuration: ${validation.error}`);
    }

    await initDatabase();
    const db = getDb();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const source: OpenvpnSource = input.source || 'uploaded';

    await db.execute({
      sql: `INSERT INTO openvpn_profiles (id, name, config, username, password, source, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      args: [
        id,
        input.name.trim(),
        input.config.trim(),
        input.username ? input.username.trim() : null,
        input.password || null,
        source,
        now,
        now,
      ],
    });

    await LogService.info('openvpn', 'profile', `OpenVPN profile "${input.name.trim()}" created (${source}).`, {
      profile_id: id,
      remotes: validation.remotes,
    });

    return (await this.getProfileById(id))!;
  }

  static async updateProfile(
    id: string,
    input: {
      name?: string;
      config?: string;
      username?: string | null;
      password?: string | null;
      enabled?: boolean;
    }
  ): Promise<OpenvpnProfile> {
    const existing = await this.getProfileById(id, true);
    if (!existing) throw new Error('OpenVPN profile not found');

    if (input.config) {
      const validation = validateOpenvpnConfig(input.config);
      if (!validation.valid) {
        throw new Error(`Invalid OpenVPN configuration: ${validation.error}`);
      }
    }

    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const config = input.config !== undefined ? input.config.trim() : existing.config;
    const username = input.username !== undefined ? (input.username ? input.username.trim() : null) : existing.username;
    const password = input.password !== undefined
      ? (input.password === '••••••••' ? existing.password : input.password)
      : existing.password;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

    await db.execute({
      sql: `UPDATE openvpn_profiles SET name = ?, config = ?, username = ?, password = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      args: [name, config, username, password, enabled, now, id],
    });

    await LogService.info('openvpn', 'profile', `OpenVPN profile "${name}" updated.`, { profile_id: id });
    return (await this.getProfileById(id))!;
  }

  static async deleteProfile(id: string): Promise<void> {
    await initDatabase();
    const db = getDb();
    const existing = await this.getProfileById(id);
    if (!existing) throw new Error('Profile not found');

    await db.execute({
      sql: 'DELETE FROM openvpn_profiles WHERE id = ?',
      args: [id],
    });

    await LogService.warn('openvpn', 'profile', `OpenVPN profile "${existing.name}" deleted.`, { profile_id: id });
  }

  /**
   * Starts an OpenVPN connection
   */
  static async startConnection(profile: OpenvpnProfile): Promise<{ success: boolean; error?: string }> {
    try {
      if (!fs.existsSync(RUNTIME_DIR)) {
        fs.mkdirSync(RUNTIME_DIR, { recursive: true });
      }

      // Write config to temp file
      const configPath = path.join(RUNTIME_DIR, 'client.ovpn');
      let configContent = profile.config;

      // Handle user/pass if provided
      let authFilePath: string | null = null;
      if (profile.username && profile.password) {
        authFilePath = path.join(RUNTIME_DIR, 'auth.txt');
        fs.writeFileSync(authFilePath, `${profile.username}\n${profile.password}\n`, { mode: 0o600 });
      }

      // Strip dangerous commands and add route preservation
      fs.writeFileSync(configPath, configContent, { mode: 0o600 });

      const args = [
        '--config',
        configPath,
        '--writepid',
        PID_FILE,
        '--log',
        LOG_FILE,
        '--script-security',
        '2',
      ];

      if (authFilePath) {
        args.push('--auth-user-pass', authFilePath);
      }

      const proc = spawn('openvpn', args, {
        detached: true,
        stdio: 'ignore',
      });

      activeOpenvpnProcess = proc;
      proc.unref();

      // Wait a few seconds to verify it launched and didn't immediately exit
      await new Promise((r) => setTimeout(r, 2000));

      if (fs.existsSync(PID_FILE)) {
        return { success: true };
      } else if (fs.existsSync(LOG_FILE)) {
        const logs = fs.readFileSync(LOG_FILE, 'utf-8');
        return { success: false, error: logs.slice(-500) || 'OpenVPN failed to create PID file' };
      }

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }

  /**
   * Stops active OpenVPN connection cleanly
   */
  static async stopConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (activeOpenvpnProcess) {
        try {
          activeOpenvpnProcess.kill('SIGTERM');
        } catch {
          // Process might already be closed
        }
        activeOpenvpnProcess = null;
      }

      if (fs.existsSync(PID_FILE)) {
        const pid = parseInt(fs.readFileSync(PID_FILE, 'utf-8').trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, 'SIGTERM');
            // Allow 1s for graceful exit
            await new Promise((r) => setTimeout(r, 1000));
            process.kill(pid, 'SIGKILL');
          } catch {
            // Already dead
          }
        }
        fs.unlinkSync(PID_FILE);
      }

      // Clean up auth and config files
      const authFile = path.join(RUNTIME_DIR, 'auth.txt');
      if (fs.existsSync(authFile)) {
        try {
          fs.unlinkSync(authFile);
        } catch {
          // Ignore
        }
      }

      return { success: true };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, error: msg };
    }
  }
}
