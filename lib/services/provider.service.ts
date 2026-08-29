import crypto from 'crypto';
import { getDb, initDatabase } from '../db';
import { IptvProvider } from '../db/schema';
import { LogService } from './log.service';

const RESERVED_ROUTES = new Set([
  'api',
  'admin',
  'login',
  'vpn',
  'logs',
  'dashboard',
  'settings',
  'system',
  '_next',
  'public',
  'favicon.ico',
  'player_api.php',
  'get.php',
  'xmltv.php',
  'live',
  'movie',
  'series',
]);

export function normalizeRoute(route: string): string {
  let cleaned = route.trim().toLowerCase();
  // Strip leading and trailing slashes
  cleaned = cleaned.replace(/^\/+|\/+$/g, '');
  // Replace spaces and special characters with hyphens
  cleaned = cleaned.replace(/[^a-z0-9_-]/g, '-');
  return cleaned;
}

export function isRouteReserved(route: string): boolean {
  const normalized = normalizeRoute(route);
  return RESERVED_ROUTES.has(normalized);
}

export interface CreateProviderInput {
  name: string;
  host: string;
  route: string;
  upstream_username: string;
  upstream_password: string;
  local_username: string;
  local_password: string;
  is_default?: boolean;
  cache_duration_hours?: number;
  enabled?: boolean;
}

export interface UpdateProviderInput {
  name?: string;
  host?: string;
  route?: string;
  upstream_username?: string;
  upstream_password?: string;
  local_username?: string;
  local_password?: string;
  is_default?: boolean;
  cache_duration_hours?: number;
  enabled?: boolean;
}

export class ProviderService {
  static async getAllProviders(includeSensitive = false): Promise<IptvProvider[]> {
    await initDatabase();
    const db = getDb();

    const res = await db.execute('SELECT * FROM iptv_providers ORDER BY is_default DESC, name ASC');

    return res.rows.map((row) => {
      const p: IptvProvider = {
        id: String(row.id),
        name: String(row.name),
        host: String(row.host),
        route: String(row.route),
        upstream_username: String(row.upstream_username),
        upstream_password: includeSensitive ? String(row.upstream_password) : '••••••••',
        local_username: String(row.local_username),
        local_password: includeSensitive ? String(row.local_password) : '••••••••',
        is_default: Number(row.is_default || 0),
        cache_duration_hours: Number(row.cache_duration_hours ?? 1),
        enabled: Number(row.enabled ?? 1),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      };
      return p;
    });
  }

  static async getProviderById(id: string, includeSensitive = false): Promise<IptvProvider | null> {
    await initDatabase();
    const db = getDb();

    const res = await db.execute({
      sql: 'SELECT * FROM iptv_providers WHERE id = ?',
      args: [id],
    });

    if (res.rows.length === 0) return null;
    const row = res.rows[0];

    return {
      id: String(row.id),
      name: String(row.name),
      host: String(row.host),
      route: String(row.route),
      upstream_username: String(row.upstream_username),
      upstream_password: includeSensitive ? String(row.upstream_password) : '••••••••',
      local_username: String(row.local_username),
      local_password: includeSensitive ? String(row.local_password) : '••••••••',
      is_default: Number(row.is_default || 0),
      cache_duration_hours: Number(row.cache_duration_hours ?? 1),
      enabled: Number(row.enabled ?? 1),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  static async createProvider(input: CreateProviderInput): Promise<IptvProvider> {
    await initDatabase();
    const db = getDb();

    const route = normalizeRoute(input.route);
    if (!route) {
      throw new Error('Provider route is required and must be alphanumeric.');
    }

    if (isRouteReserved(route)) {
      throw new Error(`Route "${route}" is reserved by the system and cannot be used.`);
    }

    // Check unique route
    const existing = await db.execute({
      sql: 'SELECT id FROM iptv_providers WHERE route = ?',
      args: [route],
    });
    if (existing.rows.length > 0) {
      throw new Error(`Route "${route}" is already in use by another provider.`);
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isDefault = input.is_default ? 1 : 0;
    const cacheHours = Math.max(0, Math.min(24, input.cache_duration_hours ?? 1));
    const enabled = input.enabled !== false ? 1 : 0;

    const batchStatements = [];

    // If this provider is default, unset previous default atomically
    if (isDefault === 1) {
      batchStatements.push({
        sql: 'UPDATE iptv_providers SET is_default = 0, updated_at = ? WHERE is_default = 1',
        args: [now],
      });
    }

    batchStatements.push({
      sql: `INSERT INTO iptv_providers (
        id, name, host, route, upstream_username, upstream_password,
        local_username, local_password, is_default, cache_duration_hours,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        input.name.trim(),
        input.host.trim().replace(/\/+$/, ''),
        route,
        input.upstream_username.trim(),
        input.upstream_password,
        input.local_username.trim(),
        input.local_password,
        isDefault,
        cacheHours,
        enabled,
        now,
        now,
      ],
    });

    await db.batch(batchStatements);

    await LogService.info(
      'provider',
      'creation',
      `Created provider "${input.name.trim()}" on route "/${route}".`,
      { provider_id: id, is_default: isDefault, cache_duration_hours: cacheHours }
    );

    return (await this.getProviderById(id, true))!;
  }

  static async updateProvider(id: string, input: UpdateProviderInput): Promise<IptvProvider> {
    await initDatabase();
    const db = getDb();

    const existing = await this.getProviderById(id, true);
    if (!existing) {
      throw new Error('Provider not found');
    }

    const now = new Date().toISOString();
    const batchStatements = [];

    let route = existing.route;
    if (input.route !== undefined) {
      route = normalizeRoute(input.route);
      if (!route) {
        throw new Error('Provider route cannot be empty.');
      }
      if (isRouteReserved(route)) {
        throw new Error(`Route "${route}" is reserved.`);
      }
      if (route !== existing.route) {
        const check = await db.execute({
          sql: 'SELECT id FROM iptv_providers WHERE route = ? AND id != ?',
          args: [route, id],
        });
        if (check.rows.length > 0) {
          throw new Error(`Route "${route}" is already taken by another provider.`);
        }
      }
    }

    let isDefault = existing.is_default;
    if (input.is_default !== undefined) {
      isDefault = input.is_default ? 1 : 0;
      if (isDefault === 1) {
        batchStatements.push({
          sql: 'UPDATE iptv_providers SET is_default = 0, updated_at = ? WHERE is_default = 1 AND id != ?',
          args: [now, id],
        });
      }
    }

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    const host = input.host !== undefined ? input.host.trim().replace(/\/+$/, '') : existing.host;
    const upstream_username = input.upstream_username !== undefined ? input.upstream_username.trim() : existing.upstream_username;
    const upstream_password = input.upstream_password !== undefined && input.upstream_password !== '••••••••'
      ? input.upstream_password
      : existing.upstream_password;
    const local_username = input.local_username !== undefined ? input.local_username.trim() : existing.local_username;
    const local_password = input.local_password !== undefined && input.local_password !== '••••••••'
      ? input.local_password
      : existing.local_password;
    const cache_duration_hours = input.cache_duration_hours !== undefined
      ? Math.max(0, Math.min(24, input.cache_duration_hours))
      : existing.cache_duration_hours;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

    batchStatements.push({
      sql: `UPDATE iptv_providers SET
        name = ?, host = ?, route = ?, upstream_username = ?, upstream_password = ?,
        local_username = ?, local_password = ?, is_default = ?, cache_duration_hours = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?`,
      args: [
        name,
        host,
        route,
        upstream_username,
        upstream_password,
        local_username,
        local_password,
        isDefault,
        cache_duration_hours,
        enabled,
        now,
        id,
      ],
    });

    await db.batch(batchStatements);

    await LogService.info('provider', 'update', `Updated provider "${name}" (route: "/${route}").`, {
      provider_id: id,
      is_default: isDefault,
    });

    return (await this.getProviderById(id, true))!;
  }

  static async setDefaultProvider(id: string): Promise<IptvProvider> {
    await initDatabase();
    const db = getDb();
    const now = new Date().toISOString();

    const provider = await this.getProviderById(id);
    if (!provider) {
      throw new Error('Provider not found');
    }

    // Atomically unset all other defaults and set this provider
    await db.batch([
      {
        sql: 'UPDATE iptv_providers SET is_default = 0, updated_at = ? WHERE is_default = 1',
        args: [now],
      },
      {
        sql: 'UPDATE iptv_providers SET is_default = 1, updated_at = ? WHERE id = ?',
        args: [now, id],
      },
    ]);

    await LogService.info(
      'provider',
      'default',
      `Set provider "${provider.name}" (route: "/${provider.route}") as global default.`,
      { provider_id: id }
    );

    return (await this.getProviderById(id))!;
  }

  static async deleteProvider(id: string): Promise<void> {
    await initDatabase();
    const db = getDb();

    const provider = await this.getProviderById(id);
    if (!provider) {
      throw new Error('Provider not found');
    }

    await db.execute({
      sql: 'DELETE FROM iptv_providers WHERE id = ?',
      args: [id],
    });

    await LogService.warn(
      'provider',
      'deletion',
      `Deleted provider "${provider.name}" (route: "/${provider.route}").`,
      { provider_id: id }
    );
  }

  /**
   * Route Resolution Engine:
   * 1. Check whether the first URL path segment matches a configured provider route.
   * 2. If yes, use that provider.
   * 3. Otherwise use the default provider.
   * 4. If no matching route and no default provider exist, return null.
   */
  static async resolveProviderByPath(requestPath: string): Promise<{
    provider: IptvProvider | null;
    matchedBy: 'route' | 'default' | 'none';
    remainingPath: string;
    resolvedTargetUrl: string | null;
  }> {
    await initDatabase();
    const db = getDb();

    // Clean path
    const trimmed = requestPath.trim().replace(/^\/+/, '');
    const segments = trimmed.split('/');
    const firstSegment = segments[0] ? normalizeRoute(segments[0]) : '';

    // 1. Try matching first segment as provider route
    if (firstSegment) {
      const matchRes = await db.execute({
        sql: 'SELECT * FROM iptv_providers WHERE route = ? AND enabled = 1',
        args: [firstSegment],
      });

      if (matchRes.rows.length > 0) {
        const row = matchRes.rows[0];
        const provider: IptvProvider = {
          id: String(row.id),
          name: String(row.name),
          host: String(row.host),
          route: String(row.route),
          upstream_username: String(row.upstream_username),
          upstream_password: String(row.upstream_password),
          local_username: String(row.local_username),
          local_password: String(row.local_password),
          is_default: Number(row.is_default || 0),
          cache_duration_hours: Number(row.cache_duration_hours ?? 1),
          enabled: Number(row.enabled ?? 1),
          created_at: String(row.created_at),
          updated_at: String(row.updated_at),
        };

        const remaining = segments.slice(1).join('/');
        const resolvedTargetUrl = `${provider.host}/${remaining}`;

        return {
          provider,
          matchedBy: 'route',
          remainingPath: `/${remaining}`,
          resolvedTargetUrl,
        };
      }
    }

    // 2. Try default provider
    const defaultRes = await db.execute('SELECT * FROM iptv_providers WHERE is_default = 1 AND enabled = 1');
    if (defaultRes.rows.length > 0) {
      const row = defaultRes.rows[0];
      const provider: IptvProvider = {
        id: String(row.id),
        name: String(row.name),
        host: String(row.host),
        route: String(row.route),
        upstream_username: String(row.upstream_username),
        upstream_password: String(row.upstream_password),
        local_username: String(row.local_username),
        local_password: String(row.local_password),
        is_default: Number(row.is_default || 0),
        cache_duration_hours: Number(row.cache_duration_hours ?? 1),
        enabled: Number(row.enabled ?? 1),
        created_at: String(row.created_at),
        updated_at: String(row.updated_at),
      };

      const resolvedTargetUrl = `${provider.host}/${trimmed}`;

      return {
        provider,
        matchedBy: 'default',
        remainingPath: `/${trimmed}`,
        resolvedTargetUrl,
      };
    }

    return {
      provider: null,
      matchedBy: 'none',
      remainingPath: `/${trimmed}`,
      resolvedTargetUrl: null,
    };
  }
}
