import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderService } from '@/lib/services/provider.service';
import { LogService } from '@/lib/services/log.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface XtreamUserInfo {
  username?: string;
  message?: string;
  auth?: number | string;
  status?: string;
  exp_date?: string | number | null;
  is_trial?: string | number;
  active_cons?: string | number;
  created_at?: string | number;
  max_connections?: string | number;
  allowed_output_formats?: unknown;
}

interface XtreamServerInfo {
  url?: string;
  port?: string | number;
  https_port?: string | number;
  server_protocol?: string;
  rtmp_port?: string | number;
  timezone?: string;
  timestamp_now?: number;
  time_now?: string;
}

function safeAccountInfo(userInfo: XtreamUserInfo) {
  return {
    username: userInfo.username ?? null,
    status: userInfo.status ?? null,
    expiresAt: userInfo.exp_date ?? null,
    isTrial: userInfo.is_trial ?? null,
    activeConnections: userInfo.active_cons ?? null,
    createdAt: userInfo.created_at ?? null,
    maxConnections: userInfo.max_connections ?? null,
    allowedOutputFormats: Array.isArray(userInfo.allowed_output_formats) ? userInfo.allowed_output_formats : [],
  };
}

function safeServerInfo(serverInfo: XtreamServerInfo | undefined) {
  if (!serverInfo) return null;
  return {
    url: serverInfo.url ?? null,
    port: serverInfo.port ?? null,
    httpsPort: serverInfo.https_port ?? null,
    protocol: serverInfo.server_protocol ?? null,
    rtmpPort: serverInfo.rtmp_port ?? null,
    timezone: serverInfo.timezone ?? null,
    timestampNow: serverInfo.timestamp_now ?? null,
    timeNow: serverInfo.time_now ?? null,
  };
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestError = validateMutationRequest(req);
  if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });

  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const { id } = await context.params;
  const provider = await ProviderService.getProviderById(id, true);
  if (!provider) return NextResponse.json({ success: false, error: 'Provider not found.' }, { status: 404 });

  const target = new URL(`${provider.host.replace(/\/+$/, '')}/player_api.php`);
  target.searchParams.set('username', provider.upstream_username);
  target.searchParams.set('password', provider.upstream_password);

  const startedAt = Date.now();
  try {
    const response = await fetch(target, {
      method: 'GET',
      cache: 'no-store',
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: 'application/json',
        'User-Agent': 'IPTV-Proxy/1.0 Provider-Test',
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Upstream returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`);
    }

    let payload: { user_info?: XtreamUserInfo; server_info?: XtreamServerInfo };
    try {
      payload = JSON.parse(text) as { user_info?: XtreamUserInfo; server_info?: XtreamServerInfo };
    } catch {
      throw new Error('Upstream did not return valid Xtream JSON account information.');
    }

    const userInfo = payload.user_info;
    if (!userInfo) throw new Error('Upstream response did not include user_info.');

    const authenticated = userInfo.auth === 1 || userInfo.auth === '1';
    if (!authenticated) {
      throw new Error(userInfo.message?.trim() || `Xtream authentication failed${userInfo.status ? ` (${userInfo.status})` : ''}.`);
    }

    await LogService.info('provider', 'account-test', `Provider "${provider.name}" account test succeeded.`, {
      provider_id: provider.id,
      elapsed_ms: elapsedMs,
      account_status: userInfo.status ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        provider: { id: provider.id, name: provider.name, host: provider.host, route: provider.route },
        reachable: true,
        authenticated: true,
        elapsedMs,
        account: safeAccountInfo(userInfo),
        server: safeServerInfo(payload.server_info),
        testedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error && error.name === 'TimeoutError'
      ? 'Provider test timed out after 15 seconds.'
      : error instanceof Error
        ? error.message
        : String(error);

    await LogService.warn('provider', 'account-test', `Provider "${provider.name}" account test failed: ${message}`, {
      provider_id: provider.id,
      elapsed_ms: elapsedMs,
    });

    return NextResponse.json({
      success: false,
      error: message,
      data: {
        provider: { id: provider.id, name: provider.name, host: provider.host, route: provider.route },
        reachable: false,
        authenticated: false,
        elapsedMs,
        testedAt: new Date().toISOString(),
      },
    }, { status: 502 });
  }
}
