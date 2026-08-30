import * as React from 'react';
import { cn } from '@/lib/utils';

type AlertVariant = 'default' | 'destructive' | 'success' | 'warning';

const variants: Record<AlertVariant, string> = {
  default: 'border-border bg-card text-card-foreground',
  destructive: 'border-destructive/30 bg-destructive/5 text-destructive',
  success: 'border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/5 text-amber-700 dark:text-amber-300',
};

export function Alert({
  className,
  variant = 'default',
  ...props
}: React.HTMLAttributes<HTMLDivElement> & { variant?: AlertVariant }) {
  return <div role="alert" className={cn('relative w-full rounded-lg border p-4 text-sm', variants[variant], className)} {...props} />;
}

export function AlertTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h5 className={cn('mb-1 font-medium leading-none tracking-tight', className)} {...props} />;
}

export function AlertDescription({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('text-sm leading-relaxed [&_p]:leading-relaxed', className)} {...props} />;
}
