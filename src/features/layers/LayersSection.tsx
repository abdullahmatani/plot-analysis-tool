import { ArrowDown, ArrowUp, Eye, EyeOff, Lock, LockOpen, MoreHorizontal, Plus } from 'lucide-react';

import { confirmAction, promptText } from '@/app/prompt';
import { currentSession } from '@/app/session';
import { createLayer } from '@/core/project';
import type { AnalysisLayer } from '@/core/types';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ColorInput } from '@/components/inspector/fields';
import { cn } from '@/lib/utils';
import { commit, useProject, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';

/** Analysis layers (row 37): create, rename, recolour, reorder, hide, lock, delete; active layer. */

function setLayer(id: string, label: string, fn: (l: AnalysisLayer) => void) {
  commit(label, (d) => {
    const l = d.layers.find((x) => x.id === id);
    if (l) fn(l);
  });
}

export async function newLayer() {
  const p = useProjectStore.getState().history?.project;
  if (!p) return;
  const name = await promptText({
    title: 'New layer',
    label: 'Layer name',
    defaultValue: `Layer ${p.layers.length + 1}`,
  });
  if (!name) return;
  const layer = createLayer(name, p.layers.length);
  commit(`New layer “${name}”`, (d) => {
    d.layers.push(layer);
    d.activeLayerId = layer.id;
  });
}

export function LayersSection() {
  const layers = useProject((p) => p.layers) ?? [];
  const active = useProject((p) => p.activeLayerId);
  const objects = useProject((p) => p.objects) ?? [];
  const readOnly = useProjectStore((s) => s.readOnly);
  const counts = new Map<string, number>();
  for (const o of objects) counts.set(o.layerId, (counts.get(o.layerId) ?? 0) + 1);
  const ordered = [...layers].reverse();

  return (
    <section className="space-y-1" data-testid="analysis-layers">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-muted-foreground text-xs font-semibold uppercase">Analysis layers</h3>
        <Button
          variant="ghost"
          size="xs"
          disabled={readOnly}
          onClick={() => void newLayer()}
          data-testid="new-layer"
        >
          <Plus /> New
        </Button>
      </div>
      <ul className="space-y-0.5">
        {ordered.map((l) => {
          const idx = layers.indexOf(l);
          const isActive = l.id === active;
          return (
            <li
              key={l.id}
              className={cn(
                'hover:bg-accent/60 flex items-center gap-1 rounded-md border px-1 py-0.5',
                isActive && 'border-primary/50 bg-accent/40',
              )}
              data-testid={`layer-${l.name}`}
            >
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={l.visible ? `Hide layer ${l.name}` : `Show layer ${l.name}`}
                disabled={readOnly}
                onClick={() =>
                  setLayer(
                    l.id,
                    `${l.visible ? 'Hide' : 'Show'} layer “${l.name}”`,
                    (x) => void (x.visible = !x.visible),
                  )
                }
              >
                {l.visible ? <Eye /> : <EyeOff className="opacity-50" />}
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={l.locked ? `Unlock layer ${l.name}` : `Lock layer ${l.name}`}
                disabled={readOnly}
                onClick={() => {
                  setLayer(
                    l.id,
                    `${l.locked ? 'Unlock' : 'Lock'} layer “${l.name}”`,
                    (x) => void (x.locked = !x.locked),
                  );
                  if (!l.locked) {
                    const sel = useViewStore.getState().selection;
                    const onLayer = new Set(objects.filter((o) => o.layerId === l.id).map((o) => o.id));
                    useViewStore.getState().set({ selection: sel.filter((id) => !onLayer.has(id)) });
                  }
                }}
              >
                {l.locked ? <Lock /> : <LockOpen className="opacity-40" />}
              </Button>
              <Popover>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    disabled={readOnly}
                    aria-label={`Colour of layer ${l.name}`}
                    className="size-4 shrink-0 rounded-sm border"
                    style={{
                      background: l.style.fill,
                      outline: `2px solid ${l.style.stroke}`,
                      outlineOffset: -2,
                    }}
                  />
                </PopoverTrigger>
                <PopoverContent className="w-64 space-y-2 text-xs">
                  <div>Outline</div>
                  <ColorInput
                    value={l.style.stroke}
                    onCommit={(c) =>
                      setLayer(l.id, `Recolour layer “${l.name}”`, (x) => void (x.style.stroke = c))
                    }
                  />
                  <div>Fill</div>
                  <ColorInput
                    value={l.style.fill}
                    onCommit={(c) =>
                      setLayer(l.id, `Recolour layer “${l.name}”`, (x) => void (x.style.fill = c))
                    }
                  />
                </PopoverContent>
              </Popover>
              <button
                type="button"
                className="min-w-0 flex-1 truncate text-left text-sm"
                title={isActive ? 'Active layer (new objects go here)' : 'Click to make active'}
                onClick={() =>
                  !readOnly &&
                  !isActive &&
                  commit(`Activate layer “${l.name}”`, (d) => void (d.activeLayerId = l.id))
                }
                onDoubleClick={async () => {
                  const name = await promptText({
                    title: 'Rename layer',
                    label: 'Name',
                    defaultValue: l.name,
                  });
                  if (name) setLayer(l.id, `Rename layer to “${name}”`, (x) => void (x.name = name));
                }}
              >
                {isActive && <span className="text-primary mr-1">●</span>}
                {l.name}
              </button>
              <span className="text-muted-foreground text-xs tabular-nums">{counts.get(l.id) ?? 0}</span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Layer options for ${l.name}`}
                    disabled={readOnly}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem
                    onSelect={() =>
                      commit(`Activate layer “${l.name}”`, (d) => void (d.activeLayerId = l.id))
                    }
                  >
                    Make active
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={async () => {
                      const name = await promptText({
                        title: 'Rename layer',
                        label: 'Name',
                        defaultValue: l.name,
                      });
                      if (name) setLayer(l.id, `Rename layer to “${name}”`, (x) => void (x.name = name));
                    }}
                  >
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() => {
                      const ids = objects.filter((o) => o.layerId === l.id).map((o) => o.id);
                      useViewStore.getState().set({ selection: l.locked ? [] : ids });
                    }}
                  >
                    Select objects on layer
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      setLayer(l.id, `Legend for “${l.name}”`, (x) => void (x.legend.show = !x.legend.show))
                    }
                  >
                    {l.legend.show ? 'Hide from legend' : 'Show in legend'}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={idx === layers.length - 1} onSelect={() => moveLayer(l.id, 1)}>
                    <ArrowUp /> Move up (draw above)
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={idx === 0} onSelect={() => moveLayer(l.id, -1)}>
                    <ArrowDown /> Move down
                  </DropdownMenuItem>
                  {layers.length > 1 && (
                    <DropdownMenuSub>
                      <DropdownMenuSubTrigger>Move selected objects here</DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        <DropdownMenuItem
                          onSelect={() => {
                            const sel = new Set(useViewStore.getState().selection);
                            commit(`Move objects to “${l.name}”`, (d) => {
                              for (const o of d.objects) if (sel.has(o.id)) o.layerId = l.id;
                            });
                          }}
                        >
                          Move {useViewStore.getState().selection.length} selected object(s)
                        </DropdownMenuItem>
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  )}
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={layers.length <= 1}
                    onSelect={async () => {
                      const n = counts.get(l.id) ?? 0;
                      const ok = await confirmAction({
                        title: `Delete layer “${l.name}”?`,
                        description: n
                          ? `Its ${n} object(s) are deleted too. This can be undone.`
                          : 'This can be undone.',
                        confirmLabel: 'Delete layer',
                        destructive: true,
                      });
                      if (!ok) return;
                      if (n > 10) await currentSession()?.beforeHighImpact(`deleting layer “${l.name}”`);
                      commit(`Delete layer “${l.name}”`, (d) => {
                        d.layers = d.layers.filter((x) => x.id !== l.id);
                        d.objects = d.objects.filter((o) => o.layerId !== l.id);
                        if (d.activeLayerId === l.id) d.activeLayerId = d.layers[d.layers.length - 1].id;
                      });
                    }}
                  >
                    Delete layer
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function moveLayer(id: string, delta: number) {
  commit('Reorder layers', (d) => {
    const i = d.layers.findIndex((l) => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= d.layers.length) return;
    const [l] = d.layers.splice(i, 1);
    d.layers.splice(j, 0, l);
  });
}
