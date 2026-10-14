import { useState } from 'react';

import {
  allCommands,
  effectiveShortcut,
  eventToShortcut,
  formatShortcut,
  type MenuGroup,
} from '@/app/commands';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useUiStore } from '@/store/ui';

const ORDER: MenuGroup[] = ['File', 'Edit', 'View', 'Draw', 'Trace', 'Offset', 'Data', 'Export', 'Help'];

/** Shortcut cheat-sheet with a configurable shortcut map (row 4). */
export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const shortcuts = useUiStore((s) => s.shortcuts);
  const setShortcut = useUiStore((s) => s.setShortcut);
  const reset = useUiStore((s) => s.resetShortcuts);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  void shortcuts;
  const cmds = allCommands().filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Click a shortcut to change it, then press the new key combination (Esc cancels, Backspace clears).
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          <Button variant="outline" onClick={reset}>
            Reset all
          </Button>
        </div>
        <ScrollArea className="h-[60vh] pr-3">
          {ORDER.map((g) => {
            const items = cmds.filter((c) => c.menu === g);
            if (!items.length) return null;
            return (
              <section key={g} className="mb-3">
                <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">{g}</h3>
                <ul className="divide-y text-sm">
                  {items.map((c) => {
                    const sc = effectiveShortcut(c);
                    return (
                      <li key={c.id} className="flex items-center justify-between py-1">
                        <span>{c.title}</span>
                        {editing === c.id ? (
                          <Input
                            autoFocus
                            className="h-7 w-44 text-xs"
                            placeholder="Press keys…"
                            onKeyDown={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              if (e.key === 'Escape') return setEditing(null);
                              if (e.key === 'Backspace') {
                                setShortcut(c.id, '');
                                return setEditing(null);
                              }
                              const s = eventToShortcut(e.nativeEvent);
                              if (s) {
                                setShortcut(c.id, s);
                                setEditing(null);
                              }
                            }}
                            onBlur={() => setEditing(null)}
                          />
                        ) : (
                          <button
                            className="hover:bg-accent rounded px-1"
                            onClick={() => setEditing(c.id)}
                            aria-label={`Change shortcut for ${c.title}`}
                          >
                            {sc ? (
                              <Kbd>{formatShortcut(sc)}</Kbd>
                            ) : (
                              <span className="text-muted-foreground text-xs">none</span>
                            )}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            );
          })}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
