import { NextResponse } from 'next/server';
import { clearSessionCookie, getSessionUser } from '@/lib/auth/session';
import { LogService } from '@/lib/services/log.service';

export async function POST() {
  try {
    const user = await getSessionUser();
    if (user) {
      await LogService.info('auth', 'logout', `User "${user.username}" logged out.`);
    }
    await clearSessionCookie();
    return NextResponse.json({ success: true, message: 'Logged out successfully' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
