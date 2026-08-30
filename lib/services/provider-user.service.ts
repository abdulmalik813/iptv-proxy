import crypto from 'crypto';
import { getDb, initDatabase } from '../db';
import type { IptvProviderUser } from '../db/schema';
import { LogService } from './log.service';

const MASK = '••••••••';

export interface CreateProviderUserInput {
  username: string;
  password: string;
  enabled?: boolean;
}

export interface UpdateProviderUserInput {
  username?: string;
  password?: string;
  enabled?: boolean;
}

function rowToUser(row: Record<string, unknown>, includeSensitive: boolean): IptvProviderUser {
  return {
    id: String(row.id),
    provider_id: String(row.provider_id),
    username: String(row.username),
    password: includeSensitive ? String(row.password) : MASK,
    enabled: Number(row.enabled ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

async function ensureProvider(providerId: string): Promise<{ id: string; name: string }> {
  const result = await getDb().execute({
    sql: 'SELECT id, name FROM iptv_providers WHERE id = ? LIMIT 1',
    args: [providerId],
  });
  if (!result.rows.length) throw new Error('Provider not found.');
  return { id: String(result.rows[0].id), name: String(result.rows[0].name) };
}

async function syncLegacyCredentials(providerId: string): Promise<void> {
  const result = await getDb().execute({
    sql: `SELECT username, password FROM provider_users
          WHERE provider_id = ?
          ORDER BY enabled DESC, created_at ASC, id ASC
          LIMIT 1`,
    args: [providerId],
  });
  const username = result.rows.length ? String(result.rows[0].username) : '';
  const password = result.rows.length ? String(result.rows[0].password) : '';
  await getDb().execute({
    sql: 'UPDATE iptv_providers SET local_username = ?, local_password = ?, updated_at = ? WHERE id = ?',
    args: [username, password, new Date().toISOString(), providerId],
  });
}

export class ProviderUserService {
  static async getUsers(providerId: string, includeSensitive = false): Promise<IptvProviderUser[]> {
    await initDatabase();
    await ensureProvider(providerId);
    const result = await getDb().execute({
      sql: 'SELECT * FROM provider_users WHERE provider_id = ? ORDER BY enabled DESC, created_at ASC, username ASC',
      args: [providerId],
    });
    return result.rows.map((row) => rowToUser(row as unknown as Record<string, unknown>, includeSensitive));
  }

  static async getUsersForInternalRegistry(providerId: string): Promise<IptvProviderUser[]> {
    return this.getUsers(providerId, true);
  }

  static async createUser(providerId: string, input: CreateProviderUserInput): Promise<IptvProviderUser> {
    await initDatabase();
    const provider = await ensureProvider(providerId);
    const username = input.username.trim();
    const password = input.password;
    if (!username) throw new Error('Username is required.');
    if (username.length > 512) throw new Error('Username is too long.');
    if (!password) throw new Error('Password is required.');
    if (password.length > 4096) throw new Error('Password is too long.');

    const duplicate = await getDb().execute({
      sql: 'SELECT id FROM provider_users WHERE provider_id = ? AND username = ? LIMIT 1',
      args: [providerId, username],
    });
    if (duplicate.rows.length) throw new Error(`User "${username}" already exists for this provider.`);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    await getDb().execute({
      sql: `INSERT INTO provider_users (id, provider_id, username, password, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [id, providerId, username, password, input.enabled === false ? 0 : 1, now, now],
    });
    await syncLegacyCredentials(providerId);
    await LogService.info('provider', 'user_creation', `Added client user "${username}" to provider "${provider.name}".`, {
      provider_id: providerId,
      provider_user_id: id,
      username,
    });
    const created = await this.getUser(providerId, id, false);
    if (!created) throw new Error('Provider user was created but could not be reloaded.');
    return created;
  }

  static async getUser(providerId: string, userId: string, includeSensitive = false): Promise<IptvProviderUser | null> {
    await initDatabase();
    const result = await getDb().execute({
      sql: 'SELECT * FROM provider_users WHERE provider_id = ? AND id = ? LIMIT 1',
      args: [providerId, userId],
    });
    if (!result.rows.length) return null;
    return rowToUser(result.rows[0] as unknown as Record<string, unknown>, includeSensitive);
  }

  static async updateUser(providerId: string, userId: string, input: UpdateProviderUserInput): Promise<IptvProviderUser> {
    await initDatabase();
    const provider = await ensureProvider(providerId);
    const existing = await this.getUser(providerId, userId, true);
    if (!existing) throw new Error('Provider user not found.');

    const username = input.username !== undefined ? input.username.trim() : existing.username;
    if (!username) throw new Error('Username cannot be empty.');
    if (username.length > 512) throw new Error('Username is too long.');
    const password = input.password !== undefined && input.password !== '' ? input.password : existing.password;
    if (!password) throw new Error('Password cannot be empty.');
    if (password.length > 4096) throw new Error('Password is too long.');
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

    const duplicate = await getDb().execute({
      sql: 'SELECT id FROM provider_users WHERE provider_id = ? AND username = ? AND id != ? LIMIT 1',
      args: [providerId, username, userId],
    });
    if (duplicate.rows.length) throw new Error(`User "${username}" already exists for this provider.`);

    await getDb().execute({
      sql: 'UPDATE provider_users SET username = ?, password = ?, enabled = ?, updated_at = ? WHERE provider_id = ? AND id = ?',
      args: [username, password, enabled, new Date().toISOString(), providerId, userId],
    });
    await syncLegacyCredentials(providerId);
    await LogService.info('provider', 'user_update', `Updated client user "${username}" for provider "${provider.name}".`, {
      provider_id: providerId,
      provider_user_id: userId,
      username,
      enabled: Boolean(enabled),
      password_changed: input.password !== undefined && input.password !== '',
    });
    const updated = await this.getUser(providerId, userId, false);
    if (!updated) throw new Error('Provider user was updated but could not be reloaded.');
    return updated;
  }

  static async deleteUser(providerId: string, userId: string): Promise<void> {
    await initDatabase();
    const provider = await ensureProvider(providerId);
    const existing = await this.getUser(providerId, userId, false);
    if (!existing) throw new Error('Provider user not found.');
    await getDb().execute({
      sql: 'DELETE FROM provider_users WHERE provider_id = ? AND id = ?',
      args: [providerId, userId],
    });
    await syncLegacyCredentials(providerId);
    await LogService.warn('provider', 'user_deletion', `Removed client user "${existing.username}" from provider "${provider.name}".`, {
      provider_id: providerId,
      provider_user_id: userId,
      username: existing.username,
    });
  }

  static async upsertPrimaryUser(providerId: string, username: string, password?: string): Promise<void> {
    await initDatabase();
    const users = await this.getUsers(providerId, true);
    const primary = users[0];
    if (primary) {
      await this.updateUser(providerId, primary.id, { username, password });
      return;
    }
    if (!password) throw new Error('A password is required for the first provider user.');
    await this.createUser(providerId, { username, password, enabled: true });
  }
}
