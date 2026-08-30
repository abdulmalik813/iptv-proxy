'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  FlaskConical,
  LayoutDashboard,
  Tv,
  Shield,
  ScrollText,
  Settings,
  LogOut,
} from 'lucide-react';

interface SidebarProps {
  user?: { username: string } | null;
  onLogout?: () => void;
  mobileOpen?: boolean;
  setMobileOpen?: (open: boolean) => void;
}

export function Sidebar({ user, onLogout, mobileOpen, setMobileOpen }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      if (onLogout) onLogout();
      router.push('/login');
      router.refresh();
    } catch {
      router.push('/login');
    }
  };

  const navItems = [
    { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
    { name: 'Providers', href: '/providers', icon: Tv },
    { name: 'Provider Tests', href: '/providers/tests', icon: FlaskConical },
    { name: 'VPN System', href: '/vpn', icon: Shield },
    { name: 'Live Logs', href: '/logs', icon: ScrollText },
    { name: 'Settings', href: '/settings', icon: Settings },
  ];

  const content = (
    <div id="sidebar-container" className="flex h-full w-64 flex-col border-r border-neutral-800 bg-black text-white select-none">
      <div id="sidebar-brand" className="flex h-16 items-center gap-3 border-b border-neutral-800 px-5">
        <div className="flex h-7 w-7 items-center justify-center bg-white text-xs font-black tracking-tighter text-black">
          IP
        </div>
        <div className="flex flex-col">
          <span className="font-mono text-sm font-bold tracking-tight text-neutral-100 uppercase">IPTV PROXY</span>
          <span className="font-mono text-[10px] tracking-wide text-neutral-500">CORE ORCHESTRATION</span>
        </div>
      </div>

      <nav id="sidebar-nav" className="flex-1 space-y-1 px-3 py-4 font-mono text-xs">
        <div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
          MANAGEMENT
        </div>
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              id={`nav-link-${item.name.toLowerCase().replace(/\s+/g, '-')}`}
              onClick={() => setMobileOpen?.(false)}
              className={`flex items-center gap-3 rounded-none border px-3 py-2.5 text-xs transition-colors ${
                isActive
                  ? 'border-neutral-700 bg-neutral-900 font-semibold text-white shadow-xs'
                  : 'border-transparent text-neutral-400 hover:border-neutral-800 hover:bg-neutral-900/50 hover:text-neutral-200'
              }`}
            >
              <Icon className={`h-4 w-4 ${isActive ? 'text-white' : 'text-neutral-400'}`} />
              <span>{item.name}</span>
            </Link>
          );
        })}
      </nav>

      <div id="sidebar-footer" className="border-t border-neutral-800 bg-neutral-950 p-3 font-mono">
        <div className="flex items-center justify-between px-2 py-1.5">
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="h-2 w-2 shrink-0 rounded-none bg-emerald-500" />
            <span className="truncate font-mono text-xs text-neutral-300">
              {user?.username || 'admin'}
            </span>
          </div>
          <button
            id="btn-logout"
            onClick={handleLogout}
            title="Sign out"
            className="cursor-pointer border border-neutral-800 p-1.5 text-neutral-400 transition-colors hover:bg-neutral-900 hover:text-white"
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      <aside className="sticky top-0 hidden h-screen shrink-0 md:flex">
        {content}
      </aside>

      {mobileOpen && (
        <div className="fixed inset-0 z-50 flex md:hidden">
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-xs"
            onClick={() => setMobileOpen?.(false)}
          />
          <div className="relative z-10 h-full w-64">
            {content}
          </div>
        </div>
      )}
    </>
  );
}
