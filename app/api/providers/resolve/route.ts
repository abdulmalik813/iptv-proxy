import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderService } from '@/lib/services/provider.service';

const resolveSchema = z.object({
  path: z.string().trim().min(1, 'Path is required').max(4096),
});

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const parsed = resolveSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid path' }, { status: 400 });

    const resolution = await ProviderService.resolveProviderByPath(parsed.data.path);
    return NextResponse.json({
      success: true,
      data: {
        ...resolution,
        provider: resolution.provider ? ProviderService.toPublicProvider(resolution.provider) : null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
