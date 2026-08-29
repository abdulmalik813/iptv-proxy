import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { ProviderService } from '@/lib/services/provider.service';

const createProviderSchema = z.object({
  name: z.string().min(1, 'Provider name is required'),
  host: z.string().url('Valid host URL is required (e.g. http://provider.example.com:8080)'),
  route: z.string().min(1, 'Route is required'),
  upstream_username: z.string().min(1, 'Upstream username is required'),
  upstream_password: z.string().min(1, 'Upstream password is required'),
  local_username: z.string().min(1, 'Local username is required'),
  local_password: z.string().min(1, 'Local password is required'),
  is_default: z.boolean().optional(),
  cache_duration_hours: z.number().min(0).max(24).optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const providers = await ProviderService.getAllProviders(false);
    return NextResponse.json({ success: true, data: providers });
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
    const parsed = createProviderSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 }
      );
    }

    const created = await ProviderService.createProvider(parsed.data);
    return NextResponse.json({ success: true, data: created }, { status: 201 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 400 });
  }
}
