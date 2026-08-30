import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, initDatabase } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSessionToken, setSessionCookie } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { checkLoginRateLimit, clearLoginFailures, loginRateLimitKey, recordLoginFailure } from '@/lib/auth/rate-limit';
import { LogService } from '@/lib/services/log.service';

const loginSchema = z.object({ username: z.string().trim().min(1).max(128), password: z.string().min(1).max(1024) });
function clientIp(req: NextRequest): string { return req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown'; }

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    await initDatabase();
    const parsed = loginSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    const { username, password } = parsed.data; const key = loginRateLimitKey(clientIp(req), username); const rate = checkLoginRateLimit(key);
    if (!rate.allowed) return NextResponse.json({ success: false, error: 'Too many failed login attempts. Try again later.' }, { status: 429, headers: { 'Retry-After': String(rate.retryAfterSeconds) } });
    const userRes = await getDb().execute({ sql: 'SELECT id, username, password_hash FROM users WHERE username = ?', args: [username] });
    const user = userRes.rows[0]; const passwordMatch = user ? await verifyPassword(password, String(user.password_hash)) : false;
    if (!user || !passwordMatch) { recordLoginFailure(key); await LogService.warn('auth', 'login_failure', `Failed login attempt for username "${username}".`, { ip: clientIp(req) }); return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 }); }
    clearLoginFailures(key); const token = await createSessionToken({ id: String(user.id), username: String(user.username) }); await setSessionCookie(token);
    await LogService.info('auth', 'login_success', `User "${username}" logged in successfully.`, { user_id: String(user.id), ip: clientIp(req) });
    return NextResponse.json({ success: true, data: { id: String(user.id), username: String(user.username) } });
  } catch (error) { return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
