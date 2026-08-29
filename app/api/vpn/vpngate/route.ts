import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { VpnGateService } from '@/lib/services/vpn/vpngate';
import { OpenvpnService } from '@/lib/services/vpn/openvpn';

const saveServerSchema = z.object({
  name: z.string().min(1),
  ovpnConfigBase64: z.string().min(1),
  country: z.string().optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const forceRefresh = searchParams.get('refresh') === 'true';

    const servers = await VpnGateService.fetchServers(forceRefresh);

    return NextResponse.json({
      success: true,
      data: servers,
      count: servers.length,
      timestamp: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const parsed = saveServerSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' },
        { status: 400 }
      );
    }

    const decodedConfig = VpnGateService.decodeConfig(parsed.data.ovpnConfigBase64);
    const profile = await OpenvpnService.createProfile({
      name: parsed.data.name,
      config: decodedConfig,
      username: 'vpn', // Default VPNGate guest user
      password: 'vpn',
      source: 'vpngate',
    });

    return NextResponse.json({ success: true, data: profile }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
