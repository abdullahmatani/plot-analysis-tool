import { useState } from 'react';
import { toast } from 'sonner';

import { openLocalProject, refreshRecents } from '@/app/file-ops';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { discardRecovery } from '@/persistence/recovery-bin';
import { useAppStore } from '@/store/app';

/** Unclean-shutdown recovery (row 95): Restore (default), Open last checkpoint only, or Discard. */
export function RecoveryDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const candidates = useAppStore((s) => s.recovery);
  const [choice, setChoice] = useState<Record<string, 'restore' | 'checkpoint' | 'discard'>>({});
  const [busy, setBusy] = useState(false);

  const apply = async () => {
    setBusy(true);
    let toOpen: { id: string; checkpointOnly: boolean } | null = null;
    for (const c of candidates) {
      const action = choice[c.projectId] ?? 'restore';
      if (action === 'restore') toOpen ??= { id: c.projectId, checkpointOnly: false };
      else if (action === 'checkpoint') {
        await discardRecovery(c.projectId, 'Opened last checkpoint only');
        toOpen ??= { id: c.projectId, checkpointOnly: true };
      } else {
        await discardRecovery(c.projectId, 'Discarded after unclean shutdown');
      }
    }
    useAppStore.getState().set({ recovery: [] });
    await refreshRecents();
    setBusy(false);
    onOpenChange(false);
    if (toOpen) {
      await openLocalProject(toOpen.id, { checkpointOnly: toOpen.checkpointOnly });
      toast.success('Project recovered.');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-xl" data-testid="recovery-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Recover unsaved work?</AlertDialogTitle>
          <AlertDialogDescription>
            The app was not closed normally last time (crash, forced close or power loss). These projects have
            recoverable changes. Discarded recovery data is kept in the recovery bin for 7 days.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <ul className="space-y-3">
          {candidates.map((c) => (
            <li key={c.projectId} className="rounded-md border p-3 text-sm">
              <div className="font-medium">{c.name}</div>
              <div className="text-muted-foreground text-xs">
                Last change {c.lastChangeAt ? new Date(c.lastChangeAt).toLocaleString() : 'unknown'} ·{' '}
                {c.entries} recovered edit{c.entries === 1 ? '' : 's'}
                {c.drafts > 0 &&
                  ` · ${c.drafts} unfinished drawing${c.drafts === 1 ? '' : 's'}/dialog${c.drafts === 1 ? '' : 's'}`}
              </div>
              {c.summary && <div className="text-muted-foreground mt-1 text-xs">Edits: {c.summary}</div>}
              <RadioGroup
                className="mt-2 grid-cols-3"
                value={choice[c.projectId] ?? 'restore'}
                onValueChange={(v) => setChoice({ ...choice, [c.projectId]: v as 'restore' })}
              >
                {(
                  [
                    ['restore', 'Restore'],
                    ['checkpoint', 'Last checkpoint only'],
                    ['discard', 'Discard'],
                  ] as const
                ).map(([v, l]) => (
                  <div key={v} className="flex items-center gap-1.5">
                    <RadioGroupItem value={v} id={`rec-${c.projectId}-${v}`} />
                    <Label htmlFor={`rec-${c.projectId}-${v}`} className="font-normal">
                      {l}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </li>
          ))}
        </ul>
        <AlertDialogFooter>
          <Button onClick={() => void apply()} disabled={busy} data-testid="recovery-apply">
            Continue
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
