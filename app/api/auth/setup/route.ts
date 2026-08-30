import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb, initDatabase } from '@/lib/db';
import { hashPassword } from '@/lib/auth/password';
import { createSessionToken, setSessionCookie } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { LogService } from '@/lib/services/log.service';

const setupSchema = z.object({ username: z.string().trim().min(3).max(128), password: z.string().min(8).max(1024) });

export async function POST(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });
    await initDatabase();
    const db = getDb();
    const countRes = await db.execute('SELECT COUNT(*) AS count FROM users');
    if (Number(countRes.rows[0]?.count || 0) > 0) return NextResponse.json({ success: false, error: 'Initial administrator setup is already complete.' }, { status: 409 });
    const parsed = setupSchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    const { username, password } = parsed.data;
    const passwordHash = await hashPassword(password); const userId = crypto.randomUUID(); const now = new Date().toISOString();
    try {
      await db.batch([
        { sql: 'INSERT INTO users (id, username, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', args: [userId, username, passwordHash, now, now] },
        { sql: "UPDATE app_settings SET initial_setup_completed = 1, updated_at = ? WHERE id = 'global'", args: [now] },
      ]);
    } catch (error) {
      const check = await db.execute('SELECT COUNT(*) AS count FROM users');
      if (Number(check.rows[0]?.count || 0) > 0) return NextResponse.json({ success: false, error: 'Administrator setup was completed by another request.' }, { status: 409 });
      throw error;
    }
    const token = await createSessionToken({ id: userId, username }); await setSessionCookie(token);
    await LogService.info('auth', 'setup', `Initial administrator account "${username}" created.`);
    return NextResponse.json({ success: true, data: { id: userId, username } }, { status: 201 });
  } catch (error) { return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 }); }
}
