import { spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { getDb, initDatabase } from '../../db';
import { OpenvpnProfile, OpenvpnProfileSummary, OpenvpnSource } from '../../db/schema';
import { LogService } from '../log.service';

const RUNTIME_DIR = '/tmp/vpn/openvpn';
const PID_FILE = path.join(RUNTIME_DIR, 'openvpn.pid');
const LOG_FILE = path.join(RUNTIME_DIR, 'openvpn.log');
const CONFIG_FILE = path.join(RUNTIME_DIR, 'client.ovpn');
const AUTH_FILE = path.join(RUNTIME_DIR, 'auth.txt');
let activeOpenvpnProcess: ChildProcess | null = null;

const EXECUTION_DIRECTIVES = new Set([
  'up','down','route-up','ipchange','client-connect','client-disconnect','learn-address',
  'auth-user-pass-verify','tls-verify','plugin',
]);
const MANAGED_DIRECTIVES = new Set([
  'auth-user-pass','script-security','daemon','writepid','log','log-append','status','management',
  'management-client','management-query-passwords','management-hold','cd','chroot','user','group',
]);

export interface OpenvpnValidationResult {
  valid: boolean;
  error?: string;
  remotes: string[];
  proto?: string;
  dev?: string;
}

function firstToken(line: string): string {
  return line.trim().split(/\s+/)[0]?.toLowerCase() || '';
}

export function validateOpenvpnConfig(rawConfig: string): OpenvpnValidationResult {
  if (rawConfig.length > 1_000_000) return { valid: false, error: 'OpenVPN configuration is too large.', remotes: [] };

  const remotes: string[] = [];
  let proto = 'udp';
  let dev = 'tun';
  for (const rawLine of rawConfig.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('<')) continue;
    const parts = line.split(/\s+/);
    const directive = parts[0]?.toLowerCase() || '';
    if (EXECUTION_DIRECTIVES.has(directive)) {
      return { valid: false, error: `OpenVPN directive "${directive}" is not allowed because profiles may not execute external commands or plugins.`, remotes };
    }
    if (directive === 'remote' && parts[1]) remotes.push(`${parts[1]}:${parts[2] || '1194'}`);
    else if (directive === 'proto' && parts[1]) proto = parts[1].toLowerCase();
    else if (directive === 'dev' && parts[1]) dev = parts[1].toLowerCase();
  }
  if (!remotes.length && !rawConfig.includes('<connection>')) return { valid: false, error: 'Configuration does not specify a remote server endpoint.', remotes };
  if (!dev.startsWith('tun')) return { valid: false, error: 'Only TUN-mode OpenVPN profiles are supported.', remotes, proto, dev };
  return { valid: true, remotes, proto, dev };
}

function sanitizeRuntimeConfig(rawConfig: string): string {
  return rawConfig.split(/\r?\n/).filter((rawLine) => {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';') || line.startsWith('<')) return true;
    const directive = firstToken(line);
    return !EXECUTION_DIRECTIVES.has(directive) && !MANAGED_DIRECTIVES.has(directive);
  }).join('\n').trim();
}

function rowToProfile(row: Record<string, unknown>, includePassword: boolean): OpenvpnProfile {
  return {
    id: String(row.id), name: String(row.name), config: String(row.config),
    username: row.username ? String(row.username) : null,
    password: row.password ? (includePassword ? String(row.password) : '••••••••') : null,
    source: (row.source as OpenvpnSource) || 'uploaded', enabled: Number(row.enabled ?? 1),
    created_at: String(row.created_at), updated_at: String(row.updated_at),
  };
}

function readLogTail(max = 4_000): string {
  try {
    if (!fs.existsSync(LOG_FILE)) return '';
    return fs.readFileSync(LOG_FILE, 'utf8').slice(-max);
  } catch { return ''; }
}

function pidIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function removeRuntimeFile(file: string): void {
  try { fs.unlinkSync(/*turbopackIgnore: true*/ file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

export class OpenvpnService {
  static toSummary(profile: OpenvpnProfile): OpenvpnProfileSummary {
    const validation = validateOpenvpnConfig(profile.config);
    return { id: profile.id, name: profile.name, remotes: validation.remotes.slice(0, 3), proto: validation.proto || null,
      dev: validation.dev || null, hasCredentials: Boolean(profile.username || profile.password), source: profile.source,
      enabled: profile.enabled, created_at: profile.created_at, updated_at: profile.updated_at };
  }

  static async getAllProfiles(includePassword = false): Promise<OpenvpnProfile[]> {
    await initDatabase();
    const res = await getDb().execute('SELECT * FROM openvpn_profiles ORDER BY name ASC');
    return res.rows.map((row) => rowToProfile(row as unknown as Record<string, unknown>, includePassword));
  }
  static async getAllProfileSummaries(): Promise<OpenvpnProfileSummary[]> {
    return (await this.getAllProfiles(false)).map((profile) => this.toSummary(profile));
  }
  static async getProfileById(id: string, includePassword = false): Promise<OpenvpnProfile | null> {
    await initDatabase();
    const res = await getDb().execute({ sql: 'SELECT * FROM openvpn_profiles WHERE id = ?', args: [id] });
    return res.rows.length ? rowToProfile(res.rows[0] as unknown as Record<string, unknown>, includePassword) : null;
  }

  static async createProfile(input: { name: string; config: string; username?: string | null; password?: string | null; source?: OpenvpnSource; }): Promise<OpenvpnProfile> {
    const validation = validateOpenvpnConfig(input.config);
    if (!validation.valid) throw new Error(`Invalid OpenVPN configuration: ${validation.error}`);
    await initDatabase();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const name = input.name.trim();
    if (!name) throw new Error('Profile name is required.');
    await getDb().execute({ sql: `INSERT INTO openvpn_profiles (id,name,config,username,password,source,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)`,
      args: [id, name, input.config.trim(), input.username?.trim() || null, input.password || null, input.source || 'uploaded', now, now] });
    await LogService.info('openvpn', 'profile', `OpenVPN profile "${name}" created.`, { profile_id: id, source: input.source || 'uploaded', remotes: validation.remotes });
    const created = await this.getProfileById(id, true);
    if (!created) throw new Error('OpenVPN profile could not be reloaded.');
    return created;
  }

  static async updateProfile(id: string, input: { name?: string; config?: string; username?: string | null; password?: string | null; enabled?: boolean; }): Promise<OpenvpnProfile> {
    const existing = await this.getProfileById(id, true);
    if (!existing) throw new Error('OpenVPN profile not found.');
    if (input.config !== undefined) {
      const validation = validateOpenvpnConfig(input.config);
      if (!validation.valid) throw new Error(`Invalid OpenVPN configuration: ${validation.error}`);
    }
    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (!name) throw new Error('Profile name cannot be empty.');
    const config = input.config !== undefined ? input.config.trim() : existing.config;
    const username = input.username !== undefined ? input.username?.trim() || null : existing.username;
    const password = input.password !== undefined ? (input.password === '••••••••' ? existing.password : input.password) : existing.password;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;
    const now = new Date().toISOString();
    await getDb().execute({ sql: 'UPDATE openvpn_profiles SET name=?,config=?,username=?,password=?,enabled=?,updated_at=? WHERE id=?', args: [name, config, username, password, enabled, now, id] });
    await LogService.info('openvpn', 'profile', `OpenVPN profile "${name}" updated.`, { profile_id: id });
    const updated = await this.getProfileById(id, true);
    if (!updated) throw new Error('OpenVPN profile could not be reloaded.');
    return updated;
  }

  static async deleteProfile(id: string): Promise<void> {
    const existing = await this.getProfileById(id, false);
    if (!existing) throw new Error('OpenVPN profile not found.');
    await getDb().execute({ sql: 'DELETE FROM openvpn_profiles WHERE id = ?', args: [id] });
    await LogService.warn('openvpn', 'profile', `OpenVPN profile "${existing.name}" deleted.`, { profile_id: id });
  }

  static async startConnection(profile: OpenvpnProfile): Promise<{ success: boolean; error?: string }> {
    try {
      fs.mkdirSync(RUNTIME_DIR, { recursive: true, mode: 0o700 });
      [PID_FILE, LOG_FILE, CONFIG_FILE, AUTH_FILE].forEach(removeRuntimeFile);
      fs.writeFileSync(CONFIG_FILE, sanitizeRuntimeConfig(profile.config), { mode: 0o600 });
      const args = ['--config', CONFIG_FILE, '--writepid', PID_FILE, '--log', LOG_FILE, '--script-security', '1', '--auth-nocache', '--connect-retry-max', '2', '--connect-timeout', '10'];
      if (profile.username && profile.password) {
        fs.writeFileSync(AUTH_FILE, `${profile.username}\n${profile.password}\n`, { mode: 0o600 });
        args.push('--auth-user-pass', AUTH_FILE);
      }

      const proc = spawn('openvpn', args, { detached: true, stdio: 'ignore' });
      const spawnState: { error: string | null } = { error: null };
      proc.once('error', (error) => { spawnState.error = error instanceof Error ? error.message : String(error); });
      activeOpenvpnProcess = proc;
      proc.unref();

      const timeoutSeconds = Math.max(10, Math.min(120, Number(process.env.VPN_CONNECT_TIMEOUT_SECONDS || 45)));
      const deadline = Date.now() + timeoutSeconds * 1_000;
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        if (spawnState.error) return { success: false, error: `Unable to launch OpenVPN: ${spawnState.error}` };
        const tail = readLogTail();
        if (tail.includes('Initialization Sequence Completed')) return { success: true };
        if (/AUTH_FAILED|Options error:|Exiting due to fatal error|Cannot load|Error opening configuration|TLS Error: TLS key negotiation failed/i.test(tail)) {
          return { success: false, error: tail.slice(-1_500) || 'OpenVPN reported a connection failure.' };
        }
        if (fs.existsSync(PID_FILE)) {
          const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
          if (Number.isInteger(pid) && !pidIsAlive(pid)) return { success: false, error: tail.slice(-1_500) || 'OpenVPN process exited before connecting.' };
        }
      }
      return { success: false, error: `OpenVPN did not become ready within ${timeoutSeconds} seconds. ${readLogTail(1_000)}`.trim() };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }

  static async isConnectionActive(): Promise<boolean> {
    try {
      if (!fs.existsSync(PID_FILE)) return false;
      const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
      return Number.isInteger(pid) && pidIsAlive(pid) && readLogTail().includes('Initialization Sequence Completed');
    } catch { return false; }
  }

  static async stopConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (activeOpenvpnProcess) {
        try { activeOpenvpnProcess.kill('SIGTERM'); } catch {}
        activeOpenvpnProcess = null;
      }
      if (fs.existsSync(PID_FILE)) {
        const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
        if (Number.isInteger(pid) && pidIsAlive(pid)) {
          try { process.kill(pid, 'SIGTERM'); } catch {}
          const deadline = Date.now() + 3_000;
          while (Date.now() < deadline && pidIsAlive(pid)) await new Promise((resolve) => setTimeout(resolve, 150));
          if (pidIsAlive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
        }
      }
      [PID_FILE, CONFIG_FILE, AUTH_FILE].forEach(removeRuntimeFile);
      return { success: true };
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
}
