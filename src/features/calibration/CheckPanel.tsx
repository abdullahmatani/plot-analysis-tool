import { CheckCircle2, Crosshair, ShieldCheck, XCircle } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useProject, useProjectStore } from '@/store/project';
import { calibrationState } from '@/underlay/models';

import { DEFAULT_DISPLAY, fmtLength } from '@/features/units/format';

import { defaultTolerance, measuredDistance, runCheck, startCheckPicks, stopCheckPicks } from './check';
import { Note, PanelShell, Row, StateBadge } from './panel-ui';
import { closeSession, parseDisplayLength, useCalStore, type CheckSession } from './store';

/** "Check distance" panel (row 32). */

const update = (fn: (s: CheckSession) => void) => useCalStore.getState().update('check', fn);

export function CheckPanel({ s }: { s: CheckSession }) {
  const drawings = useProject((p) => p.drawings) ?? [];
  const display = useProject((p) => p.display) ?? DEFAULT_DISPLAY;
  const readOnly = useProjectStore((st) => st.readOnly);
  const [keep, setKeep] = useState(false);
  const measured = measuredDistance(s);
  const expected = parseDisplayLength(s.value);
  const d = drawings.find((x) => x.id === s.drawingId);
  const close = () => {
    stopCheckPicks();
    closeSession();
  };
  return (
    <PanelShell
      testId="check-panel"
      icon={<ShieldCheck />}
      title="Check distance"
      subtitle="Verify the calibration against another known dimension"
      onClose={close}
      footer={
        <>
          <div className="flex-1" />
          <Button size="xs" variant="outline" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {s.picking ? (
            <Button size="xs" variant="secondary" onClick={stopCheckPicks}>
              <Crosshair className="animate-pulse" /> Picking… (Esc)
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={startCheckPicks} data-testid="check-pick">
              <Crosshair /> {measured === null ? 'Pick 2 points' : 'Pick again'}
            </Button>
          )}
          <span className="text-xs" data-testid="check-measured">
            {measured === null ? (
              <span className="text-muted-foreground">Nothing measured yet</span>
            ) : (
              <>
                Measured{' '}
                <strong className="tabular-nums">
                  {fmtLength(measured, { ...display, precision: display.precision + 1 })}
                </strong>
              </>
            )}
          </span>
        </div>
        <Row label="Drawing">
          <Select
            value={s.drawingId ?? ''}
            onValueChange={(v) => update((x) => void (x.drawingId = v))}
            disabled={readOnly}
          >
            <SelectTrigger size="sm" className="w-full text-xs" aria-label="Drawing to verify">
              <SelectValue placeholder="Choose a drawing" />
            </SelectTrigger>
            <SelectContent>
              {drawings.map((x) => (
                <SelectItem key={x.id} value={x.id}>
                  {x.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {d && (
          <div className="-mt-1 flex justify-end">
            <StateBadge state={calibrationState(d)} />
          </div>
        )}
        <Row label="Known distance" htmlFor="check-known">
          <div className="flex items-center gap-1">
            <Input
              id="check-known"
              data-testid="check-known"
              className="h-7 text-xs"
              placeholder={`e.g. 50 (${display.units})`}
              value={s.value}
              disabled={readOnly}
              onChange={(e) => update((x) => void (x.value = e.target.value))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runCheck(keep);
              }}
            />
            <span className="text-muted-foreground w-6 text-xs">{display.units}</span>
          </div>
        </Row>
        <Row label="Tolerance" htmlFor="check-tol">
          <div className="flex items-center gap-1">
            <Input
              id="check-tol"
              data-testid="check-tolerance"
              className="h-7 text-xs"
              placeholder={
                expected
                  ? fmtLength(defaultTolerance(expected), { ...display, precision: display.precision + 2 })
                  : 'auto'
              }
              value={s.tolerance}
              disabled={readOnly}
              onChange={(e) => update((x) => void (x.tolerance = e.target.value))}
            />
            <span className="text-muted-foreground w-6 text-xs">{display.units}</span>
          </div>
        </Row>
        <Label className="flex items-center gap-1.5 text-xs font-normal">
          <Switch checked={keep} onCheckedChange={setKeep} aria-label="Keep as measurement annotation" />
          Keep as measurement annotation
        </Label>
        {s.result && (
          <div data-testid="check-result" data-pass={s.result.pass ? 'true' : 'false'}>
            <Note tone={s.result.pass ? 'success' : 'warning'}>
              <span className="flex items-start gap-1.5">
                {s.result.pass ? (
                  <CheckCircle2 className="text-success mt-px size-3.5 shrink-0" />
                ) : (
                  <XCircle className="text-destructive mt-px size-3.5 shrink-0" />
                )}
                <span>
                  Difference{' '}
                  <strong className="tabular-nums">
                    {s.result.diff >= 0 ? '+' : ''}
                    {fmtLength(s.result.diff, { ...display, precision: display.precision + 2 })}
                  </strong>{' '}
                  (tolerance ±
                  {fmtLength(s.result.tolerance, { ...display, precision: display.precision + 2 })}).{' '}
                  {s.result.pass
                    ? d
                      ? `“${d.name}” is verified.`
                      : 'Within tolerance.'
                    : 'Outside tolerance.'}
                </span>
              </span>
            </Note>
          </div>
        )}
        <div className="flex justify-end">
          <Button
            size="sm"
            data-testid="check-run"
            disabled={readOnly || measured === null || !(expected && expected > 0)}
            onClick={() => runCheck(keep)}
          >
            Check
          </Button>
        </div>
      </div>
    </PanelShell>
  );
}
