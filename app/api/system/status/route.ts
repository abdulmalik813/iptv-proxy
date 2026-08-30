import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';

export async function GET(_req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

  const started = Date.now();
  try {
    const response = await fetch('http://127.0.0.1:8080/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    const body = (await response.text()).trim();
    const running = response.ok && body.toLowerCase() === 'ok';
    return NextResponse.json({
      success: true,
      data: {
        go: {
          running,
          status: running ? 'running' : 'unhealthy',
          latencyMs: Date.now() - started,
        },
      },
    });
  } catch {
    return NextResponse.json({
      success: true,
      data: {
        go: {
          running: false,
          status: 'offline',
          latencyMs: Date.now() - started,
        },
      },
    });
  }
}
