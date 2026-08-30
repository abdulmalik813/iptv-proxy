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
    const response = await fetch('http://127.0.0.1:8080/internal/cache', { cache: 'no-store', headers: headers(), signal: AbortSignal.timeout(10000) });
    return NextResponse.json(await readJson(response), { status: response.status });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function POST(req: NextRequest) {
  const requestError = validateMutationRequest(req);
  if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const key = new URL(req.url).searchParams.get('key')?.trim();
  if (!key) return NextResponse.json({ success: false, error: 'key is required' }, { status: 400 });
  try {
    const response = await fetch(`http://127.0.0.1:8080/internal/cache/refresh?key=${encodeURIComponent(key)}`, { method: 'POST', headers: headers(), signal: AbortSignal.timeout(10 * 60 * 1000) });
    return NextResponse.json(await readJson(response), { status: response.status });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  const requestError = validateMutationRequest(req);
  if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const key = new URL(req.url).searchParams.get('key')?.trim();
  const target = key ? `http://127.0.0.1:8080/internal/cache?key=${encodeURIComponent(key)}` : 'http://127.0.0.1:8080/internal/cache';
  try {
    const response = await fetch(target, { method: 'DELETE', headers: headers(), signal: AbortSignal.timeout(30000) });
    return NextResponse.json(await readJson(response), { status: response.status });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 503 });
  }
}
