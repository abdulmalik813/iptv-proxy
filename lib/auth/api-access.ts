import crypto from 'crypto';
import type { NextRequest } from 'next/server';
import { getSessionUser } from './session';

function timingSafeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function hasInternalApiAccess(req: NextRequest): boolean {
  const configured = process.env.INTERNAL_API_TOKEN?.trim();
  if (!configured) return false;

  const authorization = req.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return false;
  return timingSafeEqual(authorization.slice(7).trim(), configured);
}

export async function hasManagementAccess(req: NextRequest): Promise<boolean> {
  if (hasInternalApiAccess(req)) return true;
  return Boolean(await getSessionUser());
}
