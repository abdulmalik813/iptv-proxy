import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { ProviderService } from '@/lib/services/provider.service';
import { refreshGoProviderRegistry } from '@/lib/services/provider-registry-sync.service';

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Context) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const provider = await ProviderService.setDefaultProvider((await params).id);
    const registryRefreshed = await refreshGoProviderRegistry();
    return NextResponse.json({ success: true, data: provider, registryRefreshed });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
