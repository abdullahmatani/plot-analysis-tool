import { ChevronUp } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ALL_SNAP_MODES, useViewStore, type SnapMode } from '@/store/view';

const LABELS: Record<SnapMode, string> = {
  endpoint: 'Endpoint',
  midpoint: 'Midpoint',
  centre: 'Centre',
  quadrant: 'Quadrant',
  intersection: 'Intersection',
  nearest: 'Nearest',
  perpendicular: 'Perpendicular',
  tangent: 'Tangent',
};

/** Snap mode toggles (row 27), polar increment and grid size. */
export function SnapMenu() {
  const modes = useViewStore((s) => s.snapModes);
  const polarInc = useViewStore((s) => s.polarIncrementDeg);
  const gridSnap = useViewStore((s) => s.gridSnap);
  const gridSize = useViewStore((s) => s.gridSize);
  const set = useViewStore((s) => s.set);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-xs" aria-label="Snap settings" data-testid="snap-menu">
          <ChevronUp />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        <DropdownMenuLabel>Object snaps (Alt suspends)</DropdownMenuLabel>
        {ALL_SNAP_MODES.map((m) => (
          <DropdownMenuCheckboxItem
            key={m}
            checked={modes.includes(m)}
            onSelect={(e) => e.preventDefault()}
            onCheckedChange={(v) => set({ snapModes: v ? [...modes, m] : modes.filter((x) => x !== m) })}
          >
            {LABELS[m]}
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Polar increment</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={String(polarInc)}
          onValueChange={(v) => set({ polarIncrementDeg: Number(v) })}
        >
          {[5, 10, 15, 22.5, 30, 45, 90].map((d) => (
            <DropdownMenuRadioItem key={d} value={String(d)} onSelect={(e) => e.preventDefault()}>
              {d}°
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuCheckboxItem
          checked={gridSnap}
          onSelect={(e) => e.preventDefault()}
          onCheckedChange={(v) => set({ gridSnap: v })}
        >
          Grid snap (F9)
        </DropdownMenuCheckboxItem>
        <DropdownMenuLabel className="font-normal">Grid size</DropdownMenuLabel>
        <DropdownMenuRadioGroup value={String(gridSize)} onValueChange={(v) => set({ gridSize: Number(v) })}>
          {[0.1, 0.5, 1, 5, 10, 50].map((d) => (
            <DropdownMenuRadioItem key={d} value={String(d)} onSelect={(e) => e.preventDefault()}>
              {d} m
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
