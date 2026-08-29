'use client';

import React from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  LayoutDashboard,
  Tv,
  Shield,
  ScrollText,
  Settings,
  LogOut,
  Radio,
  Server,
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
    { name: 'VPN System', href: '/vpn', icon: Shield },
    { name: 'Live Logs', href: '/logs', icon: ScrollText },
    { name: 'Settings', href: '/settings', icon: Settings },
  ];

  const content = (
    <div id="sidebar-container" className="flex flex-col h-full bg-black text-white border-r border-neutral-800 w-64 select-none">
      {/* Brand Header */}
      <div id="sidebar-brand" className="h-16 flex items-center gap-3 px-5 border-b border-neutral-800">
        <div className="w-7 h-7 bg-white text-black flex items-center justify-center font-black text-xs tracking-tighter">
          IP
        </div>
        <div className="flex flex-col">
          <span className="font-mono text-sm font-bold tracking-tight text-neutral-100 uppercase">IPTV PROXY</span>
          <span className="text-[10px] text-neutral-500 font-mono tracking-wide">CORE ORCHESTRATION</span>
        </div>
      </div>

      {/* Navigation Links */}
      <nav id="sidebar-nav" className="flex-1 py-4 px-3 space-y-1 font-mono text-xs">
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
              className={`flex items-center gap-3 px-3 py-2.5 rounded-none text-xs transition-colors border ${
                isActive
                  ? 'bg-neutral-900 text-white border-neutral-700 font-semibold shadow-xs'
                  : 'text-neutral-400 border-transparent hover:text-neutral-200 hover:bg-neutral-900/50 hover:border-neutral-800'
              }`}
            >
              <Icon className={`w-4 h-4 ${isActive ? 'text-white' : 'text-neutral-400'}`} />
              <span>{item.name}</span>
            </Link>
          );
        })}

        <div className="pt-6 px-2 py-1 text-[10px] font-semibold tracking-wider text-neutral-500 uppercase">
          CORE ENDPOINTS
        </div>
        <div className="px-3 py-2 border border-neutral-900 bg-neutral-950/60 text-[11px] text-neutral-400 space-y-1.5 font-mono">
          <div className="flex items-center gap-1.5 text-neutral-300">
            <Radio className="w-3 h-3 text-neutral-400" />
            <span className="font-semibold">Xtream Codes Engine</span>
          </div>
          <div className="text-[10px] text-neutral-500 break-all">
            Proxy Port: <span className="text-neutral-300">8080 (Go Engine)</span>
          </div>
          <div className="text-[10px] text-neutral-500 break-all">
            Admin Port: <span className="text-neutral-300">3000 (Next.js)</span>
          </div>
        </div>
      </nav>

      {/* Footer User Info */}
      <div id="sidebar-footer" className="p-3 border-t border-neutral-800 bg-neutral-950 font-mono">
        <div className="flex items-center justify-between px-2 py-1.5">
          <div className="flex items-center gap-2 overflow-hidden">
            <div className="w-2 h-2 rounded-none bg-emerald-500 shrink-0" />
            <span className="text-xs text-neutral-300 truncate font-mono">
              {user?.username || 'admin'}
            </span>
          </div>
          <button
            id="btn-logout"
            onClick={handleLogout}
            title="Sign out"
            className="p-1.5 text-neutral-400 hover:text-white hover:bg-neutral-900 border border-neutral-800 transition-colors cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex shrink-0 h-screen sticky top-0">
        {content}
      </aside>

      {/* Mobile Drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden flex">
          <div
            className="fixed inset-0 bg-black/80 backdrop-blur-xs"
            onClick={() => setMobileOpen?.(false)}
          />
          <div className="relative z-10 w-64 h-full">
            {content}
          </div>
        </div>
      )}
    </>
  );
}
