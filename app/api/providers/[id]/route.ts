import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { ProviderService } from '@/lib/services/provider.service';

const updateProviderSchema = z.object({
  name: z.string().min(1).optional(),
  host: z.string().url().optional(),
  route: z.string().min(1).optional(),
  upstream_username: z.string().min(1).optional(),
  upstream_password: z.string().optional(),
  local_username: z.string().min(1).optional(),
  local_password: z.string().optional(),
  is_default: z.boolean().optional(),
  cache_duration_hours: z.number().min(0).max(24).optional(),
  enabled: z.boolean().optional(),
});

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const provider = await ProviderService.getProviderById(id, false);
    if (!provider) {
      return NextResponse.json({ success: false, error: 'Provider not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: provider });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = await req.json();
    const parsed = updateProviderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 }
      );
    }

    const updated = await ProviderService.updateProvider(id, parsed.data);
    return NextResponse.json({ success: true, data: updated });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    await ProviderService.deleteProvider(id);
    return NextResponse.json({ success: true, message: 'Provider deleted successfully' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
