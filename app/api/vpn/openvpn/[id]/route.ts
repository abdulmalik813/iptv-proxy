import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { OpenvpnService } from '@/lib/services/vpn/openvpn';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  config: z.string().min(1).max(1_000_000).optional(),
  username: z.string().trim().max(512).optional().nullable(),
  password: z.string().max(4096).optional().nullable(),
  enabled: z.boolean().optional(),
});

type Context = { params: Promise<{ id: string }> };

async function assertNotActive(id: string): Promise<string | null> {
  const state = await VpnManager.getVpnStatusSummary();
  if ((state.status === 'connected' || state.status === 'connecting') && state.type === 'openvpn' && state.profileId === id) {
    return 'Disconnect this OpenVPN profile before editing or deleting it.';
  }
  return null;
}

export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const profile = await OpenvpnService.getProfileById((await params).id, false);
    if (!profile) return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: profile });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const id = (await params).id;
    const activeError = await assertNotActive(id);
    if (activeError) return NextResponse.json({ success: false, error: activeError }, { status: 409 });
    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' }, { status: 400 });
    const updated = await OpenvpnService.updateProfile(id, parsed.data);
    return NextResponse.json({ success: true, data: OpenvpnService.toSummary(updated) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const id = (await params).id;
    const activeError = await assertNotActive(id);
    if (activeError) return NextResponse.json({ success: false, error: activeError }, { status: 409 });
    await OpenvpnService.deleteProfile(id);
    return NextResponse.json({ success: true, message: 'OpenVPN profile deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
