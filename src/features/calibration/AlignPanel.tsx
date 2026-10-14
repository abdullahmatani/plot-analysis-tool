import { Check, Crosshair, Layers, ScanSearch } from 'lucide-react';

import { formatNumber } from '@/core/units';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import { useProject, useProjectStore } from '@/store/project';

import { DEFAULT_DISPLAY, fmtAngle, fmtLength } from '@/features/units/format';

import {
  ALIGN_STEPS,
  applySharedCoordinates,
  applyTwoPointAlignment,
  previewAlignment,
  resetAlignment,
  startAlignPicks,
  stopAlignPicks,
  zoomToDrawing,
} from './align';
import { Note, PanelShell, Row } from './panel-ui';
import { closeSession, useCalStore, type AlignSession } from './store';

/** Sub-drawing alignment panel (row 34). */

const update = (fn: (s: AlignSession) => void) => useCalStore.getState().update('align', fn);

export function AlignPanel({ s }: { s: AlignSession }) {
  const drawings = useProject((p) => p.drawings) ?? [];
  const display = useProject((p) => p.display) ?? DEFAULT_DISPLAY;
  const readOnly = useProjectStore((st) => st.readOnly);
  const sub = drawings.find((d) => d.id === s.drawingId);
  const base = drawings.find((d) => d.id === s.baseId);
  if (!sub) return null;
  const others = drawings.filter((d) => d.id !== sub.id);
  const preview = previewAlignment(s);
  const close = () => {
    stopAlignPicks();
    closeSession();
  };
  const sharedOk = sub.source.kind !== 'pdf' && !!base && (base.source.kind !== 'pdf' || !!base.calibration);
  return (
    <PanelShell
      testId="align-panel"
      icon={<Layers />}
      title={`Align “${sub.name}”`}
      subtitle="Place a sub-drawing onto the plot plan"
      onClose={close}
      footer={
        <>
          {sub.alignment && (
            <Button size="xs" variant="ghost" disabled={readOnly} onClick={() => void resetAlignment(sub.id)}>
              Remove alignment
            </Button>
          )}
          <div className="flex-1" />
          <Button size="xs" variant="outline" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="grid gap-2.5">
        <Row label="Align to">
          <Select
            value={s.baseId ?? ''}
            disabled={readOnly || !others.length}
            onValueChange={(v) =>
              update((x) => {
                x.baseId = v;
                x.dst = [null, null];
              })
            }
          >
            <SelectTrigger size="sm" className="w-full text-xs" aria-label="Align to drawing">
              <SelectValue placeholder="No other drawing" />
            </SelectTrigger>
            <SelectContent>
              {others.map((d) => (
                <SelectItem key={d.id} value={d.id}>
                  {d.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {!others.length && (
          <Note tone="warning">Import the plot plan first, then align this drawing to it.</Note>
        )}
        <Tabs value={s.mode} onValueChange={(v) => update((x) => void (x.mode = v as AlignSession['mode']))}>
          <TabsList className="w-full" aria-label="Alignment method">
            <TabsTrigger value="two-point" data-testid="align-mode-two-point">
              Two points
            </TabsTrigger>
            <TabsTrigger value="shared" data-testid="align-mode-shared">
              Shared coordinates
            </TabsTrigger>
          </TabsList>
        </Tabs>
        {s.mode === 'two-point' ? (
          <>
            <Note>
              Pick a point on “{sub.name}”, then the same feature on “{base?.name ?? 'the plot plan'}”; repeat
              for a second point far from the first. The sub-drawing is moved, rotated and scaled to match.
            </Note>
            <ol className="grid gap-1 text-xs" data-testid="align-steps">
              {ALIGN_STEPS.map((st, i) => {
                const done = !!s[st.list][st.index];
                const active = s.step === i;
                const target = st.list === 'src' ? sub : base;
                return (
                  <li
                    key={i}
                    className={cn(
                      'flex items-center gap-1.5 rounded px-1.5 py-0.5',
                      active && 'bg-accent text-accent-foreground',
                    )}
                    data-done={done ? 'true' : 'false'}
                  >
                    {done ? (
                      <Check className="text-success size-3.5" />
                    ) : (
                      <Crosshair className={cn('size-3.5', active ? 'animate-pulse' : 'opacity-40')} />
                    )}
                    <span className="flex-1">
                      {st.list === 'src'
                        ? `Point ${st.index + 1} on “${sub.name}”`
                        : `Matching point ${st.index + 1} on “${target?.name ?? '—'}”`}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="size-6"
                      aria-label={`Zoom to ${target?.name ?? 'drawing'}`}
                      title={`Zoom to “${target?.name ?? ''}”`}
                      onClick={() => zoomToDrawing(target)}
                    >
                      <ScanSearch />
                    </Button>
                  </li>
                );
              })}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              {s.step !== null ? (
                <Button size="xs" variant="secondary" onClick={stopAlignPicks}>
                  <Crosshair className="animate-pulse" /> Picking… (Esc)
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={readOnly || !base}
                  onClick={startAlignPicks}
                  data-testid="align-pick"
                >
                  <Crosshair /> {s.src[0] ? 'Pick again' : 'Pick 4 points'}
                </Button>
              )}
              <Label className="flex items-center gap-1.5 text-xs font-normal">
                <Switch
                  checked={s.keepScale}
                  disabled={readOnly}
                  onCheckedChange={(v) => update((x) => void (x.keepScale = v))}
                  aria-label="Keep the sub-drawing's scale"
                />
                Keep scale (rotate and move only)
              </Label>
            </div>
            {preview.error && <Note tone="error">{preview.error}</Note>}
            {preview.correction && (
              <Note tone="success">
                <span data-testid="align-preview">
                  Scale × {formatNumber(preview.scale ?? 1, 6)} · rotation{' '}
                  {fmtAngle(preview.rotation ?? 0, display)}
                  {s.keepScale && preview.mismatch !== undefined && (
                    <>
                      {' '}
                      · mismatch{' '}
                      {fmtLength(preview.mismatch, { ...display, precision: display.precision + 1 })}
                    </>
                  )}
                </span>
              </Note>
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                data-testid="align-apply"
                disabled={readOnly || !preview.correction}
                onClick={() => void applyTwoPointAlignment(s)}
              >
                Align
              </Button>
            </div>
          </>
        ) : (
          <>
            <Note>
              Use when “{sub.name}” is drawn in the same coordinates as “{base?.name ?? 'the plot plan'}”
              (e.g. both in plant coordinates): it gets the same units, calibration and alignment.
            </Note>
            {!sharedOk && (
              <Note tone="warning">
                Shared coordinates need CAD drawings (or a calibrated base); PDF coordinates are paper
                positions.
              </Note>
            )}
            <div className="flex justify-end">
              <Button
                size="sm"
                data-testid="align-apply"
                disabled={readOnly || !base || !sharedOk}
                onClick={() => void applySharedCoordinates(s)}
              >
                Use shared coordinates
              </Button>
            </div>
          </>
        )}
      </div>
    </PanelShell>
  );
}
