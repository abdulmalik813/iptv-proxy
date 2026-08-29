import { NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth/session';
import { getDb, initDatabase } from '@/lib/db';

export async function GET() {
  try {
    await initDatabase();
    const user = await getSessionUser();

    // Check if initial setup is required (no users exist)
    const db = getDb();
    const countRes = await db.execute('SELECT COUNT(*) as count FROM users');
    const userCount = Number(countRes.rows[0]?.count || 0);

    if (!user) {
      return NextResponse.json(
        {
          success: false,
          authenticated: false,
          needsSetup: userCount === 0,
        },
        { status: 401 }
      );
    }

    return NextResponse.json({
      success: true,
      authenticated: true,
      needsSetup: false,
      user: {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
