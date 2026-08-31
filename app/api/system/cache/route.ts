import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';

function headers() {
  const token = process.env.INTERNAL_API_TOKEN?.trim();
  if (!token) throw new Error('INTERNAL_API_TOKEN is not configured.');
  return { Authorization: `Bearer ${token}` };
}

async function readJson(response: Response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { return { success: false, error: `Go cache API returned HTTP ${response.status}.` }; }
}

export async function GET() {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    // Cache status is metadata-only and should normally return quickly, but a
    // large Redis generation publish can briefly occupy the local Redis server.
    // Give that burst room to finish instead of surfacing AbortSignal's generic
    // 10-second timeout while the cache itself is healthy.
    const response = await fetch('http://127.0.0.1:8080/internal/cache', { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(30_000) });
    return NextResponse.json(await readJson(response), { status: response.status });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

// Bulk refresh starts a detached Redis-owned job. The Go core returns quickly,
// while GET exposes persistent progress so a browser reload does not cancel or
// hide the refresh.
export async function POST(req: NextRequest) {
  const requestError = validateMutationRequest(req);
  if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const response = await fetch('http://127.0.0.1:8080/internal/cache/start', {
      method: 'POST',
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await readJson(response), { status: response.status });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

// Single-entry refresh also starts a detached replacement. The existing
// per-entry Redis lock is shared with automatic refreshes, so only one provider
// pull can own a cache key at a time.
export async function DELETE(req: NextRequest) {
  const requestError = validateMutationRequest(req);
  if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const key = new URL(req.url).searchParams.get('key')?.trim();
  if (!key) return NextResponse.json({ success: false, error: 'Cache key is required for a single-entry refresh.' }, { status: 400 });
  try {
    const response = await fetch(`http://127.0.0.1:8080/internal/cache?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
    return NextResponse.json(await readJson(response), { status: response.status });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
