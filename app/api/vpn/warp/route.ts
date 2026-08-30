import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { WarpService } from '@/lib/services/vpn/warp';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

const actionSchema = z.object({ action: z.enum(['register', 'connect', 'disconnect', 'rotate']) });

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ success: true, data: await WarpService.getStatus() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const parsed = actionSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: 'Invalid WARP action.' }, { status: 400 });
    const { action } = parsed.data;

    if (VpnManager.isOperationInProgress()) {
      return NextResponse.json({ success: false, error: 'Another VPN operation is already in progress.' }, { status: 409 });
    }

    if (action === 'register') {
      const summary = await VpnManager.getVpnStatusSummary();
      if (summary.status === 'connected' || summary.status === 'connecting') {
        return NextResponse.json({ success: false, error: 'Disconnect the current VPN before registering Cloudflare WARP.' }, { status: 409 });
      }
      const status = await WarpService.getStatus();
      if (status.registered) return NextResponse.json({ success: false, error: 'Cloudflare WARP is already registered.' }, { status: 409 });
      const result = await WarpService.register();
      return NextResponse.json({ success: true, message: result.message, data: await WarpService.getStatus() });
    }

    if (action === 'rotate') {
      const summary = await VpnManager.getVpnStatusSummary();
      if (summary.status === 'connecting') {
        return NextResponse.json({ success: false, error: 'Wait for the current VPN operation to finish before rotating WARP.' }, { status: 409 });
      }
      if (summary.status === 'connected' && summary.type !== 'warp') {
        return NextResponse.json({ success: false, error: `Cannot rotate Cloudflare WARP while ${summary.profileName || summary.type} is connected.` }, { status: 409 });
      }
      const status = await WarpService.getStatus();
      if (!status.registered) return NextResponse.json({ success: false, error: 'Cloudflare WARP is not registered.' }, { status: 409 });
      const result = await WarpService.rotate();
      const state = await VpnManager.getVpnStatusSummary();
      return NextResponse.json({ success: true, message: result.message, reconnected: result.reconnected, data: state });
    }

    if (action === 'connect') {
      const result = await VpnManager.connectWarp();
      if (!result.success) {
        const status = await VpnManager.getVpnStatusSummary();
        return NextResponse.json({ success: false, error: result.error, data: status }, { status: status.status === 'connected' ? 409 : 500 });
      }
      return NextResponse.json({ success: true, data: await VpnManager.getVpnStatusSummary() });
    }

    const summary = await VpnManager.getVpnStatusSummary();
    if (summary.status !== 'connected' || summary.type !== 'warp') {
      return NextResponse.json({ success: false, error: 'Cloudflare WARP is not the active VPN.' }, { status: 409 });
    }
    const result = await VpnManager.disconnect('Cloudflare WARP disconnect requested');
    if (!result.success) return NextResponse.json({ success: false, error: result.error }, { status: 500 });
    return NextResponse.json({ success: true, data: await VpnManager.getVpnStatusSummary() });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
