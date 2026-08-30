import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { WireguardService } from '@/lib/services/vpn/wireguard';

const updateSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  config: z.string().min(1).max(256_000).optional(),
  enabled: z.boolean().optional(),
});

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const profile = await WireguardService.getProfileById((await params).id);
    if (!profile) return NextResponse.json({ success: false, error: 'Profile not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: WireguardService.toSummary(profile) });
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

    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid parameters' }, { status: 400 });
    }

    const updated = await WireguardService.updateProfile(
      (await params).id,
      parsed.data.name,
      parsed.data.config,
      parsed.data.enabled
    );
    return NextResponse.json({ success: true, data: WireguardService.toSummary(updated) });
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

    await WireguardService.deleteProfile((await params).id);
    return NextResponse.json({ success: true, message: 'WireGuard profile deleted' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
