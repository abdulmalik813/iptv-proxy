import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, initDatabase } from '@/lib/db';
import { verifyPassword } from '@/lib/auth/password';
import { createSessionToken, setSessionCookie } from '@/lib/auth/session';
import { LogService } from '@/lib/services/log.service';

const loginSchema = z.object({
  username: z.string().min(1, 'Username is required'),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(req: NextRequest) {
  try {
    await initDatabase();
    const body = await req.json();
    const parsed = loginSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 }
      );
    }

    const { username, password } = parsed.data;
    const db = getDb();

    const userRes = await db.execute({
      sql: 'SELECT id, username, password_hash FROM users WHERE username = ?',
      args: [username.trim()],
    });

    if (userRes.rows.length === 0) {
      await LogService.warn('auth', 'login_failure', `Failed login attempt for username "${username}".`);
      return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 });
    }

    const user = userRes.rows[0];
    const passwordMatch = await verifyPassword(password, String(user.password_hash));

    if (!passwordMatch) {
      await LogService.warn('auth', 'login_failure', `Failed password verification for user "${username}".`);
      return NextResponse.json({ success: false, error: 'Invalid username or password' }, { status: 401 });
    }

    const token = await createSessionToken({
      id: String(user.id),
      username: String(user.username),
    });

    await setSessionCookie(token);

    await LogService.info('auth', 'login_success', `User "${username}" logged in successfully.`, {
      userId: String(user.id),
    });

    return NextResponse.json({
      success: true,
      data: {
        id: String(user.id),
        username: String(user.username),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
