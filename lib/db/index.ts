import { createClient, type Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrations';

let clientInstance: Client | null = null;
let initialized = false;
let initializationPromise: Promise<void> | null = null;

const LATEST_SCHEMA_VERSION = 4;
const MAX_MIGRATION_BACKUPS = 5;

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

function firstCell(result: Awaited<ReturnType<Client['execute']>>): string {
  if (!result.rows.length) return '';
  const row = result.rows[0] as Record<string, unknown>;
  const value = Object.values(row)[0];
  return value === null || value === undefined ? '' : String(value);
}

async function assertDatabaseHealthy(db: Client, label: string): Promise<void> {
  const result = await db.execute('PRAGMA quick_check;');
  const status = firstCell(result);
  if (status.toLowerCase() !== 'ok') {
    throw new Error(`${label} SQLite quick_check failed: ${status || 'no result'}`);
  }
}

async function currentSchemaVersion(db: Client): Promise<number> {
  const table = await db.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations' LIMIT 1");
  if (!table.rows.length) return 0;
  const result = await db.execute('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations');
  return Number(result.rows[0]?.version || 0);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function pruneMigrationBackups(backupDir: string, prefix: string): void {
  const candidates = fs.readdirSync(backupDir)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.db'))
    .map((name) => {
      const fullPath = path.join(backupDir, name);
      return { fullPath, mtimeMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const old of candidates.slice(MAX_MIGRATION_BACKUPS)) {
    try {
      fs.rmSync(old.fullPath, { force: true });
    } catch (error) {
      console.warn('Unable to prune old migration backup:', error);
    }
  }
}

async function backupBeforePendingMigration(db: Client, dbPath: string, databaseExisted: boolean): Promise<void> {
  if (!databaseExisted) return;
  const currentVersion = await currentSchemaVersion(db);
  if (currentVersion >= LATEST_SCHEMA_VERSION) return;

  await assertDatabaseHealthy(db, 'Source');
  await db.execute('PRAGMA wal_checkpoint(FULL);');

  const backupDir = path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(backupDir, 0o700);
  } catch {
    // Bind-mounted filesystems may ignore POSIX modes.
  }

  const stem = path.basename(dbPath).replace(/\.db$/i, '') || 'iptv-proxy';
  const prefix = `${stem}.pre-migration-`;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(
    backupDir,
    `${prefix}v${currentVersion}-to-v${LATEST_SCHEMA_VERSION}.${stamp}.${process.pid}.db`,
  );

  await db.execute(`VACUUM INTO ${sqlStringLiteral(backupPath)};`);
  try {
    fs.chmodSync(backupPath, 0o600);
  } catch {
    // Bind-mounted filesystems may ignore POSIX modes.
  }

  const backupClient = createClient({ url: `file:${backupPath}` });
  try {
    await assertDatabaseHealthy(backupClient, 'Migration backup');
  } catch (error) {
    try {
      fs.rmSync(backupPath, { force: true });
    } catch {
      // Preserve the original verification error.
    }
    throw error;
  } finally {
    backupClient.close();
  }

  pruneMigrationBackups(backupDir, prefix);
  console.info(`Verified pre-migration database backup: ${backupPath}`);
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
    const dbPath = resolveDatabasePath();
    let databaseExisted = false;
    try {
      databaseExisted = fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0;
    } catch {
      databaseExisted = false;
    }

    const db = getDb();

    await db.execute('PRAGMA busy_timeout = 5000;');
    await db.execute('PRAGMA foreign_keys = ON;');
    await db.execute('PRAGMA journal_mode = WAL;');
    await db.execute('PRAGMA synchronous = NORMAL;');
    await db.execute('PRAGMA wal_autocheckpoint = 1000;');

    await backupBeforePendingMigration(db, dbPath, databaseExisted);
    await runMigrations(db);

    try {
      if (fs.existsSync(/*turbopackIgnore: true*/ dbPath)) fs.chmodSync(dbPath, 0o600);
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
