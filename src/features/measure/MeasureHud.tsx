import { AlertTriangle, Copy, Ruler } from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { setTool } from '@/tools/registry';

import { PanelShell } from '@/features/calibration/panel-ui';
import { CanvasSlot } from '@/features/units/canvas-slot';
import { coordinateAxes, DEFAULT_DISPLAY } from '@/features/units/format';

import { measureGeometry, measureText, resultClipboardText, type MeasureValues } from './compute';
import { useMeasureStore } from './store';
import { MEASURE_TOOL_IDS } from './tools';

/** Result panel of the measurement tools (row 35): live while picking, then the finished result. */

function rawAttrs(v: MeasureValues): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (k: string, x: number | undefined) => {
    if (x !== undefined) out[`data-${k}`] = String(x);
  };
  put('distance', v.distance);
  put('total', v.total);
  put('area', v.area);
  put('perimeter', v.perimeter);
  put('radius', v.radius);
  put('angle', v.angle);
  put('x', v.point?.x);
  put('y', v.point?.y);
  return out;
}

export function MeasureHud() {
  const tool = useViewStore((s) => s.activeTool);
  const live = useMeasureStore((s) => s.live);
  const result = useMeasureStore((s) => s.result);
  const keep = useMeasureStore((s) => s.keep);
  const setKeep = useMeasureStore((s) => s.setKeep);
  const display = useProject((p) => p.display) ?? DEFAULT_DISPLAY;
  const plant = useProject((p) => coordinateAxes(p)[0] === 'E') ?? false;
  const axes: [string, string] = plant ? ['E', 'N'] : ['X', 'Y'];
  const uncalibrated =
    useProject((p) =>
      p.drawings
        .filter((d) => d.visible && !d.calibration)
        .map((d) => d.name)
        .join(', '),
    ) ?? '';
  if (!MEASURE_TOOL_IDS.has(tool)) return null;
  const entry = live ?? result;
  const values = entry ? measureGeometry(entry.mode, entry.geometry) : null;
  const text = values ? measureText(values, display, axes) : null;
  return (
    <CanvasSlot name="top-left">
      <PanelShell
        testId="measure-hud"
        icon={<Ruler />}
        title={text?.title ?? 'Measure'}
        subtitle={
          live ? 'Live — click to place the next point' : result ? 'Result' : 'Pick points on the drawing'
        }
        onClose={() => setTool('select')}
        className="w-[min(18rem,100%)] self-start"
      >
        <div className="grid grid-cols-1 gap-2">
          {text && values ? (
            <>
              <div
                className={cn(
                  'font-mono font-semibold whitespace-pre-line tabular-nums',
                  values.mode === 'point' ? 'text-sm leading-5' : 'text-lg leading-6',
                )}
                data-testid="measure-value"
                data-mode={values.mode}
                {...rawAttrs(values)}
              >
                {text.primary}
              </div>
              {text.details.length > 0 && (
                <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                  {text.details.map((d) => (
                    <div key={d.label} className="contents">
                      <dt className="text-muted-foreground">{d.label}</dt>
                      <dd className="text-right font-mono tabular-nums">{d.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          ) : (
            <p className="text-muted-foreground text-xs">
              Snaps to drawing geometry; type a value + Enter for exact input.
            </p>
          )}
          {uncalibrated && (
            <Badge
              variant="warning"
              className="h-auto max-w-full font-normal whitespace-normal"
              data-testid="measure-uncalibrated"
            >
              <AlertTriangle /> Uncalibrated: {uncalibrated}
            </Badge>
          )}
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <Label className="flex items-center gap-1.5 text-xs font-normal">
              <Switch
                checked={keep}
                onCheckedChange={setKeep}
                aria-label="Keep measurements as annotations"
                data-testid="measure-keep"
              />
              Keep as annotation
            </Label>
            <Button
              variant="ghost"
              size="xs"
              disabled={!text}
              onClick={() => {
                if (!text) return;
                void navigator.clipboard
                  ?.writeText(resultClipboardText(text))
                  .then(() => toast.success('Measurement copied'))
                  .catch(() => toast.error('Could not copy to the clipboard'));
              }}
            >
              <Copy /> Copy
            </Button>
          </div>
        </div>
      </PanelShell>
    </CanvasSlot>
  );
}
