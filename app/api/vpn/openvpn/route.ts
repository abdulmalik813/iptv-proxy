import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { OpenvpnService } from '@/lib/services/vpn/openvpn';

const createSchema = z.object({
  name: z.string().trim().min(1, 'Profile name is required').max(128),
  config: z.string().min(1, 'OpenVPN configuration is required').max(1_000_000),
  username: z.string().trim().max(512).optional().nullable(),
  password: z.string().max(4096).optional().nullable(),
  source: z.enum(['uploaded', 'vpngate']).optional(),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ success: true, data: await OpenvpnService.getAllProfileSummaries() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' }, { status: 400 });
    }

    const profile = await OpenvpnService.createProfile(parsed.data);
    return NextResponse.json({ success: true, data: OpenvpnService.toSummary(profile) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
