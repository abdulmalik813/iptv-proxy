import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });

    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    if (VpnManager.isOperationInProgress()) {
      return NextResponse.json({ success: false, error: 'Another VPN operation is already in progress.' }, { status: 409 });
    }

    const result = await VpnManager.disconnect();
    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || 'VPN disconnection failed.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: await VpnManager.getVpnStatusSummary() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
