import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import type { CalibrationState } from '@/underlay/models';

/** Shared chrome for the floating canvas panels (calibration, alignment, distance check, measurement). */

export function PanelShell({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  testId,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose?: () => void;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'bg-popover/95 text-popover-foreground pointer-events-auto flex min-h-0 flex-col rounded-lg border shadow-lg backdrop-blur-sm',
        className,
      )}
      data-testid={testId}
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <header className="flex items-start gap-2 border-b px-3 py-2">
        {icon && <span className="text-muted-foreground mt-0.5 [&_svg]:size-4">{icon}</span>}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm leading-5 font-semibold">{title}</h2>
          {subtitle && <div className="text-muted-foreground text-xs">{subtitle}</div>}
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="-mt-0.5 -mr-1"
            aria-label="Close panel"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2.5">{children}</div>
      {footer && <footer className="flex items-center gap-2 border-t px-3 py-2">{footer}</footer>}
    </section>
  );
}

export function StateBadge({ state }: { state: CalibrationState }) {
  return (
    <Badge
      variant={state === 'uncalibrated' ? 'warning' : state === 'verified' ? 'success' : 'outline'}
      className="font-normal"
      data-testid="panel-calibration-state"
      data-state={state}
    >
      {state === 'uncalibrated' ? 'Uncalibrated' : state === 'verified' ? 'Verified ✓' : 'Calibrated'}
    </Badge>
  );
}

export function Row({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-center gap-2">
      <Label htmlFor={htmlFor} className="text-muted-foreground text-xs font-normal">
        {label}
      </Label>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function Note({
  children,
  tone = 'muted',
}: {
  children: ReactNode;
  tone?: 'muted' | 'warning' | 'error' | 'success';
}) {
  return (
    <p
      className={cn(
        'text-xs',
        tone === 'muted' && 'text-muted-foreground',
        tone === 'warning' && 'bg-warning/15 text-foreground rounded px-2 py-1',
        tone === 'error' && 'text-destructive',
        tone === 'success' && 'bg-success/15 text-foreground rounded px-2 py-1',
      )}
    >
      {children}
    </p>
  );
}
