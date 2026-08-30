import crypto from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { cookies } from 'next/headers';
import { User } from '../db/schema';
import { getDb, initDatabase } from '../db';
import { getSessionSecret, shouldUseSecureCookie } from './secret';

const SESSION_COOKIE_NAME = 'iptv_proxy_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export interface SessionPayload { userId: string; username: string }

export async function createSessionToken(user: { id: string; username: string }): Promise<string> {
  return new SignJWT({ userId: user.id, username: user.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setJti(crypto.randomUUID())
    .setExpirationTime('7d')
    .sign(getSessionSecret());
}

export async function verifySessionToken(token: string): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionSecret(), { algorithms: ['HS256'] });
    if (typeof payload.userId !== 'string' || typeof payload.username !== 'string') return null;
    return { userId: payload.userId, username: payload.username };
  } catch { return null; }
}

export async function getSessionUser(): Promise<User | null> {
  await initDatabase();
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;
  const payload = await verifySessionToken(token);
  if (!payload) return null;
  const result = await getDb().execute({ sql: 'SELECT id, username, password_hash, created_at, updated_at FROM users WHERE id = ?', args: [payload.userId] });
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return { id: String(row.id), username: String(row.username), password_hash: String(row.password_hash), created_at: String(row.created_at), updated_at: String(row.updated_at) };
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, token, { httpOnly: true, secure: shouldUseSecureCookie(), sameSite: 'lax', path: '/', maxAge: SESSION_MAX_AGE_SECONDS });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).set(SESSION_COOKIE_NAME, '', { httpOnly: true, secure: shouldUseSecureCookie(), sameSite: 'lax', path: '/', maxAge: 0 });
}
