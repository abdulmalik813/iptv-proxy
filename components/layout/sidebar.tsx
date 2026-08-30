'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Database,
  FlaskConical,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Settings,
  Shield,
  Tv,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { apiPath } from '@/lib/client/api';
import { cn } from '@/lib/utils';

interface SidebarProps {
  user?: { username: string } | null;
  onLogout?: () => void;
  mobileOpen?: boolean;
  setMobileOpen?: (open: boolean) => void;
}

const groups = [
  {
    label: 'Overview',
    items: [{ name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard }],
  },
  {
    label: 'IPTV',
    items: [
      { name: 'Providers', href: '/providers', icon: Tv },
      { name: 'Provider Tests', href: '/providers/tests', icon: FlaskConical },
      { name: 'Cache', href: '/cache', icon: Database },
    ],
  },
  {
    label: 'Network',
    items: [{ name: 'VPN', href: '/vpn', icon: Shield }],
  },
  {
    label: 'System',
    items: [
      { name: 'Logs', href: '/logs', icon: ScrollText },
      { name: 'Settings', href: '/settings', icon: Settings },
    ],
  },
];

const brandIconPath = `${process.env.NEXT_PUBLIC_UI_BASE_PATH || ''}/iptv-proxy-icon.png`;

export function Sidebar({ user, onLogout, mobileOpen = false, setMobileOpen }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch(apiPath('/api/auth/logout'), { method: 'POST' });
    } finally {
      onLogout?.();
      router.replace('/login');
      router.refresh();
    }
  };

  const isActive = (href: string) => {
    if (href === '/providers') return pathname === '/providers';
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const content = (
    <div className="flex h-full w-64 flex-col bg-card text-card-foreground">
      <div className="flex h-16 items-center justify-between px-4">
        <Link href="/dashboard" className="flex min-w-0 items-center gap-3" onClick={() => setMobileOpen?.(false)}>
          <img src={brandIconPath} alt="IPTV Proxy" className="size-10 shrink-0 rounded-xl object-contain" width={40} height={40} />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">IPTV Proxy</div>
            <div className="truncate text-xs text-muted-foreground">Administration</div>
          </div>
        </Link>
        <Button variant="ghost" size="icon" className="md:hidden" onClick={() => setMobileOpen?.(false)} aria-label="Close navigation">
          <X className="size-4" />
        </Button>
      </div>

      <Separator />

      <nav className="flex-1 space-y-5 overflow-y-auto p-3">
        {groups.map((group) => (
          <div key={group.label}>
            <div className="mb-1 px-2 text-xs font-medium text-muted-foreground">{group.label}</div>
            <div className="space-y-1">
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    id={`nav-link-${item.name.toLowerCase().replace(/\s+/g, '-')}`}
                    onClick={() => setMobileOpen?.(false)}
                    className={cn(
                      'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground'
                        : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                    )}
                  >
                    <Icon className="size-4" />
                    <span>{item.name}</span>
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="p-3">
        <Separator className="mb-3" />
        <div className="flex items-center gap-3 rounded-lg bg-muted/60 p-2.5">
          <div className="grid size-8 shrink-0 place-items-center rounded-full bg-background text-xs font-semibold ring-1 ring-border">
            {(user?.username || 'A').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{user?.username || 'Administrator'}</div>
            <div className="text-xs text-muted-foreground">Admin</div>
          </div>
          <Button id="btn-logout" variant="ghost" size="icon" className="size-8" onClick={() => void handleLogout()} aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="sticky top-0 hidden h-screen shrink-0 border-r md:block">{content}</aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 backdrop-blur-[2px]"
            onClick={() => setMobileOpen?.(false)}
            aria-label="Close navigation"
          />
          <aside className="relative h-full w-64 border-r shadow-2xl">{content}</aside>
        </div>
      )}
    </>
  );
}
