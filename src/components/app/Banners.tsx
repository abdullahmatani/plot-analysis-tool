import { AlertTriangle, Eye, Lock } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

import { downloadBackup, saveProjectAs } from '@/app/file-ops';
import { currentSession, useSessionStore } from '@/app/session';
import { Button } from '@/components/ui/button';
import { useAppStore } from '@/store/app';
import { useProjectStore } from '@/store/project';

/** Read-only (other tab / restore point preview) and storage problem banners (rows 96, 99, 100). */
export function Banners() {
  const readOnlyReason = useProjectStore((s) => s.readOnlyReason);
  const preview = useProjectStore((s) => s.preview);
  const status = useSessionStore((s) => s.status);
  const unavailable = useAppStore((s) => s.storageUnavailable);
  const [busy, setBusy] = useState(false);

  return (
    <>
      {preview && (
        <div
          className="bg-warning/15 flex items-center gap-2 border-b px-3 py-1.5 text-sm"
          data-testid="preview-banner"
        >
          <Eye className="size-4" />
          <span className="flex-1">
            Previewing restore point “{preview.label}” from {new Date(preview.at).toLocaleString()}{' '}
            (read-only).
          </span>
          <Button
            size="xs"
            onClick={async () => {
              const s = currentSession();
              if (!s) return;
              await s.applyRestorePoint(preview.snapshotId);
              toast.success('Restore point applied. Undo (Ctrl+Z) reverts it.');
            }}
          >
            Restore this version
          </Button>
          <Button size="xs" variant="outline" onClick={() => currentSession()?.endPreview()}>
            Close preview
          </Button>
        </div>
      )}
      {readOnlyReason === 'other-tab' && !preview && (
        <div
          className="bg-warning/15 flex items-center gap-2 border-b px-3 py-1.5 text-sm"
          data-testid="readonly-banner"
        >
          <Lock className="size-4" />
          <span className="flex-1">
            This project is open for editing in another tab or window. This tab is read-only and stays up to
            date.
          </span>
          <Button
            size="xs"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const ok = await currentSession()?.takeOver();
              setBusy(false);
              if (ok) toast.success('You are now editing in this tab.');
              else toast.error('Could not take over editing.');
            }}
          >
            Take over editing
          </Button>
        </div>
      )}
      {(status?.state === 'error' || status?.state === 'unavailable' || unavailable) && (
        <div
          className="bg-destructive/10 text-destructive flex items-center gap-2 border-b px-3 py-1.5 text-sm"
          role="alert"
          data-testid="storage-banner"
        >
          <AlertTriangle className="size-4" />
          <span className="flex-1">
            {status?.reason ??
              'Autosave is off: browser storage is unavailable. Save the project to a file to keep your work.'}
          </span>
          <Button size="xs" variant="destructive" onClick={() => void saveProjectAs()}>
            Save project to file
          </Button>
          <Button size="xs" variant="outline" onClick={() => void downloadBackup()}>
            Download backup
          </Button>
        </div>
      )}
    </>
  );
}
