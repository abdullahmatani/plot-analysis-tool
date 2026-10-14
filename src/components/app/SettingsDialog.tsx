import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { currentSession, useSessionStore } from '@/app/session';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { fsaSupported } from '@/persistence/file-link';
import {
  DEFAULT_AUTOSAVE_SETTINGS,
  saveAutosaveSettings,
  type AutosaveSettings,
} from '@/persistence/settings';

const FIELDS: { key: keyof AutosaveSettings; label: string; unit: string; min: number; max: number }[] = [
  {
    key: 'restorePointIntervalMin',
    label: 'Automatic restore point every',
    unit: 'min of editing',
    min: 1,
    max: 240,
  },
  { key: 'keepAutoPoints', label: 'Keep the last', unit: 'automatic restore points', min: 1, max: 500 },
  { key: 'keepDailyDays', label: 'Plus one restore point per day for', unit: 'days', min: 0, max: 365 },
  {
    key: 'fileAutosaveIntervalSec',
    label: 'Write the linked project file every',
    unit: 's while changed',
    min: 10,
    max: 3600,
  },
  {
    key: 'backupReminderMin',
    label: 'Remind to download a backup after',
    unit: 'min not saved to file',
    min: 5,
    max: 480,
  },
];

/** Autosave settings (row 101). Take effect immediately, without reload. */
export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const current = useSessionStore((s) => s.settings);
  const file = useSessionStore((s) => s.file);
  const [draft, setDraft] = useState<AutosaveSettings>(current);

  useEffect(() => {
    if (open) setDraft(current);
  }, [open, current]);

  const save = async () => {
    await saveAutosaveSettings(draft);
    useSessionStore.getState().set({ settings: draft });
    currentSession()?.updateSettings(draft);
    toast.success('Settings saved');
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Every change is always journalled to this browser’s storage within a second; that cannot be
            switched off. These settings control restore points and file autosave.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3" data-testid="settings-form">
          {FIELDS.map((f) => (
            <div key={f.key} className="grid grid-cols-[1fr_6rem] items-center gap-2">
              <Label htmlFor={`set-${f.key}`} className="font-normal">
                {f.label} <span className="text-muted-foreground">({f.unit})</span>
              </Label>
              <Input
                id={`set-${f.key}`}
                type="number"
                min={f.min}
                max={f.max}
                value={draft[f.key]}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    [f.key]: Math.max(f.min, Math.min(f.max, Number(e.target.value) || f.min)),
                  })
                }
              />
            </div>
          ))}
          {file?.linked && fsaSupported() && (
            <div className="flex items-center justify-between gap-2 rounded-md border p-2">
              <Label htmlFor="file-autosave" className="font-normal">
                Autosave to linked file “{file.name}”
              </Label>
              <Switch
                id="file-autosave"
                checked={file.autosave}
                onCheckedChange={(v) => void currentSession()?.file.setAutosave(v)}
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setDraft(DEFAULT_AUTOSAVE_SETTINGS)}>
            Defaults
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
