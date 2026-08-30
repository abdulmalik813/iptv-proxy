import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderUserService } from '@/lib/services/provider-user.service';
import { refreshGoProviderRegistry } from '@/lib/services/provider-registry-sync.service';

const updateSchema = z.object({
  username: z.string().trim().min(1).max(512).optional(),
  password: z.string().max(4096).optional(),
  enabled: z.boolean().optional(),
});

type Context = { params: Promise<{ id: string; userId: string }> };

export async function PUT(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const admin = await getSessionUser();
    if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }
    const { id, userId } = await params;
    const user = await ProviderUserService.updateUser(id, userId, parsed.data);
    const registryRefreshed = await refreshGoProviderRegistry();
    return NextResponse.json({ success: true, data: user, registryRefreshed });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const admin = await getSessionUser();
    if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const { id, userId } = await params;
    await ProviderUserService.deleteUser(id, userId);
    const registryRefreshed = await refreshGoProviderRegistry();
    return NextResponse.json({ success: true, registryRefreshed });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
