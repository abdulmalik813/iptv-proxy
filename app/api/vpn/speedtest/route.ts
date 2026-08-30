import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { LogService } from '@/lib/services/log.service';

const DOWNLOAD_BYTES = 5_000_000;
const UPLOAD_BYTES = 2_000_000;

function mbps(bytes: number, elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  return Number(((bytes * 8) / (elapsedMs / 1000) / 1_000_000).toFixed(2));
}

async function runDownload(): Promise<number> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const started = performance.now();
    const response = await fetch(`https://speed.cloudflare.com/__down?bytes=${DOWNLOAD_BYTES}`, {
      cache: 'no-store',
      signal: controller.signal,
      headers: { 'User-Agent': 'IPTV-Proxy-Speedtest/1.0' },
    });
    if (!response.ok) throw new Error(`Download test returned HTTP ${response.status}`);
    const body = await response.arrayBuffer();
    return mbps(body.byteLength, performance.now() - started);
  } finally {
    clearTimeout(timeout);
  }
}

async function runUpload(): Promise<number> {
  const payload = Buffer.alloc(UPLOAD_BYTES, 0x61);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const started = performance.now();
    const response = await fetch('https://speed.cloudflare.com/__up', {
      method: 'POST',
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(payload.byteLength),
        'User-Agent': 'IPTV-Proxy-Speedtest/1.0',
      },
      body: payload,
    });
    if (!response.ok) throw new Error(`Upload test returned HTTP ${response.status}`);
    await response.arrayBuffer();
    return mbps(payload.byteLength, performance.now() - started);
  } finally {
    clearTimeout(timeout);
  }
}

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const [downloadMbps, uploadMbps] = await Promise.all([runDownload(), runUpload()]);
    const data = { downloadMbps, uploadMbps, testedAt: new Date().toISOString() };
    await LogService.info('vpn', 'speedtest', `VPN egress speed test completed: ${downloadMbps} Mbps down / ${uploadMbps} Mbps up.`, data);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await LogService.error('vpn', 'speedtest', `VPN egress speed test failed: ${message}`);
    return NextResponse.json({ success: false, error: message }, { status: 502 });
  }
}
