import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderService } from '@/lib/services/provider.service';

const updateProviderSchema = z.object({
  name: z.string().trim().min(1).max(128).optional(),
  host: z.string().trim().url().max(2048).optional(),
  route: z.string().trim().min(1).max(64).optional(),
  upstream_username: z.string().trim().min(1).max(512).optional(),
  upstream_password: z.string().max(4096).optional(),
  local_username: z.string().trim().min(1).max(512).optional(),
  local_password: z.string().max(4096).optional(),
  is_default: z.boolean().optional(),
  cache_duration_hours: z.number().int().min(0).max(24).optional(),
  enabled: z.boolean().optional(),
});

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Context) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const provider = await ProviderService.getProviderById((await params).id, false);
    if (!provider) return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: provider });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const parsed = updateProviderSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    return NextResponse.json({ success: true, data: await ProviderService.updateProvider((await params).id, parsed.data) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    await ProviderService.deleteProvider((await params).id);
    return NextResponse.json({ success: true, message: 'Provider deleted successfully' });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
