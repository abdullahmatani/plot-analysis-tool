import { Compass, Ruler } from 'lucide-react';

import type { NorthSettings, ProjectDisplay } from '@/core/types';
import { degToRad, radToDeg } from '@/core/units';
import { Field, NumberInput } from '@/components/inspector/fields';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { commit, useProject, useProjectStore } from '@/store/project';

import {
  ANGLE_UNIT_OPTIONS,
  AREA_UNIT_OPTIONS,
  DEFAULT_DISPLAY,
  fmtAngle,
  fmtArea,
  fmtLength,
  hasPlantCoordinates,
  LENGTH_UNIT_OPTIONS,
} from './format';

/**
 * Project display settings (row 26) and north (rows 31, 36). Every change is one undoable command
 * and takes effect immediately in every readout, label and measurement annotation.
 */

function setDisplay<K extends keyof ProjectDisplay>(key: K, value: ProjectDisplay[K], label: string) {
  commit(label, (p) => {
    p.display[key] = value;
  });
}

function setNorth<K extends keyof NorthSettings>(
  key: K,
  value: NorthSettings[K],
  label: string,
  coalesce?: string,
) {
  commit(
    label,
    (p) => {
      p.north[key] = value;
    },
    coalesce ? { coalesceKey: coalesce } : undefined,
  );
}

const PRECISIONS = [0, 1, 2, 3, 4, 5, 6];

export function ProjectSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const display = useProject((p) => p.display) ?? DEFAULT_DISPLAY;
  const north = useProject((p) => p.north) ?? { trueNorthAngle: 0, arrow: 'plant' as const };
  const plant = useProject((p) => hasPlantCoordinates(p)) ?? false;
  const readOnly = useProjectStore((s) => s.readOnly);
  // Bearing of true north measured clockwise from plant north (stored anticlockwise).
  const trueNorthBearing = -radToDeg(north.trueNorthAngle);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="project-settings">
        <DialogHeader>
          <DialogTitle>Project settings</DialogTitle>
          <DialogDescription>
            Units and precision for every readout, label and measurement. Stored values are never rounded.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <Ruler className="size-4" /> Units and precision
          </h4>
          <Field label="Length units">
            <Select
              value={display.units}
              disabled={readOnly}
              onValueChange={(v) => setDisplay('units', v as ProjectDisplay['units'], `Display units: ${v}`)}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Length units">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LENGTH_UNIT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Decimal places">
            <Select
              value={String(display.precision)}
              disabled={readOnly}
              onValueChange={(v) => setDisplay('precision', Number(v), `Display precision: ${v}`)}
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Decimal places">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRECISIONS.map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Area units">
            <Select
              value={display.areaUnits}
              disabled={readOnly}
              onValueChange={(v) =>
                setDisplay('areaUnits', v as ProjectDisplay['areaUnits'], 'Change area units')
              }
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Area units">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AREA_UNIT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Angle units">
            <Select
              value={display.angleUnits}
              disabled={readOnly}
              onValueChange={(v) =>
                setDisplay('angleUnits', v as ProjectDisplay['angleUnits'], 'Change angle units')
              }
            >
              <SelectTrigger size="sm" className="w-full" aria-label="Angle units">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ANGLE_UNIT_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <p className="text-muted-foreground text-xs" data-testid="display-preview">
            Example: {fmtLength(1234.5678, display)} · {fmtArea(12345.678, display)} ·{' '}
            {fmtAngle(Math.PI / 4, display)}
          </p>
          <Separator />
          <h4 className="flex items-center gap-1.5 text-sm font-medium">
            <Compass className="size-4" /> Coordinates and north
          </h4>
          <div className="flex items-center justify-between gap-3">
            <div className="grid gap-0.5">
              <Label htmlFor="ps-plant" className="text-xs font-normal">
                Show plant coordinates (E/N) in the cursor readout
              </Label>
              <span className="text-muted-foreground text-xs">
                {plant
                  ? 'A drawing is calibrated with plant coordinates.'
                  : 'Applies once a drawing is calibrated with plant coordinates.'}
              </span>
            </div>
            <Switch
              id="ps-plant"
              checked={display.plantCoords}
              disabled={readOnly}
              onCheckedChange={(v) => setDisplay('plantCoords', v, v ? 'Show plant coordinates' : 'Show X/Y')}
            />
          </div>
          <Field label="True north">
            <NumberInput
              ariaLabel="True north bearing from plant north"
              value={trueNorthBearing}
              suffix="°"
              decimals={6}
              min={-360}
              max={360}
              disabled={readOnly}
              onCommit={(deg) => setNorth('trueNorthAngle', -degToRad(deg), 'Set true north angle')}
            />
          </Field>
          <p className="text-muted-foreground -mt-1 text-xs">
            Bearing of true north measured clockwise from plant north (e.g. 12 when true north points 12° east
            of plant north).
          </p>
          <Field label="North arrow shows">
            <RadioGroup
              value={north.arrow}
              disabled={readOnly}
              onValueChange={(v) => setNorth('arrow', v as NorthSettings['arrow'], 'Change north arrow')}
              className="flex gap-4"
              aria-label="North arrow shows"
            >
              <Label className="flex items-center gap-1.5 text-xs font-normal">
                <RadioGroupItem value="plant" /> Plant north
              </Label>
              <Label className="flex items-center gap-1.5 text-xs font-normal">
                <RadioGroupItem value="true" /> True north
              </Label>
            </RadioGroup>
          </Field>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
