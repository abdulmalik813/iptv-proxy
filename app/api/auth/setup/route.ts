import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import crypto from 'crypto';
import { getDb, initDatabase } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { createSessionToken, setSessionCookie } from '@/lib/auth/session';
import { LogService } from '@/lib/services/log.service';

const setupSchema = z.object({
  username: z.string().min(3, 'Username must be at least 3 characters'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

export async function POST(req: NextRequest) {
  try {
    await initDatabase();
    const db = getDb();

    // Verify no users exist yet
    const countRes = await db.execute('SELECT COUNT(*) as count FROM users');
    const userCount = Number(countRes.rows[0]?.count || 0);

    if (userCount > 0) {
      return NextResponse.json(
        { success: false, error: 'Initial administrator account is already configured. Setup is closed.' },
        { status: 400 }
      );
    }

    const body = await req.json();
    const parsed = setupSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: parsed.error.issues[0]?.message || 'Invalid input' },
        { status: 400 }
      );
    }

    const { username, password } = parsed.data;
    const passwordHash = await hashPassword(password);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    await db.execute({
      sql: 'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      args: [userId, username.trim(), passwordHash, now, now],
    });

    await db.execute({
      sql: "UPDATE app_settings SET initial_setup_completed = 1, updated_at = ? WHERE id = 'global'",
      args: [now],
    });

    const token = await createSessionToken({ id: userId, username: username.trim() });
    await setSessionCookie(token);

    await LogService.info('auth', 'setup', `Initial administrator account "${username.trim()}" created.`);

    return NextResponse.json({
      success: true,
      data: {
        id: userId,
        username: username.trim(),
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
