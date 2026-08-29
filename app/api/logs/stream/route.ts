import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { logEmitter } from '@/lib/services/log.service';
import { LogEntry } from '@/lib/db/schema';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) {
    return new Response('Unauthorized', { status: 401 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      // Send initial connection event
      controller.enqueue(
        encoder.encode(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to live log stream' })}\n\n`)
      );

      const onNewLog = (log: LogEntry) => {
        try {
          controller.enqueue(encoder.encode(`event: log\ndata: ${JSON.stringify(log)}\n\n`));
        } catch {
          // Stream might be closed
        }
      };

      logEmitter.on('new_log', onNewLog);

      // Keepalive heartbeat
      const heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          clearInterval(heartbeat);
        }
      }, 15000);

      req.signal.addEventListener('abort', () => {
        logEmitter.off('new_log', onNewLog);
        clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          // Ignore
        }
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
