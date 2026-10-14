import { CircleDot, Crosshair, Eye, EyeOff, MoreHorizontal, Search, Trash2, ZoomIn } from 'lucide-react';
import { useMemo, useState } from 'react';

import { confirmAction, promptText } from '@/app/prompt';
import type { Anchor } from '@/core/types';
import { formatNumber, fromMetres, parseLength } from '@/core/units';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { canvasController } from '@/render/canvas-controller';
import { useProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';
import { normaliseAnchorName } from '@/tables/access';
import { setTool } from '@/tools/registry';

import { anchorUsage, deleteAnchors, moveAnchor, renameWithToast } from './ops';
import { CIRCLES_TOOL, PLACE_TOOL, useAnchorsUi } from './tools';

/** Layers tab: anchors list (row 47) — place, bulk-create from circles, rename, move, delete, zoom. */

function zoomToAnchor(a: Anchor) {
  const c = canvasController();
  if (!c) return;
  const v = useViewStore.getState().view;
  const half = Math.max(5, 40 / Math.max(v.scale, 1e-9));
  c.zoomToBounds({ minX: a.p.x - half, minY: a.p.y - half, maxX: a.p.x + half, maxY: a.p.y + half });
}

async function rename(a: Anchor) {
  const name = await promptText({
    title: 'Rename anchor',
    description: 'Dataset rows that reference this anchor are renamed too.',
    label: 'Anchor name',
    defaultValue: a.name,
  });
  if (name) renameWithToast(a.id, name);
}

export function AnchorsSection() {
  const anchors = useProject((p) => p.anchors) ?? [];
  const datasets = useProject((p) => p.datasets);
  const display = useProject((p) => p.display);
  const readOnly = useProjectStore((s) => s.readOnly);
  const show = useAnchorsUi((s) => s.showOnCanvas);
  const [q, setQ] = useState('');
  const usage = useMemo(() => anchorUsage(datasets ?? []), [datasets]);
  const shown = q.trim()
    ? anchors.filter((a) => normaliseAnchorName(a.name).includes(normaliseAnchorName(q)))
    : anchors;
  const fmt = (v: number) =>
    display ? formatNumber(fromMetres(v, display.units), display.precision) : String(v);

  return (
    <section className="space-y-1" data-testid="anchors-section">
      <div className="flex items-center justify-between gap-1 px-1">
        <h3 className="text-muted-foreground text-xs font-semibold uppercase">
          Anchors <span className="font-normal">({anchors.length})</span>
        </h3>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={show ? 'Hide anchors on the canvas' : 'Show anchors on the canvas'}
            onClick={() => useAnchorsUi.getState().set({ showOnCanvas: !show })}
          >
            {show ? <Eye /> : <EyeOff className="opacity-50" />}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly}
            onClick={() => setTool(PLACE_TOOL)}
            data-testid="anchor-place"
            title="Place a named anchor (snaps to centres)"
          >
            <Crosshair /> Place
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly}
            onClick={() => setTool(CIRCLES_TOOL)}
            data-testid="anchor-from-circles"
            title="Create anchors at picked circle centres"
          >
            <CircleDot /> Circles
          </Button>
        </div>
      </div>
      {anchors.length === 0 ? (
        <p className="text-muted-foreground px-1 text-xs">
          Anchors are named points (e.g. P-101) that table rows can reference instead of coordinates.
        </p>
      ) : (
        <>
          {anchors.length > 8 && (
            <div className="relative px-1">
              <Search className="text-muted-foreground absolute top-1/2 left-3 size-3.5 -translate-y-1/2" />
              <Input
                aria-label="Search anchors"
                className="h-7 pl-7 text-xs"
                placeholder="Search anchors"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.stopPropagation()}
              />
            </div>
          )}
          <ul className="max-h-64 space-y-0.5 overflow-auto" aria-label="Anchors" data-testid="anchor-list">
            {shown.map((a) => {
              const n = usage.get(normaliseAnchorName(a.name)) ?? 0;
              return (
                <li
                  key={a.id}
                  className="hover:bg-accent/60 flex items-center gap-1 rounded-md border px-1.5 py-0.5"
                  data-testid={`anchor-${a.name}`}
                  onMouseEnter={() => useAnchorsUi.getState().set({ hoverId: a.id })}
                  onMouseLeave={() => useAnchorsUi.getState().set({ hoverId: null })}
                >
                  <span className="text-primary text-xs">◆</span>
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-sm"
                    dir="auto"
                    title="Click to zoom, double-click to rename"
                    onClick={() => zoomToAnchor(a)}
                    onDoubleClick={() => !readOnly && void rename(a)}
                  >
                    {a.name}
                  </button>
                  <span className="text-muted-foreground text-[11px] tabular-nums" title="Position">
                    {fmt(a.p.x)}, {fmt(a.p.y)}
                  </span>
                  {n > 0 && (
                    <span
                      className="bg-muted text-muted-foreground rounded px-1 text-[10px] tabular-nums"
                      title={`${n} dataset row(s) reference this anchor`}
                    >
                      {n}
                    </span>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon-xs" aria-label={`Anchor options for ${a.name}`}>
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => zoomToAnchor(a)}>
                        <ZoomIn /> Zoom to anchor
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={readOnly} onSelect={() => void rename(a)}>
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        disabled={readOnly}
                        onSelect={async () => {
                          const u = display?.units ?? 'm';
                          const v = await promptText({
                            title: `Move anchor “${a.name}”`,
                            label: 'Coordinates (x, y)',
                            defaultValue: `${fromMetres(a.p.x, u)}, ${fromMetres(a.p.y, u)}`,
                          });
                          if (!v) return;
                          const parts = v.split(/[,;]\s*|\s+/).filter(Boolean);
                          const x = parts[0] !== undefined ? parseLength(parts[0], u) : null;
                          const y = parts[1] !== undefined ? parseLength(parts[1], u) : null;
                          if (x !== null && y !== null) moveAnchor(a.id, { x, y });
                        }}
                      >
                        Set coordinates…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        disabled={readOnly}
                        onSelect={async () => {
                          if (n > 0) {
                            const ok = await confirmAction({
                              title: `Delete anchor “${a.name}”?`,
                              description: `${n} dataset row(s) reference it and will be listed as unmatched. This can be undone.`,
                              confirmLabel: 'Delete anchor',
                              destructive: true,
                            });
                            if (!ok) return;
                          }
                          deleteAnchors([a.id]);
                        }}
                      >
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
