import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

let cachedSecret: Uint8Array | null = null;

function databaseDirectory(): string {
  const databasePath = process.env.DATABASE_PATH?.trim();
  if (databasePath) return path.dirname(databasePath);
  if (fs.existsSync('/data')) return '/data';
  return path.join(process.cwd(), 'data');
}

export function getSessionSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  const configured = (process.env.SESSION_SECRET || process.env.JWT_SECRET)?.trim();
  if (configured) {
    if (configured.length < 32) throw new Error('SESSION_SECRET/JWT_SECRET must be at least 32 characters.');
    cachedSecret = new TextEncoder().encode(configured);
    return cachedSecret;
  }

  const dataDir = databaseDirectory();
  const secretPath = path.join(dataDir, '.session-secret');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let secret: string;
  if (fs.existsSync(secretPath)) {
    secret = fs.readFileSync(secretPath, 'utf8').trim();
    if (secret.length < 32) throw new Error(`Persisted session secret at ${secretPath} is invalid.`);
  } else {
    secret = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(secretPath, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  }
  try { fs.chmodSync(secretPath, 0o600); } catch {}
  cachedSecret = new TextEncoder().encode(secret);
  return cachedSecret;
}

export function shouldUseSecureCookie(): boolean {
  const configured = process.env.COOKIE_SECURE?.trim().toLowerCase();
  if (['true', '1', 'yes'].includes(configured || '')) return true;
  if (['false', '0', 'no'].includes(configured || '')) return false;
  const appUrl = process.env.APP_URL?.trim();
  if (appUrl) return appUrl.toLowerCase().startsWith('https://');
  return process.env.NODE_ENV === 'production';
}
