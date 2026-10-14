import { useState } from 'react';

import { runCommand } from '@/app/commands';
import type { Drawing } from '@/core/types';
import { formatNumber } from '@/core/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { calibrationState, type CalibrationState } from '@/underlay/models';

/** Calibration status (row 32): Uncalibrated / Calibrated / Verified for the drawings in the project. */

const LABEL: Record<CalibrationState, string> = {
  uncalibrated: 'Uncalibrated',
  calibrated: 'Calibrated',
  verified: 'Verified',
};

const variant = (s: CalibrationState) =>
  s === 'uncalibrated' ? 'warning' : s === 'verified' ? 'success' : 'outline';

const METHOD: Record<string, string> = {
  'two-point': 'two points',
  'multi-point': 'reference fit',
  ratio: 'stated scale',
  coordinates: 'plant coordinates',
  'cad-units': 'drawing units',
};

function detail(d: Drawing): string {
  const c = d.calibration;
  if (!c) return d.source.kind === 'pdf' ? 'Paper units (1:1) until calibrated' : 'File units not confirmed';
  const parts = [METHOD[c.method] ?? c.method];
  if (c.ratio) parts.push(`1:${formatNumber(c.ratio, 0)}`);
  if (c.residualRms !== undefined && c.references.length > 2)
    parts.push(`RMS ${formatNumber(c.residualRms, 3)} m`);
  if (d.verified) parts.push(`checked ${formatNumber(d.verified.expected, 3)} m`);
  return parts.join(' · ');
}

export function CalibrationBadge() {
  const drawings = useProject((p) => p.drawings) ?? [];
  const readOnly = useProjectStore((s) => s.readOnly);
  const [open, setOpen] = useState(false);
  if (drawings.length === 0)
    return (
      <Badge variant="outline" className="h-6 font-normal text-muted-foreground">
        No drawing
      </Badge>
    );
  const states = drawings.map(calibrationState);
  const worst: CalibrationState = states.includes('uncalibrated')
    ? 'uncalibrated'
    : states.includes('calibrated')
      ? 'calibrated'
      : 'verified';
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          aria-label={`Calibration: ${LABEL[worst]}`}
        >
          <Badge
            variant={variant(worst)}
            className="h-6 font-normal"
            data-testid="calibration-badge"
            data-state={worst}
          >
            {LABEL[worst]} {worst === 'verified' ? '✓' : ''}
          </Badge>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-2" data-testid="calibration-popover">
        <div className="text-muted-foreground px-1 pb-1 text-xs font-semibold uppercase">Calibration</div>
        <ul className="grid gap-1">
          {[...drawings]
            .sort((a, b) => b.order - a.order)
            .map((d) => {
              const st = calibrationState(d);
              return (
                <li key={d.id} className="rounded-md border px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm" title={d.name}>
                      {d.name}
                    </span>
                    <Badge variant={variant(st)} className="font-normal" data-state={st}>
                      {LABEL[st]}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-xs">
                    <span className="min-w-0 flex-1 truncate">{detail(d)}</span>
                    <Button
                      variant="ghost"
                      size="xs"
                      className="h-6"
                      disabled={readOnly}
                      onClick={() => {
                        setOpen(false);
                        useUiStore.getState().openDialog('calibrate', { drawingId: d.id });
                      }}
                    >
                      Calibrate…
                    </Button>
                  </div>
                </li>
              );
            })}
        </ul>
        <Button
          variant="outline"
          size="xs"
          className="mt-2 w-full"
          disabled={readOnly}
          onClick={() => {
            setOpen(false);
            void runCommand('calibration.check');
          }}
        >
          Check distance…
        </Button>
      </PopoverContent>
    </Popover>
  );
}
