import { createClient, Client } from '@libsql/client';
import fs from 'fs';
import path from 'path';
import { runMigrations } from './migrations';

let clientInstance: Client | null = null;
let isInitialized = false;

function resolveDatabasePath(): string {
  if (process.env.DATABASE_PATH) {
    return process.env.DATABASE_PATH;
  }

  // Check if /data exists and is writable (e.g. in Docker environment with volume)
  try {
    if (fs.existsSync('/data')) {
      return '/data/iptv-proxy.db';
    }
  } catch {
    // Ignore and fallback
  }

  // Local fallback
  const localDir = path.join(process.cwd(), 'data');
  return path.join(localDir, 'iptv-proxy.db');
}

export function getDb(): Client {
  if (!clientInstance) {
    const dbPath = resolveDatabasePath();
    const dbDir = path.dirname(dbPath);

    if (!fs.existsSync(dbDir)) {
      try {
        fs.mkdirSync(dbDir, { recursive: true });
      } catch (err) {
        console.error('Failed to create database directory:', err);
      }
    }

    clientInstance = createClient({
      url: `file:${dbPath}`,
    });
  }

  return clientInstance;
}

export async function initDatabase(): Promise<void> {
  if (isInitialized) return;

  const db = getDb();

  // Enable WAL mode & busy timeout for SQLite concurrency
  try {
    await db.execute('PRAGMA journal_mode = WAL;');
    await db.execute('PRAGMA busy_timeout = 5000;');
    await db.execute('PRAGMA foreign_keys = ON;');
  } catch (err) {
    console.warn('Notice: PRAGMA journal_mode setting:', err);
  }

  await runMigrations(db);
  isInitialized = true;
}
