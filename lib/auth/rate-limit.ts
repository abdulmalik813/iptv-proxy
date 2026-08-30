interface AttemptBucket { count: number; resetAt: number }
declare global { var __iptvLoginAttempts: Map<string, AttemptBucket> | undefined }
const attempts = global.__iptvLoginAttempts || new Map<string, AttemptBucket>();
global.__iptvLoginAttempts = attempts;
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;
export function loginRateLimitKey(ip: string, username: string): string { return `${ip.trim().toLowerCase()}|${username.trim().toLowerCase()}`; }
export function checkLoginRateLimit(key: string): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now(); const bucket = attempts.get(key);
  if (!bucket || bucket.resetAt <= now) { if (bucket) attempts.delete(key); return { allowed: true, retryAfterSeconds: 0 }; }
  if (bucket.count < MAX_ATTEMPTS) return { allowed: true, retryAfterSeconds: 0 };
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
}
export function recordLoginFailure(key: string): void { const now = Date.now(); const bucket = attempts.get(key); if (!bucket || bucket.resetAt <= now) attempts.set(key, { count: 1, resetAt: now + WINDOW_MS }); else bucket.count += 1; }
export function clearLoginFailures(key: string): void { attempts.delete(key); }
