import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { LogService } from '@/lib/services/log.service';

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const level = searchParams.get('level') || undefined;
    const source = searchParams.get('source') || undefined;
    const category = searchParams.get('category') || undefined;
    const search = searchParams.get('search') || undefined;
    const limit = searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : 100;
    const offset = searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : 0;
    const order = (searchParams.get('order') === 'ASC' ? 'ASC' : 'DESC') as 'ASC' | 'DESC';

    const result = await LogService.queryLogs({
      level,
      source,
      category,
      search,
      limit,
      offset,
      order,
    });

    return NextResponse.json({
      success: true,
      data: result.logs,
      total: result.total,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const count = await LogService.clearAllLogs();
    return NextResponse.json({ success: true, message: `Cleared ${count} log entries` });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
