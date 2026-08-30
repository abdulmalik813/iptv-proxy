import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getDb, initDatabase } from '@/lib/db';
import { LogEntry, LogLevel, LogSource } from '@/lib/db/schema';
import { logEmitter } from '@/lib/services/log.service';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function rowToLog(row: Record<string, unknown>): LogEntry {
  return {
    id: String(row.id), timestamp: String(row.timestamp), level: row.level as LogLevel,
    source: row.source as LogSource, category: String(row.category), message: String(row.message),
    metadata_json: row.metadata_json ? String(row.metadata_json) : null, created_at: String(row.created_at),
  };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return new Response('Unauthorized', { status: 401 });
  await initDatabase();
  const db = getDb();
  const maxRowResult = await db.execute('SELECT COALESCE(MAX(rowid), 0) AS rowid FROM logs');
  let lastRowId = Number(maxRowResult.rows[0]?.rowid || 0);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const seen = new Set<string>();
      const send = (event: string, payload: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`)); } catch { closed = true; }
      };
      send('connected', { message: 'Connected to live log stream' });
      const onNewLog = (log: LogEntry) => {
        if (seen.has(log.id)) return;
        seen.add(log.id);
        send('log', log);
      };
      logEmitter.on('new_log', onNewLog);
      const databaseTail = setInterval(() => {
        void (async () => {
          try {
            const result = await db.execute({
              sql: `SELECT rowid, id, timestamp, level, source, category, message, metadata_json, created_at FROM logs WHERE rowid > ? ORDER BY rowid ASC LIMIT 200`,
              args: [lastRowId],
            });
            for (const rawRow of result.rows) {
              const row = rawRow as unknown as Record<string, unknown>;
              lastRowId = Math.max(lastRowId, Number(row.rowid || 0));
              const log = rowToLog(row);
              if (seen.has(log.id)) continue;
              seen.add(log.id);
              send('log', log);
            }
          } catch {}
        })();
      }, 2000);
      const heartbeat = setInterval(() => {
        if (!closed) { try { controller.enqueue(encoder.encode(': heartbeat\n\n')); } catch { closed = true; } }
      }, 15000);
      const cleanup = () => {
        logEmitter.off('new_log', onNewLog);
        clearInterval(databaseTail);
        clearInterval(heartbeat);
        if (!closed) { closed = true; try { controller.close(); } catch {} }
      };
      req.signal.addEventListener('abort', cleanup, { once: true });
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' } });
}
