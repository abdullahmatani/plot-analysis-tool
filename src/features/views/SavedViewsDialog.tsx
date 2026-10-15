import { Crosshair, Pencil, RefreshCw, Trash2 } from 'lucide-react';

import { runCommand } from '@/app/commands';
import { confirmAction, promptText } from '@/app/prompt';
import { goToView } from '@/app/view-commands';
import type { SavedView } from '@/core/types';
import { formatLength, radToDeg } from '@/core/units';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { commit, useProjectStore } from '@/store/project';
import { useViewStore } from '@/store/view';

/** View → Saved views (row 17): go to, update, rename and delete saved views. Each edit is one undo step. */

function updateView(v: SavedView) {
  const cur = useViewStore.getState().view;
  commit(`Update view “${v.name}”`, (d) => {
    const t = d.views.find((x) => x.id === v.id);
    if (!t) return;
    t.centre = { x: cur.cx, y: cur.cy };
    t.scale = cur.scale;
    t.rotation = cur.rotation;
  });
}

async function renameView(v: SavedView) {
  const name = (await promptText({ title: 'Rename view', label: 'Name', defaultValue: v.name }))?.trim();
  if (!name || name === v.name) return;
  commit(`Rename view “${v.name}” to “${name}”`, (d) => {
    const t = d.views.find((x) => x.id === v.id);
    if (t) t.name = name;
  });
}

async function deleteView(v: SavedView) {
  const ok = await confirmAction({
    title: `Delete view “${v.name}”?`,
    description: 'You can undo this with Ctrl+Z.',
    confirmLabel: 'Delete',
    destructive: true,
  });
  if (!ok) return;
  commit(`Delete view “${v.name}”`, (d) => {
    d.views = d.views.filter((x) => x.id !== v.id);
  });
}

const NO_VIEWS: SavedView[] = [];

export function SavedViewsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  // A stable empty array: a new one per call would make the store selector loop.
  const views = useProjectStore((s) => s.history?.project.views ?? NO_VIEWS);
  const display = useProjectStore((s) => s.history?.project.display);
  const readOnly = useProjectStore((s) => s.readOnly);
  const canvasW = useViewStore((s) => s.canvasSize.w);
  const fmtWidth = (v: SavedView) =>
    display ? formatLength(canvasW / v.scale, display.units, display.precision) : '';
  const fmtAngle = (r: number) => `${Number(radToDeg(r).toFixed(2))}°`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl" data-testid="saved-views-dialog">
        <DialogHeader>
          <DialogTitle>Saved views</DialogTitle>
          <DialogDescription>
            A saved view keeps the centre, zoom and rotation of the canvas. Views are saved with the project.
          </DialogDescription>
        </DialogHeader>
        {views.length === 0 ? (
          <p className="text-muted-foreground py-6 text-center text-sm">
            No saved views yet. Use “Save current view” to add one.
          </p>
        ) : (
          <ScrollArea className="max-h-[50vh]">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead className="text-right">Width shown</TableHead>
                  <TableHead className="text-right">Rotation</TableHead>
                  <TableHead className="sr-only">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {views.map((v) => (
                  <TableRow key={v.id} data-testid="saved-view-row">
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtWidth(v)}</TableCell>
                    <TableCell className="text-right text-xs tabular-nums">{fmtAngle(v.rotation)}</TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Go to view ${v.name}`}
                        title="Go to view"
                        onClick={() => {
                          goToView(v);
                          onOpenChange(false);
                        }}
                      >
                        <Crosshair />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Update view ${v.name} to the current view`}
                        title="Update to the current view"
                        disabled={readOnly}
                        onClick={() => updateView(v)}
                      >
                        <RefreshCw />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Rename view ${v.name}`}
                        title="Rename"
                        disabled={readOnly}
                        onClick={() => void renameView(v)}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete view ${v.name}`}
                        title="Delete"
                        disabled={readOnly}
                        onClick={() => void deleteView(v)}
                      >
                        <Trash2 />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </ScrollArea>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={readOnly} onClick={() => void runCommand('view.saveView')}>
            Save current view…
          </Button>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
