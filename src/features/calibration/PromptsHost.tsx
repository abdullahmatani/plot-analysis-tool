import { AlertTriangle, MoveDiagonal, Pin } from 'lucide-react';

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

import { usePrompts } from './prompts';

/** Renders the calibration guard (row 32) and the recalibration choice (row 33). */
export function PromptsHost() {
  const guard = usePrompts((s) => s.guard);
  const recal = usePrompts((s) => s.recal);
  return (
    <>
      <AlertDialog open={!!guard} onOpenChange={(o) => !o && guard?.resolve('cancel')}>
        <AlertDialogContent data-testid="calibration-guard">
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <AlertTriangle className="text-warning size-5" /> Drawing not calibrated
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2 text-sm">
                <p>
                  “{guard?.action}” uses distances, but{' '}
                  {guard && guard.drawings.length === 1 ? 'this drawing is' : 'these drawings are'} not
                  calibrated. Results are in{' '}
                  {guard?.drawings.some((d) => d.kind === 'PDF') ? 'paper units (1:1) or ' : ''}the file's
                  unconfirmed units and are marked uncalibrated.
                </p>
                <ul className="list-disc pl-5">
                  {guard?.drawings.map((d) => (
                    <li key={d.id}>
                      <span className="text-foreground font-medium">{d.name}</span> · {d.kind}
                      {d.units ? ` · ${d.units}` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap gap-2">
            <Button variant="ghost" onClick={() => guard?.resolve('cancel')}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => guard?.resolve('continue')} data-testid="guard-continue">
              Continue uncalibrated
            </Button>
            {guard?.confirmable && (
              <Button
                variant="outline"
                onClick={() => guard?.resolve('confirm-units')}
                data-testid="guard-confirm-units"
              >
                Confirm file units
              </Button>
            )}
            <Button onClick={() => guard?.resolve('calibrate')} data-testid="guard-calibrate">
              Calibrate…
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!recal} onOpenChange={(o) => !o && recal?.resolve(null)}>
        <AlertDialogContent data-testid="recalibration-prompt">
          <AlertDialogHeader>
            <AlertDialogTitle>Move analysis objects with the drawing?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="grid gap-2 text-sm">
                <p>
                  “{recal?.drawingName}” will move in the world.{' '}
                  {recal && describe(recal.objects, recal.anchors)} on it.
                </p>
                <p>
                  <strong className="text-foreground">Move with drawing</strong> keeps them on the same
                  drawing features (they are transformed exactly).{' '}
                  <strong className="text-foreground">Keep in place</strong> leaves their world coordinates
                  unchanged. Either way this is one undo step.
                </p>
                {recal?.distorting && (
                  <p className="text-warning">
                    The change is not a uniform scale/rotation: moved circles become ellipses and arcs become
                    polylines.
                  </p>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="flex-wrap gap-2">
            <Button variant="ghost" onClick={() => recal?.resolve(null)}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => recal?.resolve('keep')} data-testid="recal-keep">
              <Pin /> Keep in place
            </Button>
            <Button onClick={() => recal?.resolve('move')} data-testid="recal-move">
              <MoveDiagonal /> Move with drawing
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function describe(objects: number, anchors: number): string {
  const parts: string[] = [];
  if (objects) parts.push(`${objects} analysis object${objects === 1 ? '' : 's'}`);
  if (anchors) parts.push(`${anchors} anchor${anchors === 1 ? '' : 's'}`);
  return `${parts.join(' and ')} ${objects + anchors === 1 ? 'lies' : 'lie'}`;
}
