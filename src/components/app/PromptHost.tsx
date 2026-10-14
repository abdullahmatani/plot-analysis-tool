import { useEffect, useState } from 'react';

import { usePromptStore } from '@/app/prompt';
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

export function PromptHost() {
  const req = usePromptStore((s) => s.request);
  const set = usePromptStore((s) => s.set);
  const [value, setValue] = useState('');

  useEffect(() => {
    if (req) setValue(req.defaultValue ?? '');
  }, [req]);

  const finish = (v: string | boolean | null) => {
    req?.resolve(v);
    set(null);
  };

  return (
    <Dialog open={!!req} onOpenChange={(o) => !o && finish(req?.kind === 'confirm' ? false : null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{req?.title}</DialogTitle>
          {req?.description && <DialogDescription>{req.description}</DialogDescription>}
        </DialogHeader>
        {req?.kind === 'prompt' && (
          <form
            id="prompt-form"
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) finish(value.trim());
            }}
          >
            {req.label && <Label htmlFor="prompt-input">{req.label}</Label>}
            <Input id="prompt-input" autoFocus value={value} onChange={(e) => setValue(e.target.value)} />
          </form>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => finish(req?.kind === 'confirm' ? false : null)}>
            Cancel
          </Button>
          {req?.kind === 'prompt' ? (
            <Button type="submit" form="prompt-form" disabled={!value.trim()}>
              {req.confirmLabel ?? 'OK'}
            </Button>
          ) : (
            <Button variant={req?.destructive ? 'destructive' : 'default'} onClick={() => finish(true)}>
              {req?.confirmLabel ?? 'OK'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
