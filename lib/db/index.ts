import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrations';

let clientInstance: Client | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

declare global {
  var __iptvLogRetentionTimer: ReturnType<typeof setInterval> | undefined;
}

function resolveDatabasePath(): string {
  const configured = process.env.DATABASE_PATH?.trim();
  if (configured) return configured;

  try {
    if (fs.existsSync('/data')) return '/data/iptv-proxy.db';
  } catch {
    // Fall through to local development path.
  }

  return path.join(process.cwd(), 'data', 'iptv-proxy.db');
}

function prepareDatabaseDirectory(dbPath: string): void {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some bind-mounted filesystems do not implement POSIX modes.
  }
}

export function getDatabasePath(): string {
  return resolveDatabasePath();
}

export function getDb(): Client {
  if (!clientInstance) {
    const dbPath = resolveDatabasePath();
    prepareDatabaseDirectory(dbPath);
    clientInstance = createClient({ url: `file:${dbPath}` });
  }
  return clientInstance;
}

async function pruneLogsWithoutRecursion(db: Client): Promise<void> {
  try {
    const setting = await db.execute("SELECT log_retention_days FROM app_settings WHERE id = 'global'");
    const days = Math.max(1, Math.min(365, Number(setting.rows[0]?.log_retention_days || 7)));
    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
    await db.execute({ sql: 'DELETE FROM logs WHERE timestamp < ?', args: [cutoff] });
  } catch (error) {
    console.warn('Log retention housekeeping failed:', error);
  }
}

function startBackgroundHousekeeping(db: Client): void {
  if (global.__iptvLogRetentionTimer) return;

  void pruneLogsWithoutRecursion(db);
  const timer = setInterval(() => {
    void pruneLogsWithoutRecursion(db);
  }, 6 * 60 * 60 * 1000);
  timer.unref?.();
  global.__iptvLogRetentionTimer = timer;
}

export async function initDatabase(): Promise<void> {
  if (initialized) return;
  if (initializationPromise) return initializationPromise;

  initializationPromise = (async () => {
    const db = getDb();

    await db.execute('PRAGMA busy_timeout = 5000;');
    await db.execute('PRAGMA foreign_keys = ON;');
    await db.execute('PRAGMA journal_mode = WAL;');
    await db.execute('PRAGMA synchronous = NORMAL;');
    await db.execute('PRAGMA wal_autocheckpoint = 1000;');

    await runMigrations(db);

    const dbPath = resolveDatabasePath();
    try {
      if (fs.existsSync(dbPath)) fs.chmodSync(dbPath, 0o600);
    } catch {
      // Docker Desktop/Windows bind mounts may ignore chmod.
    }

    initialized = true;
    startBackgroundHousekeeping(db);
  })();

  try {
    await initializationPromise;
  } catch (error) {
    initializationPromise = null;
    throw error;
  }
}
