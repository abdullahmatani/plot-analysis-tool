import { useEffect, useState } from 'react';

import { newProject } from '@/app/file-ops';
import { downloadBackup, saveProjectAs } from '@/app/file-ops';
import { useSessionStore } from '@/app/session';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useUiStore, type DialogId } from '@/store/ui';

import { AboutDialog } from './AboutDialog';
import { CommandPalette } from './CommandPalette';
import { HistorySheet } from './HistorySheet';
import { PromptHost } from './PromptHost';
import { RecoveryDialog } from './RecoveryDialog';
import { SettingsDialog } from './SettingsDialog';
import { ShortcutsDialog } from './ShortcutsDialog';
import { StorageDialog } from './StorageDialog';
import { extraDialogs } from './extra-dialogs';

function NewProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [name, setName] = useState('Untitled project');
  useEffect(() => {
    if (open) setName('Untitled project');
  }, [open]);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
        </DialogHeader>
        <form
          id="new-project-form"
          className="grid gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onOpenChange(false);
            void newProject(name.trim() || 'Untitled project');
          }}
        >
          <Label htmlFor="np-name">Project name</Label>
          <Input
            id="np-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onFocus={(e) => e.target.select()}
          />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="new-project-form" data-testid="create-project">
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Blocking alert when storage is full (row 99). */
function QuotaAlert() {
  const quota = useSessionStore((s) => s.status?.quotaExceeded ?? false);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!quota) setDismissed(false);
  }, [quota]);
  return (
    <AlertDialog open={quota && !dismissed}>
      <AlertDialogContent data-testid="quota-alert">
        <AlertDialogHeader>
          <AlertDialogTitle>Browser storage is full</AlertDialogTitle>
          <AlertDialogDescription>
            Your latest changes are kept in memory but cannot be saved to browser storage. Save the project to
            a file now so nothing is lost, then free up space (delete old projects or clear site data).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => setDismissed(true)}>Later</AlertDialogCancel>
          <Button variant="outline" onClick={() => void downloadBackup().then(() => setDismissed(true))}>
            Download backup
          </Button>
          <Button
            onClick={() => void saveProjectAs().then((ok) => ok && setDismissed(true))}
            data-testid="quota-save"
          >
            Save project to file
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function Dialogs() {
  const dialog = useUiStore((s) => s.dialog);
  const close = useUiStore((s) => s.closeDialog);
  const props = (id: DialogId) => ({ open: dialog === id, onOpenChange: (o: boolean) => !o && close() });
  return (
    <>
      <CommandPalette />
      <PromptHost />
      <QuotaAlert />
      <NewProjectDialog {...props('new-project')} />
      <ShortcutsDialog {...props('shortcuts')} />
      <AboutDialog {...props('about')} />
      <SettingsDialog {...props('settings')} />
      <HistorySheet {...props('history')} />
      <RecoveryDialog {...props('recovery')} />
      <StorageDialog {...props('storage')} />
      {extraDialogs.map(({ id, Component }) => (
        <Component key={id} {...props(id)} />
      ))}
    </>
  );
}
