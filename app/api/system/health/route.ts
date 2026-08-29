import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { SystemService } from '@/lib/services/system.service';

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const health = await SystemService.getHealth();
    return NextResponse.json({ success: true, data: health });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
