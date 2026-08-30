import crypto from 'crypto';

const ALGORITHM = 'pbkdf2_sha256';
const ITERATIONS = 210_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function hashProviderPassword(password: string): string {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_BYTES, 'sha256');
  return [ALGORITHM, String(ITERATIONS), salt.toString('base64url'), derived.toString('base64url')].join('$');
}

export function isProviderPasswordHash(value: string): boolean {
  const [algorithm, iterations, salt, derived, ...rest] = value.split('$');
  if (rest.length > 0 || algorithm !== ALGORITHM || !/^\d+$/.test(iterations || '')) return false;
  const count = Number(iterations);
  if (!Number.isSafeInteger(count) || count < 10_000 || count > 10_000_000) return false;
  if (!salt || !derived) return false;
  try {
    return Buffer.from(salt, 'base64url').length >= 8 && Buffer.from(derived, 'base64url').length >= 16;
  } catch {
    return false;
  }
}
