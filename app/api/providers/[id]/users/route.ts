import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderUserService } from '@/lib/services/provider-user.service';
import { refreshGoProviderRegistry } from '@/lib/services/provider-registry-sync.service';

const createSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.').max(512),
  password: z.string().min(1, 'Password is required.').max(4096),
  enabled: z.boolean().optional(),
});

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const admin = await getSessionUser();
    if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const { id } = await params;
    return NextResponse.json({ success: true, data: await ProviderUserService.getUsers(id, false) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const admin = await getSessionUser();
    if (!admin) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const parsed = createSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }
    const { id } = await params;
    const user = await ProviderUserService.createUser(id, parsed.data);
    const registryRefreshed = await refreshGoProviderRegistry();
    return NextResponse.json({ success: true, data: user, registryRefreshed }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
