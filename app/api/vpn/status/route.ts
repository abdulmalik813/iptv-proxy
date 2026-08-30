import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ success: true, data: await VpnManager.getVpnStatusSummary() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
