import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { LogService } from '@/lib/services/log.service';

const ALLOWED_LEVELS = new Set(['debug', 'info', 'warning', 'error', 'all']);
const ALLOWED_ORDERS = new Set(['ASC', 'DESC']);

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const { searchParams } = new URL(req.url);
    const rawLevel = searchParams.get('level') || undefined;
    const level = rawLevel && ALLOWED_LEVELS.has(rawLevel) ? rawLevel : undefined;
    const source = searchParams.get('source')?.slice(0, 64) || undefined;
    const category = searchParams.get('category')?.slice(0, 128) || undefined;
    const search = searchParams.get('search')?.slice(0, 200) || undefined;
    const limit = Number.parseInt(searchParams.get('limit') || '100', 10);
    const offset = Number.parseInt(searchParams.get('offset') || '0', 10);
    const rawOrder = (searchParams.get('order') || 'DESC').toUpperCase();
    const order = (ALLOWED_ORDERS.has(rawOrder) ? rawOrder : 'DESC') as 'ASC' | 'DESC';
    const result = await LogService.queryLogs({ level, source, category, search, limit, offset, order });
    return NextResponse.json({ success: true, data: result.logs, total: result.total });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const count = await LogService.clearAllLogs();
    return NextResponse.json({ success: true, message: `Cleared ${count} log entries.` });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
