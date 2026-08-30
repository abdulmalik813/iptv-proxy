import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';

type LiveStreamSnapshot = {
  key: string;
  viewers: number;
  startedAt: string;
  bytesIn: number;
};

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

    let streams: LiveStreamSnapshot[] = [];
    if (running && process.env.INTERNAL_API_TOKEN) {
      try {
        const streamResponse = await fetch('http://127.0.0.1:8080/internal/streams', {
          cache: 'no-store',
          headers: { Authorization: `Bearer ${process.env.INTERNAL_API_TOKEN}` },
          signal: AbortSignal.timeout(2000),
        });
        if (streamResponse.ok) {
          const payload = (await streamResponse.json()) as { success?: boolean; data?: LiveStreamSnapshot[] };
          if (payload.success && Array.isArray(payload.data)) streams = payload.data;
        }
      } catch {
        streams = [];
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        go: {
          running,
          status: running ? 'running' : 'unhealthy',
          latencyMs: Date.now() - started,
          activeStreams: streams.length,
          viewers: streams.reduce((total, stream) => total + Math.max(0, Number(stream.viewers) || 0), 0),
          streams,
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
          activeStreams: 0,
          viewers: 0,
          streams: [],
        },
      },
    });
  }
}
