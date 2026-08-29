import { redirect } from 'next/navigation';
import { getSessionUser } from '@/lib/auth/session';
import { getDb, initDatabase } from '@/lib/db';

export default async function HomePage() {
  await initDatabase();
  const user = await getSessionUser();

  if (!user) {
    redirect('/login');
  }

  redirect('/dashboard');
}
