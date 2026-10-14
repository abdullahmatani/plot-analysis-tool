import { FilePlus2, FolderOpen, ShieldCheck, Trash2, WifiOff, HardDrive } from 'lucide-react';

import { confirmAction } from '@/app/prompt';
import { openLocalProject, openProjectFile, refreshRecents } from '@/app/file-ops';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { deleteProject } from '@/persistence/projects';
import { formatBytes } from '@/persistence/storage';
import { useAppStore } from '@/store/app';
import { useUiStore } from '@/store/ui';

export function StartScreen() {
  const recents = useAppStore((s) => s.recents);
  const storage = useAppStore((s) => s.storage);
  const unavailable = useAppStore((s) => s.storageUnavailable);
  const openDialog = useUiStore((s) => s.openDialog);

  return (
    <div className="flex h-full flex-col items-center overflow-auto p-6" data-testid="start-screen">
      <div className="w-full max-w-3xl space-y-6">
        <div className="flex items-center gap-3">
          <img src="./favicon.svg" alt="" className="size-10" />
          <div>
            <h1 className="text-2xl font-semibold">Plot Analysis Tool</h1>
            <p className="text-muted-foreground text-sm">
              Spatial analysis on plot plans — DXF, DWG and PDF. Private and fully offline.
            </p>
          </div>
        </div>

        {unavailable && (
          <Alert variant="warning">
            <HardDrive />
            <AlertTitle>Autosave is off in this browser window</AlertTitle>
            <AlertDescription>
              Browser storage is unavailable (for example in some private-browsing modes). Use “Save to file”
              regularly so no work is lost.
            </AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap gap-2">
          <Button onClick={() => openDialog('new-project')} data-testid="new-project">
            <FilePlus2 /> New project
          </Button>
          <Button variant="outline" onClick={() => void openProjectFile()}>
            <FolderOpen /> Open project file…
          </Button>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Recent projects</CardTitle>
            <CardDescription>
              Stored in this browser on this device. Every change is saved automatically.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {recents.length === 0 ? (
              <p className="text-muted-foreground text-sm">No projects yet.</p>
            ) : (
              <ScrollArea className="max-h-80">
                <ul className="divide-y" data-testid="recent-projects">
                  {recents.map((p) => (
                    <li key={p.id} className="flex items-center gap-3 py-2">
                      <button
                        className="hover:bg-accent flex-1 rounded-md px-2 py-1 text-left"
                        onClick={() => void openLocalProject(p.id)}
                      >
                        <div className="font-medium">{p.name}</div>
                        <div className="text-muted-foreground text-xs">
                          Edited {new Date(p.updatedAt).toLocaleString()} · {p.drawingCount} drawing
                          {p.drawingCount === 1 ? '' : 's'} · {p.objectCount} object
                          {p.objectCount === 1 ? '' : 's'}
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${p.name}`}
                        onClick={async () => {
                          const ok = await confirmAction({
                            title: `Delete “${p.name}”?`,
                            description:
                              'The project and its version history are removed from this browser. This cannot be undone.',
                            confirmLabel: 'Delete',
                            destructive: true,
                          });
                          if (!ok) return;
                          await deleteProject(p.id);
                          await refreshRecents();
                        }}
                      >
                        <Trash2 />
                      </Button>
                    </li>
                  ))}
                </ul>
              </ScrollArea>
            )}
          </CardContent>
        </Card>

        <div className="text-muted-foreground grid gap-2 text-xs sm:grid-cols-2">
          <div className="flex gap-2">
            <ShieldCheck className="size-4 shrink-0" />
            <span>
              Drawings, tables and projects never leave this device. No accounts, uploads or telemetry.
            </span>
          </div>
          <div className="flex gap-2">
            <WifiOff className="size-4 shrink-0" />
            <span>
              Works without a network connection once loaded.
              {storage && storage.quota > 0 && <> Local storage used: {formatBytes(storage.usage)}.</>}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
