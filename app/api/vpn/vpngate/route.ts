import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { VpnGateService } from '@/lib/services/vpn/vpngate';
import { OpenvpnService } from '@/lib/services/vpn/openvpn';
import { VpnManager } from '@/lib/services/vpn/vpn-manager';

const actionSchema = z.object({
  action: z.enum(['save', 'connect']),
  serverId: z.string().min(8).max(128),
  name: z.string().trim().min(1).max(128).optional(),
});

export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    const forceRefresh = new URL(req.url).searchParams.get('refresh') === 'true';
    const servers = await VpnGateService.getPublicServers(forceRefresh);
    return NextResponse.json({ success: true, data: servers, count: servers.length, timestamp: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const parsed = actionSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid VPNGate action' }, { status: 400 });

    const server = await VpnGateService.getServerById(parsed.data.serverId);
    if (!server) return NextResponse.json({ success: false, error: 'That VPNGate server is no longer in the current server list. Refresh and try again.' }, { status: 404 });

    if (parsed.data.action === 'connect') {
      if (VpnManager.isOperationInProgress()) return NextResponse.json({ success: false, error: 'Another VPN operation is already in progress.' }, { status: 409 });
      const result = await VpnManager.connectVpnGateServer(server.id);
      const state = await VpnManager.getVpnStatusSummary();
      if (!result.success) {
        const conflict = state.status === 'connected' || /already connected|disconnect the current vpn|already being established/i.test(result.error || '');
        return NextResponse.json({ success: false, error: result.error || 'VPNGate connection failed.', data: state }, { status: conflict ? 409 : 500 });
      }
      return NextResponse.json({ success: true, data: state });
    }

    const profile = await OpenvpnService.createProfile({
      name: parsed.data.name || `VPNGate ${server.countryLong} (${server.ip})`,
      config: VpnGateService.decodeConfig(server.ovpnConfigBase64),
      username: 'vpn',
      password: 'vpn',
      source: 'vpngate',
    });
    return NextResponse.json({ success: true, data: OpenvpnService.toSummary(profile) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: message, data: await VpnManager.getVpnStatusSummary().catch(() => null) }, { status: 400 });
  }
}
