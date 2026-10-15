import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  Ghost,
  MoreHorizontal,
  Search,
  Crosshair,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from 'lucide-react';

import { transformBounds } from '@/core/affine';
import type { Drawing } from '@/core/types';
import { showReport, reloadModel } from '@/import/import-drawing';
import { promptText, confirmAction } from '@/app/prompt';
import { currentSession } from '@/app/session';
import { canvasController } from '@/render/canvas-controller';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { commit, useProject, useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';
import { calibrationState, useModelsStore } from '@/underlay/models';
import { drawingPlacement } from '@/underlay/pick';

/** Drawings and their source layers / PDF optional-content groups (row 19). Underlays are read-only. */
export function DrawingsSection() {
  const drawings = useProject((p) => p.drawings) ?? [];
  const sorted = [...drawings].sort((a, b) => b.order - a.order);
  return (
    <section className="space-y-1" data-testid="drawings-section">
      <h3 className="text-muted-foreground px-1 text-xs font-semibold uppercase">Drawings</h3>
      {sorted.length === 0 && (
        <p className="text-muted-foreground px-1 text-xs">
          No drawings. Import a DXF, DWG or PDF (Ctrl+I) or drop it on the canvas.
        </p>
      )}
      {sorted.map((d) => (
        <DrawingRow key={d.id} drawing={d} />
      ))}
    </section>
  );
}

function setDrawing(id: string, label: string, fn: (d: Drawing) => void, coalesceKey?: string) {
  commit(
    label,
    (p) => {
      const d = p.drawings.find((x) => x.id === id);
      if (d) fn(d);
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

function DrawingRow({ drawing: d }: { drawing: Drawing }) {
  const [open, setOpen] = useState(false);
  const model = useModelsStore((s) => s.models[d.id]);
  const readOnly = useProjectStore((s) => s.readOnly);
  const calib = calibrationState(d);
  const layouts = model?.result?.layouts ?? [];
  return (
    <div className="rounded-md border" data-testid={`drawing-${d.name}`}>
      <div className="flex items-center gap-1 px-1 py-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => setOpen(!open)}
          aria-label={open ? 'Collapse' : 'Expand'}
          aria-expanded={open}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={d.visible ? `Hide ${d.name}` : `Show ${d.name}`}
          disabled={readOnly}
          onClick={() =>
            setDrawing(
              d.id,
              d.visible ? `Hide “${d.name}”` : `Show “${d.name}”`,
              (x) => void (x.visible = !x.visible),
            )
          }
        >
          {d.visible ? <Eye /> : <EyeOff className="opacity-50" />}
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm" title={d.source.fileName}>
            {d.name}
          </div>
          <div className="text-muted-foreground flex items-center gap-1 text-[11px]">
            {d.source.kind.toUpperCase()}
            {model?.status === 'loading' && <span>· loading…</span>}
            {model?.status === 'error' && (
              <span className="text-destructive" title={model.error} data-testid="drawing-not-loaded">
                · not loaded
              </span>
            )}
            {model?.result?.page?.raster && (
              <span className="text-warning">· raster — snapping unavailable</span>
            )}
          </div>
        </div>
        <Badge
          variant={calib === 'uncalibrated' ? 'warning' : calib === 'verified' ? 'success' : 'outline'}
          className="font-normal"
        >
          {calib === 'uncalibrated' ? 'Uncal.' : calib === 'verified' ? 'Verified' : 'Cal.'}
        </Badge>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" aria-label={`Drawing options for ${d.name}`}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuLabel>{d.source.fileName}</DropdownMenuLabel>
            {model?.status === 'error' && (
              <DropdownMenuItem onSelect={() => void reloadModel(d)}>
                <RefreshCw /> Load again
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                const m = useModelsStore.getState().models[d.id];
                if (m?.result)
                  canvasController()?.zoomToBounds(transformBounds(drawingPlacement(d), m.result.extents));
              }}
            >
              <Crosshair /> Zoom to drawing
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => model?.result && showReport(d.name, model.result.report, model.result.version)}
              disabled={!model?.result}
            >
              Import report
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly}
              onSelect={() => useUiStore.getState().openDialog('calibrate', { drawingId: d.id })}
            >
              Calibrate scale…
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={readOnly}
              onSelect={() => useUiStore.getState().openDialog('align', { drawingId: d.id })}
            >
              Align to another drawing…
            </DropdownMenuItem>
            {layouts.length > 1 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Layout</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {layouts.map((l) => (
                    <DropdownMenuItem
                      key={l}
                      disabled={readOnly}
                      onSelect={() => {
                        setDrawing(
                          d.id,
                          `Show layout “${l}”`,
                          (x) => void (x.layout = l === 'Model' ? undefined : l),
                        );
                        void reloadModel({ ...d, layout: l === 'Model' ? undefined : l });
                      }}
                    >
                      {(d.layout ?? 'Model') === l ? '● ' : ''}
                      {l}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              disabled={readOnly}
              onSelect={async () => {
                const name = await promptText({
                  title: 'Rename drawing',
                  label: 'Name',
                  defaultValue: d.name,
                });
                if (name) setDrawing(d.id, `Rename drawing to “${name}”`, (x) => void (x.name = name));
              }}
            >
              Rename…
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              disabled={readOnly}
              onSelect={async () => {
                const ok = await confirmAction({
                  title: `Remove “${d.name}”?`,
                  description:
                    'The drawing is removed from this project (undoable). Analysis objects stay where they are.',
                  confirmLabel: 'Remove',
                  destructive: true,
                });
                if (!ok) return;
                await currentSession()?.beforeHighImpact(`removing drawing “${d.name}”`);
                commit(`Remove drawing “${d.name}”`, (p) => {
                  p.drawings = p.drawings.filter((x) => x.id !== d.id);
                });
              }}
            >
              Remove from project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="space-y-2 border-t px-2 py-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="w-14">Opacity</span>
            <Slider
              value={[Math.round(d.opacity * 100)]}
              min={5}
              max={100}
              step={5}
              disabled={readOnly}
              onValueChange={([v]) =>
                setDrawing(
                  d.id,
                  `Opacity of “${d.name}”`,
                  (x) => void (x.opacity = v / 100),
                  `opacity-${d.id}`,
                )
              }
              aria-label="Underlay opacity"
            />
            <span className="w-8 text-right tabular-nums">{Math.round(d.opacity * 100)}%</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <Button
              variant={d.ghost ? 'secondary' : 'outline'}
              size="xs"
              aria-pressed={d.ghost}
              disabled={readOnly}
              onClick={() =>
                setDrawing(
                  d.id,
                  d.ghost ? 'Normal colours' : 'Ghost (greyscale) mode',
                  (x) => void (x.ghost = !x.ghost),
                )
              }
            >
              <Ghost /> Ghost
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label="Bring forward"
                  disabled={readOnly}
                  onClick={() => moveOrder(d.id, 1)}
                >
                  <ArrowUp />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Draw above</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="icon-xs"
                  aria-label="Send backward"
                  disabled={readOnly}
                  onClick={() => moveOrder(d.id, -1)}
                >
                  <ArrowDown />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Draw below</TooltipContent>
            </Tooltip>
          </div>
          <SourceLayers drawing={d} />
        </div>
      )}
    </div>
  );
}

function moveOrder(id: string, delta: number) {
  commit('Change drawing order', (p) => {
    const list = [...p.drawings].sort((a, b) => a.order - b.order);
    const i = list.findIndex((x) => x.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    list.forEach((x, k) => {
      const t = p.drawings.find((y) => y.id === x.id)!;
      t.order = k;
    });
  });
}

function SourceLayers({ drawing: d }: { drawing: Drawing }) {
  const model = useModelsStore((s) => s.models[d.id]);
  const readOnly = useProjectStore((s) => s.readOnly);
  const [q, setQ] = useState('');
  const layers = useMemo(() => {
    const store = model?.result?.store;
    if (!store) return [];
    const counts = new Map<number, number>();
    for (let i = 0; i < store.count; i++) counts.set(store.layer[i], (counts.get(store.layer[i]) ?? 0) + 1);
    return store.layers.map((l, i) => ({
      key: l.ocgId ?? l.name,
      name: l.name,
      color: l.color,
      count: counts.get(i) ?? 0,
    }));
  }, [model?.result?.store]);
  const hidden = new Set(d.hiddenSourceLayers);
  const filtered = layers.filter((l) => l.name.toLowerCase().includes(q.toLowerCase()));
  const label = d.source.kind === 'pdf' ? 'PDF layers' : 'Source layers';
  if (!layers.length) return <p className="text-muted-foreground text-xs">No layers.</p>;
  const setHidden = (keys: string[], text: string) =>
    setDrawing(d.id, text, (x) => {
      x.hiddenSourceLayers = keys;
    });
  return (
    <div className="space-y-1" data-testid="source-layers">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium">
          {label} ({layers.length})
        </span>
        <div className="flex gap-1">
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly}
            onClick={() => setHidden([], 'Show all source layers')}
          >
            All
          </Button>
          <Button
            variant="ghost"
            size="xs"
            disabled={readOnly}
            onClick={() =>
              setHidden(
                layers.map((l) => l.key),
                'Hide all source layers',
              )
            }
          >
            None
          </Button>
        </div>
      </div>
      {layers.length > 8 && (
        <div className="relative">
          <Search className="text-muted-foreground absolute top-2 left-2 size-3.5" />
          <Input
            className="h-7 pl-7 text-xs"
            placeholder="Search layers"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}
      <ul className="max-h-64 overflow-auto text-xs">
        {filtered.map((l) => (
          <li
            key={l.key}
            className={cn(
              'hover:bg-accent group flex items-center gap-1.5 rounded px-1 py-0.5',
              hidden.has(l.key) && 'opacity-60',
            )}
          >
            <Checkbox
              checked={!hidden.has(l.key)}
              disabled={readOnly}
              aria-label={`Show layer ${l.name}`}
              onCheckedChange={(v) =>
                setHidden(
                  v ? d.hiddenSourceLayers.filter((k) => k !== l.key) : [...d.hiddenSourceLayers, l.key],
                  `${v ? 'Show' : 'Hide'} layer “${l.name}”`,
                )
              }
            />
            <span
              className="size-2.5 shrink-0 rounded-sm border"
              style={{ background: `#${l.color.toString(16).padStart(6, '0')}` }}
            />
            <span className="flex-1 truncate" title={l.name}>
              {l.name}
            </span>
            <span className="text-muted-foreground tabular-nums">{l.count}</span>
            <Button
              variant="ghost"
              size="xs"
              className="h-5 px-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
              disabled={readOnly}
              onClick={() =>
                setHidden(
                  layers.filter((x) => x.key !== l.key).map((x) => x.key),
                  `Isolate layer “${l.name}”`,
                )
              }
            >
              Isolate
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
