import type { Client } from '@libsql/client';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { hashProviderPassword, isProviderPasswordHash } from '../auth/provider-password';

async function migrationApplied(db: Client, version: number): Promise<boolean> {
  const result = await db.execute({
    sql: 'SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1',
    args: [version],
  });
  return result.rows.length > 0;
}

async function recordMigration(db: Client, version: number, name: string): Promise<void> {
  await db.execute({
    sql: 'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
    args: [version, name, new Date().toISOString()],
  });
}

async function columnExists(db: Client, table: string, column: string): Promise<boolean> {
  const result = await db.execute(`PRAGMA table_info(${table});`);
  return result.rows.some((row) => String(row.name) === column);
}

export async function runMigrations(db: Client): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);

  if (!(await migrationApplied(db, 1))) {
    await db.batch([
      `CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
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
      `CREATE TABLE IF NOT EXISTS wireguard_profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );`,
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
      'CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp DESC);',
      'CREATE INDEX IF NOT EXISTS idx_logs_level ON logs(level);',
      'CREATE INDEX IF NOT EXISTS idx_logs_source ON logs(source);',
    ]);
    await recordMigration(db, 1, 'initial_schema');
  }

  if (!(await migrationApplied(db, 2))) {
    if (!(await columnExists(db, 'app_settings', 'active_vpn_label'))) {
      await db.execute('ALTER TABLE app_settings ADD COLUMN active_vpn_label TEXT;');
    }

    await db.execute(`
      UPDATE iptv_providers
      SET is_default = 0
      WHERE is_default = 1
        AND id NOT IN (
          SELECT id FROM iptv_providers
          WHERE is_default = 1
          ORDER BY updated_at DESC, id ASC
          LIMIT 1
        );
    `);

    await db.batch([
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_iptv_single_default ON iptv_providers(is_default) WHERE is_default = 1;',
      'CREATE INDEX IF NOT EXISTS idx_iptv_enabled ON iptv_providers(enabled);',
      'CREATE INDEX IF NOT EXISTS idx_logs_category ON logs(category);',
      `CREATE TRIGGER IF NOT EXISTS trg_iptv_cache_insert
       BEFORE INSERT ON iptv_providers
       WHEN NEW.cache_duration_hours < 0 OR NEW.cache_duration_hours > 24
       BEGIN
         SELECT RAISE(ABORT, 'cache_duration_hours must be between 0 and 24');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS trg_iptv_cache_update
       BEFORE UPDATE OF cache_duration_hours ON iptv_providers
       WHEN NEW.cache_duration_hours < 0 OR NEW.cache_duration_hours > 24
       BEGIN
         SELECT RAISE(ABORT, 'cache_duration_hours must be between 0 and 24');
       END;`,
    ]);
    await recordMigration(db, 2, 'vpn_label_and_integrity_indexes');
  }

  if (!(await migrationApplied(db, 3))) {
    if (!(await columnExists(db, 'users', 'session_version'))) {
      await db.execute('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 1;');
    }

    await db.batch([
      `CREATE TABLE IF NOT EXISTS provider_users (
        id TEXT PRIMARY KEY,
        provider_id TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (provider_id) REFERENCES iptv_providers(id) ON DELETE CASCADE,
        UNIQUE (provider_id, username)
      );`,
      'CREATE INDEX IF NOT EXISTS idx_provider_users_provider ON provider_users(provider_id, enabled, created_at);',
    ]);

    const providerRows = await db.execute(
      'SELECT id, local_username, local_password, created_at, updated_at FROM iptv_providers',
    );
    for (const row of providerRows.rows) {
      const providerId = String(row.id);
      const username = String(row.local_username || '').trim();
      const password = String(row.local_password || '');
      if (!username || !password) continue;
      const existing = await db.execute({
        sql: 'SELECT id FROM provider_users WHERE provider_id = ? AND username = ? LIMIT 1',
        args: [providerId, username],
      });
      if (existing.rows.length) continue;
      await db.execute({
        sql: `INSERT INTO provider_users (id, provider_id, username, password, enabled, created_at, updated_at)
              VALUES (?, ?, ?, ?, 1, ?, ?)`,
        args: [
          crypto.randomUUID(),
          providerId,
          username,
          password,
          String(row.created_at || new Date().toISOString()),
          String(row.updated_at || new Date().toISOString()),
        ],
      });
    }

    await recordMigration(db, 3, 'provider_users_and_session_version');
  }

  if (!(await migrationApplied(db, 4))) {
    if (!(await columnExists(db, 'provider_users', 'password_hash'))) {
      await db.execute('ALTER TABLE provider_users ADD COLUMN password_hash TEXT;');
    }

    const userRows = await db.execute('SELECT id, password, password_hash FROM provider_users');
    for (const row of userRows.rows) {
      const id = String(row.id);
      const plaintext = String(row.password || '');
      const existingHash = String(row.password_hash || '');
      const passwordHash = isProviderPasswordHash(existingHash)
        ? existingHash
        : plaintext
          ? hashProviderPassword(plaintext)
          : '';
      if (passwordHash) {
        await db.execute({
          sql: 'UPDATE provider_users SET password_hash = ?, password = ? WHERE id = ?',
          args: [passwordHash, '', id],
        });
      }
    }

    await db.execute("UPDATE iptv_providers SET local_password = '' WHERE local_password != ''");
    await db.batch([
      `CREATE TRIGGER IF NOT EXISTS trg_provider_users_hash_insert
       BEFORE INSERT ON provider_users
       WHEN NEW.password_hash IS NULL OR trim(NEW.password_hash) = ''
       BEGIN
         SELECT RAISE(ABORT, 'provider user password_hash is required');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS trg_provider_users_hash_update
       BEFORE UPDATE OF password_hash ON provider_users
       WHEN NEW.password_hash IS NULL OR trim(NEW.password_hash) = ''
       BEGIN
         SELECT RAISE(ABORT, 'provider user password_hash is required');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS trg_provider_users_plaintext_insert
       BEFORE INSERT ON provider_users
       WHEN NEW.password != ''
       BEGIN
         SELECT RAISE(ABORT, 'provider user plaintext passwords are not allowed');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS trg_provider_users_plaintext_update
       BEFORE UPDATE OF password ON provider_users
       WHEN NEW.password != ''
       BEGIN
         SELECT RAISE(ABORT, 'provider user plaintext passwords are not allowed');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS trg_provider_local_password_insert
       BEFORE INSERT ON iptv_providers
       WHEN NEW.local_password != ''
       BEGIN
         SELECT RAISE(ABORT, 'provider local plaintext passwords are not allowed');
       END;`,
      `CREATE TRIGGER IF NOT EXISTS trg_provider_local_password_update
       BEFORE UPDATE OF local_password ON iptv_providers
       WHEN NEW.local_password != ''
       BEGIN
         SELECT RAISE(ABORT, 'provider local plaintext passwords are not allowed');
       END;`,
    ]);

    await recordMigration(db, 4, 'hash_provider_client_passwords');
  }

  const now = new Date().toISOString();
  const settingsCheck = await db.execute("SELECT id FROM app_settings WHERE id = 'global'");
  if (settingsCheck.rows.length === 0) {
    await db.execute({
      sql: `INSERT INTO app_settings (
        id, active_vpn_type, active_vpn_profile_id, active_vpn_label, vpn_status,
        vpn_last_error, vpn_connected_at, vpn_public_ip, vpn_country,
        log_retention_days, initial_setup_completed, updated_at
      ) VALUES ('global', 'off', NULL, NULL, 'off', NULL, NULL, NULL, NULL, 7, 0, ?);`,
      args: [now],
    });
  }

  const usersCheck = await db.execute('SELECT COUNT(*) AS count FROM users');
  const userCount = Number(usersCheck.rows[0]?.count || 0);

  if (userCount === 0) {
    const configuredPassword =
      process.env.INITIAL_ADMIN_PASSWORD?.trim() || process.env.ADMIN_PASSWORD?.trim() || '';
    const configuredUsername =
      process.env.INITIAL_ADMIN_USERNAME?.trim() || process.env.ADMIN_USERNAME?.trim() || 'admin';

    if (configuredPassword) {
      if (configuredPassword.length < 8) {
        throw new Error('INITIAL_ADMIN_PASSWORD must contain at least 8 characters when provided.');
      }

      const passwordHash = await bcrypt.hash(configuredPassword, 12);
      const userId = crypto.randomUUID();
      await db.execute({
        sql: 'INSERT INTO users (id, username, password_hash, session_version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)',
        args: [userId, configuredUsername, passwordHash, now, now],
      });
      await db.execute({
        sql: "UPDATE app_settings SET initial_setup_completed = 1, updated_at = ? WHERE id = 'global'",
        args: [now],
      });
      await db.execute({
        sql: `INSERT INTO logs (id, timestamp, level, source, category, message, metadata_json, created_at)
              VALUES (?, ?, 'info', 'auth', 'setup', 'Initial administrator account seeded from environment.', ?, ?)`,
        args: [crypto.randomUUID(), now, JSON.stringify({ username: configuredUsername }), now],
      });
    }
  } else {
    await db.execute({
      sql: "UPDATE app_settings SET initial_setup_completed = 1, updated_at = ? WHERE id = 'global' AND initial_setup_completed = 0",
      args: [now],
    });
  }
}
