import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

const connectSchema = z.object({
  type: z.enum(['wireguard', 'openvpn', 'warp']),
  profileId: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    if (VpnManager.isOperationInProgress()) {
      return NextResponse.json(
        { success: false, error: 'A VPN connection or transition operation is already in progress. Please wait.' },
        { status: 429 }
      );
    }

    const body = await req.json();
    const parsed = connectSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' },
        { status: 400 }
      );
    }

    const { type, profileId } = parsed.data;

    let res: { success: boolean; error?: string };

    if (type === 'wireguard') {
      if (!profileId) {
        return NextResponse.json({ success: false, error: 'profileId is required for WireGuard' }, { status: 400 });
      }
      res = await VpnManager.connectWireguard(profileId);
    } else if (type === 'openvpn') {
      if (!profileId) {
        return NextResponse.json({ success: false, error: 'profileId is required for OpenVPN' }, { status: 400 });
      }
      res = await VpnManager.connectOpenvpn(profileId);
    } else if (type === 'warp') {
      res = await VpnManager.connectWarp();
    } else {
      return NextResponse.json({ success: false, error: 'Unsupported VPN type' }, { status: 400 });
    }

    if (!res.success) {
      return NextResponse.json({ success: false, error: res.error || 'Connection failed' }, { status: 500 });
    }

    const summary = await VpnManager.getVpnStatusSummary();
    return NextResponse.json({ success: true, data: summary });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
