import * as React from 'react';
import { Card, CardContent } from '@/components/ui/card';

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <Card className="border-dashed shadow-none">
      <CardContent className="flex min-h-44 flex-col items-center justify-center gap-3 p-8 text-center">
        {icon && <div className="text-muted-foreground">{icon}</div>}
        <div>
          <h3 className="font-medium">{title}</h3>
          {description && <p className="mt-1 max-w-md text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </CardContent>
    </Card>
  );
}
