import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { User } from '../db/schema';
import { getDb, initDatabase } from '../db';

const SESSION_COOKIE_NAME = 'iptv_proxy_session';
const SECRET_KEY = new TextEncoder().encode(
  process.env.SESSION_SECRET || 'iptv-proxy-default-secure-secret-key-at-least-32-chars-long'
);

export interface SessionPayload {
  userId: string;
  username: string;
}

export async function createSessionToken(user: { id: string; username: string }): Promise<string> {
  return new SignJWT({
    userId: user.id,
    username: user.username,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(SECRET_KEY);
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, SECRET_KEY);
    return {
      userId: payload.userId as string,
      username: payload.username as string,
    };
  } catch {
    return null;
  }
}

export async function getSessionUser(): Promise<User | null> {
  await initDatabase();
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;

  if (!token) {
    return null;
  }

  const payload = await verifySessionToken(token);
  if (!payload || !payload.userId) {
    return null;
  }

  const db = getDb();
  const result = await db.execute({
    sql: 'SELECT id, username, password_hash, created_at, updated_at FROM users WHERE id = ?',
    args: [payload.userId],
  });

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: String(row.id),
    username: String(row.username),
    password_hash: String(row.password_hash),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

export async function setSessionCookie(token: string): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
}

export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
