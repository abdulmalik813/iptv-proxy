import crypto from 'crypto';
import { getDb, initDatabase } from '../db';
import { IptvProvider } from '../db/schema';
import { LogService } from './log.service';

const MASK = '••••••••';
const RESERVED_ROUTES = new Set([
  'api',
  'admin',
  'login',
  'vpn',
  'logs',
  'dashboard',
  'settings',
  'system',
  'health',
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
  return route
    .trim()
    .toLowerCase()
    .replace(/^\/+|\/+$/g, '')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

export function isRouteReserved(route: string): boolean {
  return RESERVED_ROUTES.has(normalizeRoute(route));
}

function normalizeHost(host: string): string {
  const candidate = host.trim();
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('Provider host must be a valid absolute HTTP or HTTPS URL.');
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Provider host must use http:// or https://.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Do not embed credentials in the provider host URL.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Provider host must not contain query parameters or fragments.');
  }

  return candidate.replace(/\/+$/, '');
}

function rowToProvider(row: Record<string, unknown>, includeSensitive: boolean): IptvProvider {
  return {
    id: String(row.id),
    name: String(row.name),
    host: String(row.host),
    route: String(row.route),
    upstream_username: String(row.upstream_username),
    upstream_password: includeSensitive ? String(row.upstream_password) : MASK,
    local_username: String(row.local_username),
    local_password: includeSensitive ? String(row.local_password) : MASK,
    is_default: Number(row.is_default || 0),
    cache_duration_hours: Number(row.cache_duration_hours ?? 1),
    enabled: Number(row.enabled ?? 1),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
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
  static toPublicProvider(provider: IptvProvider): IptvProvider {
    return {
      ...provider,
      upstream_password: MASK,
      local_password: MASK,
    };
  }

  static async getAllProviders(includeSensitive = false): Promise<IptvProvider[]> {
    await initDatabase();
    const res = await getDb().execute('SELECT * FROM iptv_providers ORDER BY is_default DESC, name ASC');
    return res.rows.map((row) => rowToProvider(row as unknown as Record<string, unknown>, includeSensitive));
  }

  static async getProviderById(id: string, includeSensitive = false): Promise<IptvProvider | null> {
    await initDatabase();
    const res = await getDb().execute({ sql: 'SELECT * FROM iptv_providers WHERE id = ?', args: [id] });
    if (!res.rows.length) return null;
    return rowToProvider(res.rows[0] as unknown as Record<string, unknown>, includeSensitive);
  }

  static async createProvider(input: CreateProviderInput): Promise<IptvProvider> {
    await initDatabase();
    const db = getDb();

    const name = input.name.trim();
    const route = normalizeRoute(input.route);
    const host = normalizeHost(input.host);
    if (!name) throw new Error('Provider name is required.');
    if (!route) throw new Error('Provider route is required and must contain letters or numbers.');
    if (isRouteReserved(route)) throw new Error(`Route "${route}" is reserved by the system.`);

    const routeCheck = await db.execute({ sql: 'SELECT id FROM iptv_providers WHERE route = ?', args: [route] });
    if (routeCheck.rows.length) throw new Error(`Route "${route}" is already in use.`);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const isDefault = input.is_default ? 1 : 0;
    const cacheHours = Math.max(0, Math.min(24, Math.trunc(input.cache_duration_hours ?? 1)));
    const enabled = input.enabled === false ? 0 : 1;

    const statements: Array<string | { sql: string; args: Array<string | number> }> = [];
    if (isDefault) {
      statements.push({
        sql: 'UPDATE iptv_providers SET is_default = 0, updated_at = ? WHERE is_default = 1',
        args: [now],
      });
    }
    statements.push({
      sql: `INSERT INTO iptv_providers (
        id, name, host, route, upstream_username, upstream_password,
        local_username, local_password, is_default, cache_duration_hours,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        name,
        host,
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

    await db.batch(statements);
    await LogService.info('provider', 'creation', `Created provider "${name}" on route "/${route}".`, {
      provider_id: id,
      is_default: Boolean(isDefault),
      cache_duration_hours: cacheHours,
    });

    const created = await this.getProviderById(id, false);
    if (!created) throw new Error('Provider was created but could not be reloaded.');
    return created;
  }

  static async updateProvider(id: string, input: UpdateProviderInput): Promise<IptvProvider> {
    await initDatabase();
    const db = getDb();
    const existing = await this.getProviderById(id, true);
    if (!existing) throw new Error('Provider not found.');

    const now = new Date().toISOString();
    const statements: Array<string | { sql: string; args: Array<string | number> }> = [];

    const name = input.name !== undefined ? input.name.trim() : existing.name;
    if (!name) throw new Error('Provider name cannot be empty.');

    let route = existing.route;
    if (input.route !== undefined) {
      route = normalizeRoute(input.route);
      if (!route) throw new Error('Provider route cannot be empty.');
      if (isRouteReserved(route)) throw new Error(`Route "${route}" is reserved.`);
      const check = await db.execute({
        sql: 'SELECT id FROM iptv_providers WHERE route = ? AND id != ?',
        args: [route, id],
      });
      if (check.rows.length) throw new Error(`Route "${route}" is already in use.`);
    }

    const host = input.host !== undefined ? normalizeHost(input.host) : existing.host;
    let isDefault = existing.is_default;
    if (input.is_default !== undefined) {
      isDefault = input.is_default ? 1 : 0;
      if (isDefault) {
        statements.push({
          sql: 'UPDATE iptv_providers SET is_default = 0, updated_at = ? WHERE is_default = 1 AND id != ?',
          args: [now, id],
        });
      }
    }

    const upstreamUsername = input.upstream_username !== undefined ? input.upstream_username.trim() : existing.upstream_username;
    const upstreamPassword =
      input.upstream_password !== undefined && input.upstream_password !== MASK
        ? input.upstream_password
        : existing.upstream_password;
    const localUsername = input.local_username !== undefined ? input.local_username.trim() : existing.local_username;
    const localPassword =
      input.local_password !== undefined && input.local_password !== MASK ? input.local_password : existing.local_password;
    const cacheHours =
      input.cache_duration_hours !== undefined
        ? Math.max(0, Math.min(24, Math.trunc(input.cache_duration_hours)))
        : existing.cache_duration_hours;
    const enabled = input.enabled !== undefined ? (input.enabled ? 1 : 0) : existing.enabled;

    statements.push({
      sql: `UPDATE iptv_providers SET
        name = ?, host = ?, route = ?, upstream_username = ?, upstream_password = ?,
        local_username = ?, local_password = ?, is_default = ?, cache_duration_hours = ?,
        enabled = ?, updated_at = ? WHERE id = ?`,
      args: [
        name,
        host,
        route,
        upstreamUsername,
        upstreamPassword,
        localUsername,
        localPassword,
        isDefault,
        cacheHours,
        enabled,
        now,
        id,
      ],
    });

    await db.batch(statements);
    await LogService.info('provider', 'update', `Updated provider "${name}" (route: "/${route}").`, {
      provider_id: id,
      is_default: Boolean(isDefault),
      enabled: Boolean(enabled),
    });

    const updated = await this.getProviderById(id, false);
    if (!updated) throw new Error('Provider was updated but could not be reloaded.');
    return updated;
  }

  static async setDefaultProvider(id: string): Promise<IptvProvider> {
    await initDatabase();
    const db = getDb();
    const provider = await this.getProviderById(id, false);
    if (!provider) throw new Error('Provider not found.');

    const now = new Date().toISOString();
    await db.batch([
      { sql: 'UPDATE iptv_providers SET is_default = 0, updated_at = ? WHERE is_default = 1', args: [now] },
      { sql: 'UPDATE iptv_providers SET is_default = 1, updated_at = ? WHERE id = ?', args: [now, id] },
    ]);

    await LogService.info('provider', 'default', `Set provider "${provider.name}" as the default provider.`, {
      provider_id: id,
    });

    const updated = await this.getProviderById(id, false);
    if (!updated) throw new Error('Provider not found after default update.');
    return updated;
  }

  static async deleteProvider(id: string): Promise<void> {
    await initDatabase();
    const db = getDb();
    const provider = await this.getProviderById(id, false);
    if (!provider) throw new Error('Provider not found.');

    await db.execute({ sql: 'DELETE FROM iptv_providers WHERE id = ?', args: [id] });
    await LogService.warn('provider', 'deletion', `Deleted provider "${provider.name}" (route: "/${provider.route}").`, {
      provider_id: id,
    });
  }

  static async resolveProviderByPath(requestPath: string): Promise<{
    provider: IptvProvider | null;
    matchedBy: 'route' | 'default' | 'none';
    remainingPath: string;
    resolvedTargetUrl: string | null;
  }> {
    await initDatabase();
    const db = getDb();
    const trimmed = requestPath.trim().replace(/^\/+/, '');
    const segments = trimmed ? trimmed.split('/') : [];
    const firstSegment = segments[0] ? normalizeRoute(segments[0]) : '';

    if (firstSegment) {
      const match = await db.execute({
        sql: 'SELECT * FROM iptv_providers WHERE route = ? AND enabled = 1 LIMIT 1',
        args: [firstSegment],
      });
      if (match.rows.length) {
        const provider = rowToProvider(match.rows[0] as unknown as Record<string, unknown>, true);
        const remaining = segments.slice(1).join('/');
        return {
          provider,
          matchedBy: 'route',
          remainingPath: `/${remaining}`,
          resolvedTargetUrl: remaining ? `${provider.host}/${remaining}` : provider.host,
        };
      }
    }

    const fallback = await db.execute('SELECT * FROM iptv_providers WHERE is_default = 1 AND enabled = 1 LIMIT 1');
    if (fallback.rows.length) {
      const provider = rowToProvider(fallback.rows[0] as unknown as Record<string, unknown>, true);
      return {
        provider,
        matchedBy: 'default',
        remainingPath: `/${trimmed}`,
        resolvedTargetUrl: trimmed ? `${provider.host}/${trimmed}` : provider.host,
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
