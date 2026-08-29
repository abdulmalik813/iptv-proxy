import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { WarpService } from '@/lib/services/vpn/warp';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

const warpActionSchema = z.object({
  action: z.enum(['register', 'connect', 'disconnect', 'reset']),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const status = await WarpService.getStatus();
    return NextResponse.json({ success: true, data: status });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const parsed = warpActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid action' },
        { status: 400 }
      );
    }

    const { action } = parsed.data;

    if (action === 'register') {
      const res = await WarpService.register();
      return NextResponse.json({ success: true, message: res.message });
    } else if (action === 'connect') {
      const res = await VpnManager.connectWarp();
      if (!res.success) {
        return NextResponse.json({ success: false, error: res.error || 'Failed to connect WARP' }, { status: 500 });
      }
      return NextResponse.json({ success: true, message: 'Connected to Cloudflare WARP' });
    } else if (action === 'disconnect') {
      const res = await VpnManager.disconnect('WARP disconnect requested');
      if (!res.success) {
        return NextResponse.json({ success: false, error: res.error || 'Failed to disconnect WARP' }, { status: 500 });
      }
      return NextResponse.json({ success: true, message: 'Disconnected from Cloudflare WARP' });
    } else if (action === 'reset') {
      const res = await WarpService.reset();
      return NextResponse.json({ success: true, message: res.message });
    }

    return NextResponse.json({ success: false, error: 'Unknown action' }, { status: 400 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
