import { useCallback, useEffect, useState } from 'react';
import { Bookmark, Clock, Eye, RotateCcw, Copy } from 'lucide-react';
import { toast } from 'sonner';

import { openLocalProject } from '@/app/file-ops';
import { promptText } from '@/app/prompt';
import { currentSession } from '@/app/session';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import type { SnapshotRecord } from '@/persistence/db';
import { storeProjectCopy } from '@/persistence/projects';
import { useSessionStore } from '@/app/session';
import { getSnapshot, listRestorePoints, verifySnapshot } from '@/persistence/snapshots';
import { useProjectStore } from '@/store/project';

type Point = Omit<SnapshotRecord, 'data'>;

/** Restore points (row 96): list, preview read-only, restore (undoable) or restore as a copy. */
export function HistorySheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const projectId = useProjectStore((s) => s.history?.project.id);
  const [points, setPoints] = useState<Point[]>([]);
  // Refresh when a new snapshot is written (e.g. a restore point finishing in the background).
  const lastSnapshotAt = useSessionStore((s) => s.status?.lastSnapshotAt);

  const reload = useCallback(async () => {
    if (projectId) setPoints(await listRestorePoints(projectId));
  }, [projectId]);

  useEffect(() => {
    if (open) void reload();
  }, [open, reload, lastSnapshotAt]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[28rem] sm:max-w-[28rem]">
        <SheetHeader>
          <SheetTitle>Restore points</SheetTitle>
          <SheetDescription>
            Created automatically every few minutes of editing and before high-impact operations, or named by
            you (Ctrl+Shift+S).
          </SheetDescription>
        </SheetHeader>
        <div className="px-4">
          <Button
            size="sm"
            onClick={async () => {
              const label = await promptText({
                title: 'Create restore point',
                label: 'Name',
                defaultValue: `Checkpoint ${new Date().toLocaleString()}`,
              });
              if (!label) return;
              await currentSession()?.createNamedRestorePoint(label);
              await reload();
            }}
          >
            <Bookmark /> New restore point
          </Button>
        </div>
        <ScrollArea className="min-h-0 flex-1 px-4">
          <ul className="space-y-2 pb-4" data-testid="restore-points">
            {points.length === 0 && <li className="text-muted-foreground text-sm">No restore points yet.</li>}
            {points.map((p) => (
              <li key={p.id} className="rounded-md border p-2 text-sm">
                <div className="flex items-center gap-2">
                  {p.kind === 'named' ? <Bookmark className="size-4" /> : <Clock className="size-4" />}
                  <span className="flex-1 font-medium">{p.label ?? 'Automatic'}</span>
                  <Badge variant="outline">{p.kind === 'named' ? 'Named' : 'Auto'}</Badge>
                </div>
                <div className="text-muted-foreground mt-0.5 text-xs">{new Date(p.at).toLocaleString()}</div>
                {p.summary && (
                  <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">
                    Changes: {p.summary}
                  </div>
                )}
                <div className="mt-2 flex flex-wrap gap-1">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      await currentSession()?.previewRestorePoint(p.id);
                      onOpenChange(false);
                    }}
                  >
                    <Eye /> Preview
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      const ok = await currentSession()?.applyRestorePoint(p.id);
                      if (ok) toast.success('Restored. Undo (Ctrl+Z) reverts the restore.');
                      await reload();
                    }}
                  >
                    <RotateCcw /> Restore
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      const rec = await getSnapshot(p.id);
                      if (!rec) return;
                      const state = await verifySnapshot(rec);
                      const copy = await storeProjectCopy(
                        state.project,
                        `${state.project.name} (${p.label ?? 'restored'})`,
                      );
                      toast.success(`Created “${copy.name}”`, {
                        action: { label: 'Open', onClick: () => void openLocalProject(copy.id) },
                      });
                    }}
                  >
                    <Copy /> Restore as copy
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
