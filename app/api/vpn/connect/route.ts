import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

const connectSchema = z.object({
  type: z.enum(['wireguard', 'openvpn', 'warp']),
  profileId: z.string().trim().min(1).max(256).optional(),
});

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });

    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    if (VpnManager.isOperationInProgress()) {
      return NextResponse.json(
        { success: false, error: 'Another VPN operation is already in progress.' },
        { status: 409 }
      );
    }

    const parsed = connectSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' },
        { status: 400 }
      );
    }

    const { type, profileId } = parsed.data;
    let result: { success: boolean; error?: string };

    if (type === 'wireguard') {
      if (!profileId) return NextResponse.json({ success: false, error: 'profileId is required.' }, { status: 400 });
      result = await VpnManager.connectWireguard(profileId);
    } else if (type === 'openvpn') {
      if (!profileId) return NextResponse.json({ success: false, error: 'profileId is required.' }, { status: 400 });
      result = await VpnManager.connectOpenvpn(profileId);
    } else {
      result = await VpnManager.connectWarp();
    }

    if (!result.success) {
      return NextResponse.json({ success: false, error: result.error || 'VPN connection failed.' }, { status: 500 });
    }

    return NextResponse.json({ success: true, data: await VpnManager.getVpnStatusSummary() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
