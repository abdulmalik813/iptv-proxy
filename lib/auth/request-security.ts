import type { NextRequest } from 'next/server';

function normalizeOrigin(value: string): string | null { try { return new URL(value).origin; } catch { return null; } }

export function validateMutationRequest(req: NextRequest): string | null {
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite && !['same-origin', 'same-site', 'none'].includes(fetchSite)) return 'Cross-site state-changing requests are not allowed.';
  const originHeader = req.headers.get('origin');
  if (!originHeader) return null;
  const origin = normalizeOrigin(originHeader);
  if (!origin) return 'Invalid Origin header.';
  const allowed = new Set<string>();
  const configuredAppUrl = process.env.APP_URL?.trim();
  if (configuredAppUrl) { const configuredOrigin = normalizeOrigin(configuredAppUrl); if (configuredOrigin) allowed.add(configuredOrigin); }
  const forwardedHost = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  const host = forwardedHost || req.headers.get('host');
  const forwardedProto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const proto = forwardedProto || req.nextUrl.protocol.replace(':', '');
  if (host) allowed.add(`${proto}://${host}`);
  allowed.add(req.nextUrl.origin);
  return allowed.has(origin) ? null : 'Origin does not match this application.';
}
