import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function MetricCard({
  label,
  value,
  description,
  icon,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-muted-foreground">{label}</p>
            <div className={cn('mt-2 text-2xl font-semibold tracking-tight', valueClassName)}>{value}</div>
            {description && <div className="mt-1 truncate text-xs text-muted-foreground">{description}</div>}
          </div>
          {icon && <div className="rounded-lg bg-muted p-2 text-muted-foreground">{icon}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
