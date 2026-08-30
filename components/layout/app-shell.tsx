'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { Skeleton } from '@/components/ui/skeleton';
import { apiPath, readJson } from '@/lib/client/api';
import { cn } from '@/lib/utils';

type AuthResponse = {
  authenticated?: boolean;
  user?: { username: string };
};

export function AppShell({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [user, setUser] = React.useState<{ username: string } | null>(null);
  const [checkingAuth, setCheckingAuth] = React.useState(true);

  React.useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const response = await fetch(apiPath('/api/auth/me'), { cache: 'no-store' });
        if (response.status === 401) {
          router.replace('/login');
          return;
        }
        const payload = await readJson<AuthResponse>(response);
        if (!cancelled && payload.authenticated && payload.user) setUser(payload.user);
      } finally {
        if (!cancelled) setCheckingAuth(false);
      }
    }

    void checkAuth();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checkingAuth) {
    return (
      <div className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto grid max-w-6xl gap-4">
          <Skeleton className="h-12 w-full" />
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {Array.from({ length: 4 }).map((_, index) => (
              <Skeleton key={index} className="h-28" />
            ))}
          </div>
          <Skeleton className="h-80 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen bg-muted/20 text-foreground">
      <Sidebar user={user} mobileOpen={mobileOpen} setMobileOpen={setMobileOpen} />
      <div className="min-w-0 flex-1">
        <TopBar onToggleMobile={() => setMobileOpen(true)} />
        <main className={cn('mx-auto w-full max-w-[1440px] space-y-6 p-4 sm:p-6 lg:p-8', className)}>
          {children}
        </main>
      </div>
    </div>
  );
}
