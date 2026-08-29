import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const summary = await VpnManager.getVpnStatusSummary();
    return NextResponse.json({ success: true, data: summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
