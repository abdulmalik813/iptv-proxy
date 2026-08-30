'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

type TabsContextValue = {
  value: string;
  onValueChange: (value: string) => void;
};

const TabsContext = React.createContext<TabsContextValue | null>(null);

function useTabs() {
  const context = React.useContext(TabsContext);
  if (!context) throw new Error('Tabs components must be used inside Tabs.');
  return context;
}

export function Tabs({ value, onValueChange, className, children }: { value: string; onValueChange: (value: string) => void; className?: string; children: React.ReactNode }) {
  return <TabsContext.Provider value={{ value, onValueChange }}><div className={className}>{children}</div></TabsContext.Provider>;
}

export function TabsList({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div role="tablist" className={cn('inline-flex h-9 items-center rounded-lg bg-muted p-1 text-muted-foreground', className)} {...props} />;
}

export function TabsTrigger({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const tabs = useTabs();
  const active = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => tabs.onValueChange(value)}
      className={cn('inline-flex h-7 items-center justify-center whitespace-nowrap rounded-md px-3 text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50', active ? 'bg-background text-foreground shadow-sm' : 'hover:text-foreground', className)}
    >
      {children}
    </button>
  );
}

export function TabsContent({ value, className, children }: { value: string; className?: string; children: React.ReactNode }) {
  const tabs = useTabs();
  if (tabs.value !== value) return null;
  return <div role="tabpanel" className={cn('mt-4 outline-none', className)}>{children}</div>;
}
