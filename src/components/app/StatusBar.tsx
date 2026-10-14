import { Magnet } from 'lucide-react';

import { formatNumber, UNIT_LABEL, fromMetres } from '@/core/units';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useProject } from '@/store/project';
import { useViewStore } from '@/store/view';

import { CalibrationBadge } from './CalibrationBadge';
import { SaveStatusBadge } from './SaveStatusBadge';
import { SnapMenu } from './SnapMenu';

/** Status bar (§6.1): cursor coordinates, calibration state, snap toggle, zoom, save status. */
export function StatusBar() {
  const cursor = useViewStore((s) => s.cursor);
  const scale = useViewStore((s) => s.view.scale);
  const snap = useViewStore((s) => s.snapEnabled);
  const ortho = useViewStore((s) => s.ortho);
  const polar = useViewStore((s) => s.polar);
  const set = useViewStore((s) => s.set);
  const display = useProject((p) => p.display);
  const units = display?.units ?? 'm';
  const precision = display?.precision ?? 2;

  const coord = (v: number) => formatNumber(fromMetres(v, units), precision + 1);
  // Zoom % relative to 1:1 paper at 96 dpi (1 m world shown as 1 m on screen would be 3780 px).
  const zoomPct = Math.round((scale / (96 / 0.0254)) * 100 * 1000) / 1000;

  return (
    <footer
      className="bg-background flex h-8 shrink-0 items-center gap-2 border-t px-2 text-xs"
      data-testid="status-bar"
    >
      <div className="min-w-[19rem] font-mono tabular-nums" data-testid="cursor-coords">
        {cursor ? (
          <>
            X {coord(cursor.x)} Y {coord(cursor.y)} {UNIT_LABEL[units]}
          </>
        ) : (
          <span className="text-muted-foreground">X — Y —</span>
        )}
      </div>
      <CalibrationBadge />
      <div className="flex items-center gap-0.5">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-pressed={snap}
              onClick={() => set({ snapEnabled: !snap })}
              className={cn(!snap && 'text-muted-foreground')}
              data-testid="snap-toggle"
            >
              <Magnet /> Snap {snap ? '●' : '○'}
            </Button>
          </TooltipTrigger>
          <TooltipContent>Object snap (F3)</TooltipContent>
        </Tooltip>
        <SnapMenu />
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={ortho}
          onClick={() => set({ ortho: !ortho, polar: false })}
          className={cn(!ortho && 'text-muted-foreground')}
        >
          Ortho
        </Button>
        <Button
          variant="ghost"
          size="xs"
          aria-pressed={polar}
          onClick={() => set({ polar: !polar, ortho: false })}
          className={cn(!polar && 'text-muted-foreground')}
        >
          Polar
        </Button>
      </div>
      <div className="text-muted-foreground tabular-nums" title="Zoom (100% = 1:1 at 96 dpi)">
        {zoomPct >= 1 ? `${formatNumber(zoomPct, zoomPct < 10 ? 1 : 0)}%` : `${zoomPct.toPrecision(2)}%`}
      </div>
      <div className="flex-1" />
      <SaveStatusBadge />
    </footer>
  );
}
