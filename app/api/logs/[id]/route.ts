import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { hasManagementAccess } from '@/lib/auth/api-access';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { LogService } from '@/lib/services/log.service';

const updateSchema = z.object({
  level: z.enum(['debug', 'info', 'warning', 'error']).optional(),
  source: z.enum(['auth', 'provider', 'vpn', 'wireguard', 'openvpn', 'warp', 'vpngate', 'system', 'proxy']).optional(),
  category: z.string().trim().min(1).max(128).optional(),
  message: z.string().min(1).max(8000).optional(),
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, { message: 'At least one field is required.' });

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    if (!(await hasManagementAccess(req))) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const entry = await LogService.getLog(id);
    if (!entry) return NextResponse.json({ success: false, error: 'Log entry not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: entry });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function PUT(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    if (!(await hasManagementAccess(req))) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const parsed = updateSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid log update' }, { status: 400 });
    }

    const { id } = await context.params;
    const entry = await LogService.updateLog(id, parsed.data);
    if (!entry) return NextResponse.json({ success: false, error: 'Log entry not found' }, { status: 404 });
    return NextResponse.json({ success: true, data: entry });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    if (!(await hasManagementAccess(req))) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await context.params;
    const deleted = await LogService.deleteLog(id);
    if (!deleted) return NextResponse.json({ success: false, error: 'Log entry not found' }, { status: 404 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
