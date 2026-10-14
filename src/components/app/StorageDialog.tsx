import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { closeSession } from '@/app/session';
import { confirmAction } from '@/app/prompt';
import { openLocalProject, refreshRecents } from '@/app/file-ops';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Progress } from '@/components/ui/progress';
import { clearOpfs } from '@/persistence/blobs';
import { getDb, type RecoveryBinRecord } from '@/persistence/db';
import { listRecoveryBin, restoreFromBin } from '@/persistence/recovery-bin';
import { formatBytes, QUOTA_WARN_FRACTION, requestPersistence, storageInfo } from '@/persistence/storage';
import { useAppStore } from '@/store/app';

/** Storage status, recovery bin and "Clear local data" for shared PCs (rows 99, 101, 95). */
export function StorageDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const storage = useAppStore((s) => s.storage);
  const persisted = useAppStore((s) => s.persistGranted);
  const [bin, setBin] = useState<RecoveryBinRecord[]>([]);

  useEffect(() => {
    if (!open) return;
    void storageInfo().then((info) =>
      useAppStore.getState().set({ storage: info, persistGranted: info.persisted }),
    );
    void listRecoveryBin()
      .then(setBin)
      .catch(() => setBin([]));
  }, [open]);

  const frac = storage && storage.quota ? storage.usage / storage.quota : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Storage and local data</DialogTitle>
          <DialogDescription>Projects are stored privately in this browser on this device.</DialogDescription>
        </DialogHeader>
        <section className="space-y-2 text-sm">
          <div>
            Used {formatBytes(storage?.usage ?? 0)} of {formatBytes(storage?.quota ?? 0)} available
          </div>
          <Progress
            value={Math.min(100, frac * 100)}
            className={frac > QUOTA_WARN_FRACTION ? '[&>div]:bg-destructive' : ''}
          />
          {frac > QUOTA_WARN_FRACTION && (
            <p className="text-destructive">
              Storage is over 80% full. Save projects to files and delete ones you no longer need.
            </p>
          )}
          <div className="flex items-center gap-2">
            <span>
              Persistent storage:{' '}
              {persisted
                ? 'granted'
                : persisted === false
                  ? 'not granted (the browser may clear data under storage pressure)'
                  : 'unknown'}
            </span>
            {!persisted && (
              <Button
                size="xs"
                variant="outline"
                onClick={async () =>
                  useAppStore.getState().set({ persistGranted: await requestPersistence() })
                }
              >
                Request
              </Button>
            )}
          </div>
        </section>
        <section className="space-y-2 text-sm">
          <h3 className="font-medium">Recovery bin</h3>
          {bin.length === 0 ? (
            <p className="text-muted-foreground">Empty. Discarded recovery data is kept here for 7 days.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {bin.map((b) => (
                <li key={b.id} className="flex items-center gap-2 p-2">
                  <div className="flex-1">
                    <div>{b.projectName}</div>
                    <div className="text-muted-foreground text-xs">
                      {new Date(b.at).toLocaleString()} · {b.journal.length} edits · {b.reason}
                    </div>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={async () => {
                      const p = await restoreFromBin(b.id);
                      setBin(await listRecoveryBin());
                      await refreshRecents();
                      if (p)
                        toast.success(`Recovered as “${p.name}”`, {
                          action: { label: 'Open', onClick: () => void openLocalProject(p.id) },
                        });
                    }}
                  >
                    Restore as copy
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="space-y-2 text-sm">
          <h3 className="font-medium">Shared computer</h3>
          <p className="text-muted-foreground">
            Remove every project, drawing and setting stored by this app in this browser. Save any projects
            you need to files first.
          </p>
          <Button
            variant="destructive"
            size="sm"
            data-testid="clear-local-data"
            onClick={async () => {
              const ok = await confirmAction({
                title: 'Clear all local data?',
                description:
                  'All projects, drawings, restore points and settings stored in this browser will be permanently deleted. Export any project you want to keep to a file first.',
                confirmLabel: 'Delete everything',
                destructive: true,
              });
              if (!ok) return;
              await closeSession(false);
              const db = getDb();
              db.close();
              await db.delete();
              await clearOpfs();
              try {
                for (const k of Object.keys(localStorage))
                  if (k.startsWith('pat') || k.startsWith('react-resizable-panels'))
                    localStorage.removeItem(k);
              } catch {
                /* ignore */
              }
              location.reload();
            }}
          >
            Clear local data…
          </Button>
        </section>
      </DialogContent>
    </Dialog>
  );
}
