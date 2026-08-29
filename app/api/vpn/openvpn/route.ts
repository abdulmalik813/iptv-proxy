import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { OpenvpnService } from '@/lib/services/vpn/openvpn';

const createOvpnSchema = z.object({
  name: z.string().min(1, 'Profile name is required'),
  config: z.string().min(1, 'OpenVPN configuration (.ovpn) is required'),
  username: z.string().optional().nullable(),
  password: z.string().optional().nullable(),
  source: z.enum(['uploaded', 'vpngate']).optional(),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const profiles = await OpenvpnService.getAllProfiles();
    return NextResponse.json({ success: true, data: profiles });
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
    const parsed = createOvpnSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' },
        { status: 400 }
      );
    }

    const profile = await OpenvpnService.createProfile(parsed.data);
    return NextResponse.json({ success: true, data: profile }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
