import { CheckCircle2, Loader2, AlertTriangle, Lock, FileCheck2 } from 'lucide-react';

import { useSessionStore } from '@/app/session';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes } from '@/persistence/storage';
import { useAppStore } from '@/store/app';

function time(iso: string | null | undefined) {
  return iso
    ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
}

/** Save status indicator (row 94). Never shows "Saved" while unflushed changes exist. */
export function SaveStatusBadge() {
  const status = useSessionStore((s) => s.status);
  const file = useSessionStore((s) => s.file);
  const storage = useAppStore((s) => s.storage);
  if (!status) return null;

  let icon = <CheckCircle2 className="text-success" />;
  let text = `Saved locally · ${time(status.lastSavedAt ?? status.lastSnapshotAt)}`;
  let variant: 'outline' | 'destructive' | 'warning' = 'outline';
  if (status.state === 'saving') {
    icon = <Loader2 className="animate-spin" />;
    text = 'Saving…';
  } else if (status.state === 'error' || status.state === 'unavailable') {
    icon = <AlertTriangle />;
    text = 'Not saved — action needed';
    variant = 'destructive';
  } else if (status.state === 'readonly') {
    icon = <Lock />;
    text = 'Read-only';
    variant = 'warning';
  } else if (
    file?.linked &&
    file.lastWrittenAt &&
    status.pending === 0 &&
    file.lastWrittenSeq >= 0 &&
    !file.writing &&
    file.autosave
  ) {
    const fileCurrent = (status.lastSavedAt ?? '') <= (file.lastWrittenAt ?? '');
    if (fileCurrent) {
      icon = <FileCheck2 className="text-success" />;
      text = `Saved to file · ${time(file.lastWrittenAt)}`;
    }
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Badge
          variant={variant}
          className="h-6 gap-1.5 font-normal"
          data-testid="save-status"
          data-state={status.state}
          data-pending={status.pending}
        >
          {icon}
          {text}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs">
        <div className="space-y-0.5">
          {status.reason && <div className="font-medium">{status.reason}</div>}
          <div>Last journal write: {time(status.lastSavedAt)}</div>
          <div>Last snapshot: {time(status.lastSnapshotAt)}</div>
          {file?.linked && (
            <div>
              Linked file: {file.name} {file.autosave ? '(autosave on)' : '(autosave off)'} · last written{' '}
              {time(file.lastWrittenAt)}
            </div>
          )}
          {file?.needsPermission && <div>Click File → Save to allow writing to the linked file.</div>}
          {storage && storage.quota > 0 && (
            <div>
              Storage used: {formatBytes(storage.usage)} of {formatBytes(storage.quota)}
              {storage.persisted ? ' (persistent)' : ''}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
