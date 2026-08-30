import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { initDatabase } from '@/lib/db';

const UI_BASE = '/ui';

export default async function HomePage() {
  await initDatabase();
  const user = await getSessionUser();

  if (!user) {
    redirect(`${UI_BASE}/login`);
  }

  redirect(`${UI_BASE}/dashboard`);
}
