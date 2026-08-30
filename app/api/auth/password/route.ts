import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDb } from '@/lib/db';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import { createSessionToken, getSessionUser, setSessionCookie } from '@/lib/auth/session';
import { validateMutationRequest } from '@/lib/auth/request-security';
import { LogService } from '@/lib/services/log.service';

const passwordSchema = z.object({
  current_password: z.string().min(1).max(1024),
  new_password: z.string().min(8, 'New password must contain at least 8 characters.').max(1024),
});

export async function PUT(req: NextRequest) {
  try {
    const requestError = validateMutationRequest(req);
    if (requestError) return NextResponse.json({ success: false, error: requestError }, { status: 403 });

    const user = await getSessionUser();
    if (!user) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });

    const parsed = passwordSchema.safeParse(await req.json());
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error.issues[0]?.message || 'Invalid input' }, { status: 400 });
    }

    const { current_password: currentPassword, new_password: newPassword } = parsed.data;
    const validCurrentPassword = await verifyPassword(currentPassword, user.password_hash);
    if (!validCurrentPassword) {
      await LogService.warn('auth', 'password_change_failed', `Rejected password change for user "${user.username}".`);
      return NextResponse.json({ success: false, error: 'Current password is incorrect.' }, { status: 400 });
    }
    if (await verifyPassword(newPassword, user.password_hash)) {
      return NextResponse.json({ success: false, error: 'New password must be different from the current password.' }, { status: 400 });
    }

    const passwordHash = await hashPassword(newPassword);
    const now = new Date().toISOString();
    const newSessionVersion = user.session_version + 1;
    await getDb().execute({
      sql: 'UPDATE users SET password_hash = ?, session_version = ?, updated_at = ? WHERE id = ?',
      args: [passwordHash, newSessionVersion, now, user.id],
    });

    const token = await createSessionToken({
      id: user.id,
      username: user.username,
      session_version: newSessionVersion,
    });
    await setSessionCookie(token);
    await LogService.info('auth', 'password_changed', `Password changed for administrator "${user.username}". Previous sessions were invalidated.`, {
      user_id: user.id,
      session_version: newSessionVersion,
    });

    return NextResponse.json({ success: true, message: 'Password updated. Other sessions have been signed out.' });
  } catch (error) {
    return NextResponse.json({ success: false, error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
