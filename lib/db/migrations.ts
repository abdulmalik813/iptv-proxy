import { Client } from '@libsql/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

export async function runMigrations(db: Client): Promise<void> {
  // 1. Create schema_migrations table
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  // Check applied migrations
  const appliedRows = await db.execute('SELECT version FROM schema_migrations ORDER BY version ASC');
  const appliedVersions = new Set(appliedRows.rows.map((r) => Number(r.version)));

  // Migration 1: Initial Schema
  if (!appliedVersions.has(1)) {
    await db.batch([
      // Users
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      // IPTV Providers
      `CREATE TABLE IF NOT EXISTS iptv_providers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        host TEXT NOT NULL,
        route TEXT UNIQUE NOT NULL,
        upstream_username TEXT NOT NULL,
        upstream_password TEXT NOT NULL,
        local_username TEXT NOT NULL,
        local_password TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        cache_duration_hours INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      // App Settings
      `CREATE TABLE IF NOT EXISTS app_settings (
        id TEXT PRIMARY KEY,
        active_vpn_type TEXT NOT NULL DEFAULT 'off',
        active_vpn_profile_id TEXT,
        vpn_status TEXT NOT NULL DEFAULT 'off',
        vpn_last_error TEXT,
        vpn_connected_at TEXT,
        vpn_public_ip TEXT,
        vpn_country TEXT,
        log_retention_days INTEGER NOT NULL DEFAULT 7,
        initial_setup_completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );`,

      // WireGuard Profiles
      `CREATE TABLE IF NOT EXISTS wireguard_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      // OpenVPN Profiles
      `CREATE TABLE IF NOT EXISTS openvpn_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        username TEXT,
        password TEXT,
        source TEXT NOT NULL DEFAULT 'uploaded',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,

      // Persistent Logs
      `CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        timestamp TEXT NOT NULL,
        level TEXT NOT NULL,
        source TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );`,

      `CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);`,
      `CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);`,
      `CREATE INDEX IF NOT EXISTS idx_logs_source ON logs(source);`,

      // Record migration
      {
        sql: `INSERT INTO schema_migrations (version, name, applied_at) VALUES (1, 'initial_schema', ?);`,
        args: [new Date().toISOString()],
      },
    ]);
  }

  // Ensure default app settings row exists
  const settingsCheck = await db.execute("SELECT id FROM app_settings WHERE id = 'global'");
  if (settingsCheck.rows.length === 0) {
    await db.execute({
      sql: `INSERT INTO app_settings (
        id, active_vpn_type, active_vpn_profile_id, vpn_status, vpn_last_error, 
        vpn_connected_at, vpn_public_ip, vpn_country, log_retention_days, 
        initial_setup_completed, updated_at
      ) VALUES ('global', 'off', NULL, 'off', NULL, NULL, NULL, NULL, 7, 0, ?);`,
      args: [new Date().toISOString()],
    });
  }

  // Check if admin user should be auto-created from env
  const usersCheck = await db.execute('SELECT COUNT(*) as count FROM users');
  const userCount = Number(usersCheck.rows[0]?.count || 0);

  if (userCount === 0) {
    const adminUser = process.env.ADMIN_USERNAME || 'admin';
    const adminPass = process.env.ADMIN_PASSWORD || 'changeme123';
    const passwordHash = await bcrypt.hash(adminPass, 10);
    const now = new Date().toISOString();
    const userId = crypto.randomUUID();

    await db.execute({
      sql: `INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      args: [userId, adminUser, passwordHash, now, now],
    });

    await db.execute({
      sql: `UPDATE app_settings SET initial_setup_completed = 1, updated_at = ? WHERE id = 'global'`,
      args: [now],
    });

    // Write initial log
    await db.execute({
      sql: `INSERT INTO logs (id, timestamp, level, source, category, message, metadata_json, created_at)
            VALUES (?, ?, 'info', 'auth', 'setup', 'Initial administrator account seeded.', ?, ?)`,
      args: [crypto.randomUUID(), now, JSON.stringify({ username: adminUser }), now],
    });
  }
}
