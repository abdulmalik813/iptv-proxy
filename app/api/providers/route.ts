import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderService } from '@/lib/services/provider.service';
import { refreshGoProviderRegistry } from '@/lib/services/provider-registry-sync.service';

const createProviderSchema = z.object({
  name: z.string().trim().min(1, 'Provider name is required').max(128),
  host: z.string().trim().url('Valid provider URL is required').max(2048),
  route: z.string().trim().min(1, 'Route is required').max(64),
  upstream_username: z.string().trim().min(1, 'Upstream username is required').max(512),
  upstream_password: z.string().min(1, 'Upstream password is required').max(4096),
  local_username: z.string().trim().min(1, 'Initial client username is required').max(512),
  local_password: z.string().min(1, 'Initial client password is required').max(4096),
  is_default: z.boolean().optional(),
  cache_duration_hours: z.number().int().min(0).max(24).optional(),
  enabled: z.boolean().optional(),
});

export async function GET() {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    return NextResponse.json({ success: true, data: await ProviderService.getAllProviders(false) });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const parsed = createProviderSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }
    const provider = await ProviderService.createProvider(parsed.data);
    const registryRefreshed = await refreshGoProviderRegistry();
    return NextResponse.json({ success: true, data: provider, registryRefreshed }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
