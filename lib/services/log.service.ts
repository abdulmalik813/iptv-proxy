import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getDb, initDatabase } from '../db';
import { LogEntry, LogLevel, LogSource } from '../db/schema';

declare global {
  var __logEventEmitter: EventEmitter | undefined;
}

const logEmitter = global.__logEventEmitter || new EventEmitter();
logEmitter.setMaxListeners(100);
global.__logEventEmitter = logEmitter;
export { logEmitter };

const SENSITIVE_PATTERNS = [
  /password["':\s=]+([^"\s,;&]+)/gi,
  /upstream_password["':\s=]+([^"\s,;&]+)/gi,
  /local_password["':\s=]+([^"\s,;&]+)/gi,
  /privatekey["':\s=]+([^"\s,;&]+)/gi,
  /private_key["':\s=]+([^"\s,;&]+)/gi,
  /presharedkey["':\s=]+([^"\s,;&]+)/gi,
  /session[_-]?token["':\s=]+([^"\s,;&]+)/gi,
  /authorization["':\s=]+([^"\s,;&]+)/gi,
  /bearer\s+([A-Za-z0-9._~-]+)/gi,
];

export function sanitizeLogString(input: string): string {
  let sanitized = input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, captured: string) => match.replace(captured, '[REDACTED]'));
  }
  return sanitized.slice(0, 8_000);
}

function scrubValue(value: unknown, key = ''): unknown {
  const lower = key.toLowerCase();
  if (
    lower.includes('password') ||
    lower.includes('secret') ||
    lower.includes('privatekey') ||
    lower.includes('private_key') ||
    lower.includes('preshared') ||
    lower.includes('token') ||
    lower.includes('cookie') ||
    lower.includes('authorization') ||
    lower.includes('config')
  ) {
    return '[REDACTED]';
  }

  if (Array.isArray(value)) return value.map((item) => scrubValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([childKey, childValue]) => [childKey, scrubValue(childValue, childKey)])
    );
  }
  if (typeof value === 'string') return sanitizeLogString(value);
  return value;
}

export function sanitizeMetadata(metadata?: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  return JSON.stringify(scrubValue(metadata));
}

function rowToLog(row: Record<string, unknown>): LogEntry {
  return {
    id: String(row.id),
    timestamp: String(row.timestamp),
    level: row.level as LogLevel,
    source: row.source as LogSource,
    category: String(row.category),
    message: String(row.message),
    metadata_json: row.metadata_json ? String(row.metadata_json) : null,
    created_at: String(row.created_at),
  };
}

function addGroupCondition(group: string, conditions: string[]) {
  switch (group) {
    case 'traffic':
      conditions.push("(category LIKE 'request.%' OR category LIKE 'upstream.%' OR category LIKE 'route.%' OR category = 'direct.route')");
      break;
    case 'cache':
      conditions.push("category LIKE 'cache.%'");
      break;
    case 'streams':
      conditions.push("(category LIKE 'live.%' OR category LIKE 'hls.%' OR category LIKE 'stream.%')");
      break;
    case 'vpn':
      conditions.push("source IN ('vpn', 'wireguard', 'openvpn', 'vpngate', 'warp')");
      break;
    case 'providers':
      conditions.push("source = 'provider'");
      break;
    case 'auth':
      conditions.push("source = 'auth'");
      break;
    case 'system':
      conditions.push("source = 'system'");
      break;
  }
}

export class LogService {
  static async writeLog(
    level: LogLevel,
    source: LogSource,
    category: string,
    message: string,
    metadata?: Record<string, unknown> | null
  ): Promise<LogEntry> {
    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();
    const entry: LogEntry = {
      id: crypto.randomUUID(),
      timestamp: now,
      level,
      source,
      category: sanitizeLogString(category).slice(0, 128),
      message: sanitizeLogString(message),
      metadata_json: sanitizeMetadata(metadata),
      created_at: now,
    };

    await db.execute({
      sql: `INSERT INTO logs (id, timestamp, level, source, category, message, metadata_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [entry.id, entry.timestamp, entry.level, entry.source, entry.category, entry.message, entry.metadata_json, entry.created_at],
    });

    logEmitter.emit('new_log', entry);
    return entry;
  }

  static info(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('info', source, category, message, metadata);
  }

  static warn(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('warning', source, category, message, metadata);
  }

  static error(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('error', source, category, message, metadata);
  }

  static debug(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('debug', source, category, message, metadata);
  }

  static async getLog(id: string): Promise<LogEntry | null> {
    await initDatabase();
    const res = await getDb().execute({
      sql: 'SELECT id, timestamp, level, source, category, message, metadata_json, created_at FROM logs WHERE id = ? LIMIT 1',
      args: [id],
    });
    return res.rows[0] ? rowToLog(res.rows[0] as Record<string, unknown>) : null;
  }

  static async updateLog(
    id: string,
    input: Partial<{ level: LogLevel; source: LogSource; category: string; message: string; metadata: Record<string, unknown> | null }>
  ): Promise<LogEntry | null> {
    const existing = await this.getLog(id);
    if (!existing) return null;

    const level = input.level ?? existing.level;
    const source = input.source ?? existing.source;
    const category = input.category === undefined ? existing.category : sanitizeLogString(input.category).slice(0, 128);
    const message = input.message === undefined ? existing.message : sanitizeLogString(input.message);
    const metadataJson = input.metadata === undefined ? existing.metadata_json : sanitizeMetadata(input.metadata);

    await getDb().execute({
      sql: 'UPDATE logs SET level = ?, source = ?, category = ?, message = ?, metadata_json = ? WHERE id = ?',
      args: [level, source, category, message, metadataJson, id],
    });

    const updated = await this.getLog(id);
    if (updated) logEmitter.emit('updated_log', updated);
    return updated;
  }

  static async deleteLog(id: string): Promise<boolean> {
    await initDatabase();
    const res = await getDb().execute({ sql: 'DELETE FROM logs WHERE id = ?', args: [id] });
    if (res.rowsAffected > 0) logEmitter.emit('deleted_log', { id });
    return res.rowsAffected > 0;
  }

  static async queryLogs(params: {
    level?: string;
    source?: string;
    category?: string;
    group?: string;
    search?: string;
    limit?: number;
    offset?: number;
    order?: 'ASC' | 'DESC';
  }): Promise<{ logs: LogEntry[]; total: number }> {
    await initDatabase();
    const db = getDb();
    const limit = Math.max(1, Math.min(Number.isFinite(params.limit) ? params.limit || 100 : 100, 500));
    const offset = Math.max(0, Number.isFinite(params.offset) ? params.offset || 0 : 0);
    const order = params.order === 'ASC' ? 'ASC' : 'DESC';
    const conditions: string[] = [];
    const args: (string | number)[] = [];

    if (params.level && params.level !== 'all') {
      conditions.push('level = ?');
      args.push(params.level);
    }
    if (params.source && params.source !== 'all') {
      conditions.push('source = ?');
      args.push(params.source);
    }
    if (params.category && params.category !== 'all') {
      conditions.push('category = ?');
      args.push(params.category);
    }
    if (params.group && params.group !== 'all') {
      addGroupCondition(params.group, conditions);
    }
    if (params.search?.trim()) {
      conditions.push('(message LIKE ? OR category LIKE ? OR source LIKE ? OR metadata_json LIKE ?)');
      const term = `%${params.search.trim().slice(0, 200)}%`;
      args.push(term, term, term, term);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const countRes = await db.execute({ sql: `SELECT COUNT(*) AS count FROM logs ${where}`, args });
    const rowsRes = await db.execute({
      sql: `SELECT id, timestamp, level, source, category, message, metadata_json, created_at
            FROM logs ${where}
            ORDER BY timestamp ${order}
            LIMIT ? OFFSET ?`,
      args: [...args, limit, offset],
    });

    return {
      total: Number(countRes.rows[0]?.count || 0),
      logs: rowsRes.rows.map((row) => rowToLog(row as Record<string, unknown>)),
    };
  }

  static async clearAllLogs(): Promise<number> {
    await initDatabase();
    const res = await getDb().execute('DELETE FROM logs');
    return res.rowsAffected;
  }

  static async pruneOldLogs(days: number): Promise<number> {
    await initDatabase();
    const safeDays = Math.max(1, Math.min(365, Math.trunc(days)));
    const cutoff = new Date(Date.now() - safeDays * 86_400_000).toISOString();
    const res = await getDb().execute({ sql: 'DELETE FROM logs WHERE timestamp < ?', args: [cutoff] });
    return res.rowsAffected;
  }
}
