import { EventEmitter } from 'events';
import crypto from 'crypto';
import { getDb, initDatabase } from '../db';
import { LogEntry, LogLevel, LogSource } from '../db/schema';

// Global Event Emitter for Real-Time SSE Streaming
declare global {
  var __logEventEmitter: EventEmitter | undefined;
}

const logEmitter: EventEmitter = global.__logEventEmitter || new EventEmitter();
logEmitter.setMaxListeners(100);
if (process.env.NODE_ENV !== 'production') {
  global.__logEventEmitter = logEmitter;
}

export { logEmitter };

// Sensitive patterns to sanitize
const SENSITIVE_PATTERNS = [
  /password["':\s=]+([^"\s,;]+)/gi,
  /upstream_password["':\s=]+([^"\s,;]+)/gi,
  /local_password["':\s=]+([^"\s,;]+)/gi,
  /privatekey["':\s=]+([^"\s,;]+)/gi,
  /private_key["':\s=]+([^"\s,;]+)/gi,
  /presharedkey["':\s=]+([^"\s,;]+)/gi,
  /session[_-]?token["':\s=]+([^"\s,;]+)/gi,
  /bearer\s+([A-Za-z0-9-_.]+)/gi,
];

export function sanitizeLogString(input: string): string {
  let sanitized = input;
  for (const pattern of SENSITIVE_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match, p1) => {
      return match.replace(p1, '[REDACTED]');
    });
  }
  return sanitized;
}

export function sanitizeMetadata(metadata?: Record<string, unknown> | null): string | null {
  if (!metadata) return null;
  const clone = JSON.parse(JSON.stringify(metadata));

  function scrub(obj: Record<string, unknown>) {
    for (const key of Object.keys(obj)) {
      const lower = key.toLowerCase();
      if (
        lower.includes('password') ||
        lower.includes('secret') ||
        lower.includes('privatekey') ||
        lower.includes('token') ||
        lower.includes('cookie')
      ) {
        obj[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        scrub(obj[key] as Record<string, unknown>);
      }
    }
  }

  scrub(clone);
  return JSON.stringify(clone);
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

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const sanitizedMsg = sanitizeLogString(message);
    const sanitizedMeta = sanitizeMetadata(metadata);

    const entry: LogEntry = {
      id,
      timestamp: now,
      level,
      source,
      category,
      message: sanitizedMsg,
      metadata_json: sanitizedMeta,
      created_at: now,
    };

    try {
      await db.execute({
        sql: `INSERT INTO logs (id, timestamp, level, source, category, message, metadata_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          entry.id,
          entry.timestamp,
          entry.level,
          entry.source,
          entry.category,
          entry.message,
          entry.metadata_json,
          entry.created_at,
        ],
      });
    } catch (err) {
      console.error('Failed to persist log to SQLite:', err);
    }

    // Broadcast in real-time to SSE clients
    try {
      logEmitter.emit('new_log', entry);
    } catch {
      // Ignore broadcast errors
    }

    return entry;
  }

  static async info(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('info', source, category, message, metadata);
  }

  static async warn(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('warning', source, category, message, metadata);
  }

  static async error(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('error', source, category, message, metadata);
  }

  static async debug(source: LogSource, category: string, message: string, metadata?: Record<string, unknown> | null) {
    return this.writeLog('debug', source, category, message, metadata);
  }

  static async queryLogs(params: {
    level?: string;
    source?: string;
    category?: string;
    search?: string;
    limit?: number;
    offset?: number;
    order?: 'ASC' | 'DESC';
  }): Promise<{ logs: LogEntry[]; total: number }> {
    await initDatabase();
    const db = getDb();

    const limit = Math.min(params.limit || 100, 500);
    const offset = params.offset || 0;
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

    if (params.search && params.search.trim()) {
      conditions.push('(message LIKE ? OR category LIKE ? OR source LIKE ?)');
      const term = `%${params.search.trim()}%`;
      args.push(term, term, term);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await db.execute({
      sql: `SELECT COUNT(*) as count FROM logs ${whereClause}`,
      args,
    });
    const total = Number(countRes.rows[0]?.count || 0);

    const queryArgs = [...args, limit, offset];
    const rowsRes = await db.execute({
      sql: `SELECT id, timestamp, level, source, category, message, metadata_json, created_at 
            FROM logs ${whereClause} 
            ORDER BY timestamp ${order} 
            LIMIT ? OFFSET ?`,
      args: queryArgs,
    });

    const logs: LogEntry[] = rowsRes.rows.map((row) => ({
      id: String(row.id),
      timestamp: String(row.timestamp),
      level: row.level as LogLevel,
      source: row.source as LogSource,
      category: String(row.category),
      message: String(row.message),
      metadata_json: row.metadata_json ? String(row.metadata_json) : null,
      created_at: String(row.created_at),
    }));

    return { logs, total };
  }

  static async clearAllLogs(): Promise<number> {
    await initDatabase();
    const db = getDb();
    const res = await db.execute('DELETE FROM logs');
    await this.info('system', 'logs', 'Application logs were cleared by administrator.');
    return res.rowsAffected;
  }

  static async pruneOldLogs(days: number): Promise<number> {
    await initDatabase();
    const db = getDb();
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const res = await db.execute({
      sql: 'DELETE FROM logs WHERE timestamp < ?',
      args: [cutoff],
    });
    if (res.rowsAffected > 0) {
      await this.info('system', 'retention', `Pruned ${res.rowsAffected} log entries older than ${days} days.`);
    }
    return res.rowsAffected;
  }
}
