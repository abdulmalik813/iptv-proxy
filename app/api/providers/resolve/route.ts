import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { ProviderService } from '@/lib/services/provider.service';

const resolveSchema = z.object({
  path: z.string().min(1, 'Path is required'),
});

export async function POST(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await req.json();
    const parsed = resolveSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid path' },
        { status: 400 }
      );
    }

    const resolution = await ProviderService.resolveProviderByPath(parsed.data.path);
    return NextResponse.json({ success: true, data: resolution });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
