import { NextRequest, NextResponse } from 'next/server';
import { hasInternalApiAccess } from '@/lib/auth/api-access';
import { ProviderService } from '@/lib/services/provider.service';

export async function GET(req: NextRequest) {
  if (!hasInternalApiAccess(req)) {
    return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  }

  const providers = await ProviderService.getAllProviders(true);
  return NextResponse.json({
    success: true,
    data: providers.filter((provider) => provider.enabled === 1),
  });
}
