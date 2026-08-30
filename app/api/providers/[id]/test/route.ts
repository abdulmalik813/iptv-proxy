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

function baseResult(provider: Awaited<ReturnType<typeof ProviderService.getProviderById>>, elapsedMs: number) {
  if (!provider) throw new Error('Provider not found.');
  return {
    provider: { id: provider.id, name: provider.name, host: provider.host, route: provider.route },
    elapsedMs,
    testedAt: new Date().toISOString(),
  };
}

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('username')) url.searchParams.set('username', '[redacted]');
    if (url.searchParams.has('password')) url.searchParams.set('password', '[redacted]');
    return url.toString();
  } catch {
    return value;
  }
}

function diagnosticHeaders(headers: Headers) {
  const allowed = [
    'content-type',
    'content-length',
    'server',
    'date',
    'location',
    'via',
    'cf-ray',
    'cf-cache-status',
    'x-cache',
    'x-powered-by',
  ];
  const result: Record<string, string> = {};
  for (const name of allowed) {
    const value = headers.get(name);
    if (value) result[name] = value;
  }
  return result;
}

function responseDiagnostics(response: Response, elapsedMs: number) {
  return {
    upstreamStatus: response.status,
    upstreamStatusText: response.statusText || null,
    rawContentType: response.headers.get('content-type') || 'text/plain',
    finalUrl: redactUrl(response.url),
    requestMethod: 'GET',
    responseHeaders: diagnosticHeaders(response.headers),
    elapsedMs,
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
        Accept: 'application/json,text/html,text/plain,*/*',
        'User-Agent': 'IPTV-Proxy/1.0 Provider-Test',
      },
    });

    const elapsedMs = Date.now() - startedAt;
    const text = await response.text();
    const diagnostics = responseDiagnostics(response, elapsedMs);

    if (!response.ok) {
      await LogService.warn('provider', 'account-test', `Provider "${provider.name}" returned HTTP ${response.status}.`, {
        provider_id: provider.id,
        elapsed_ms: elapsedMs,
        content_type: diagnostics.rawContentType,
      });
      return NextResponse.json({
        success: false,
        error: `Upstream returned HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
        data: {
          ...baseResult(provider, elapsedMs),
          ...diagnostics,
          reachable: true,
          authenticated: false,
          rawResponse: text,
        },
      }, { status: 502 });
    }

    let payload: { user_info?: XtreamUserInfo; server_info?: XtreamServerInfo };
    try {
      payload = JSON.parse(text) as { user_info?: XtreamUserInfo; server_info?: XtreamServerInfo };
    } catch {
      await LogService.warn('provider', 'account-test', `Provider "${provider.name}" returned a non-JSON response.`, {
        provider_id: provider.id,
        elapsed_ms: elapsedMs,
        content_type: diagnostics.rawContentType,
      });
      return NextResponse.json({
        success: false,
        error: diagnostics.rawContentType.toLowerCase().includes('html') ? 'Upstream returned HTML instead of Xtream JSON.' : 'Upstream returned a non-JSON response.',
        data: {
          ...baseResult(provider, elapsedMs),
          ...diagnostics,
          reachable: true,
          authenticated: false,
          rawResponse: text,
        },
      }, { status: 502 });
    }

    const userInfo = payload.user_info;
    if (!userInfo) {
      return NextResponse.json({
        success: false,
        error: 'Upstream response did not include user_info.',
        data: {
          ...baseResult(provider, elapsedMs),
          ...diagnostics,
          reachable: true,
          authenticated: false,
          rawResponse: text,
        },
      }, { status: 502 });
    }

    const authenticated = userInfo.auth === 1 || userInfo.auth === '1';
    if (!authenticated) {
      return NextResponse.json({
        success: false,
        error: userInfo.message?.trim() || `Xtream authentication failed${userInfo.status ? ` (${userInfo.status})` : ''}.`,
        data: {
          ...baseResult(provider, elapsedMs),
          ...diagnostics,
          reachable: true,
          authenticated: false,
          rawResponse: text,
        },
      }, { status: 502 });
    }

    await LogService.info('provider', 'account-test', `Provider "${provider.name}" account test succeeded.`, {
      provider_id: provider.id,
      elapsed_ms: elapsedMs,
      account_status: userInfo.status ?? null,
    });

    return NextResponse.json({
      success: true,
      data: {
        ...baseResult(provider, elapsedMs),
        ...diagnostics,
        reachable: true,
        authenticated: true,
        account: safeAccountInfo(userInfo),
        server: safeServerInfo(payload.server_info),
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
        ...baseResult(provider, elapsedMs),
        reachable: false,
        authenticated: false,
      },
    }, { status: 502 });
  }
}
