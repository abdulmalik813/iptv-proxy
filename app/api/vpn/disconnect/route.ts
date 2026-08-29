import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

export async function POST() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    if (VpnManager.isOperationInProgress()) {
      return NextResponse.json(
        { success: false, error: 'A VPN operation is already in progress. Please wait.' },
        { status: 429 }
      );
    }

    const res = await VpnManager.disconnect();
    if (!res.success) {
      return NextResponse.json({ success: false, error: res.error || 'Disconnection failed' }, { status: 500 });
    }

    const summary = await VpnManager.getVpnStatusSummary();
    return NextResponse.json({ success: true, data: summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
