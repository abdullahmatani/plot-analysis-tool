import { useMemo, useState } from 'react';

import { allCommands, effectiveShortcut, formatShortcut, type MenuGroup } from '@/app/commands';
import { useCommandsVersion } from '@/components/app/AppMenubar';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { QUICK_START, type HelpTopic } from './content';
import { WORKFLOWS } from './workflows';

const MENUS: MenuGroup[] = ['File', 'Edit', 'View', 'Draw', 'Trace', 'Offset', 'Data', 'Export', 'Help'];

function Topics({ topics, filter }: { topics: HelpTopic[]; filter: string }) {
  const f = filter.trim().toLowerCase();
  const shown = topics.filter((t) => !f || `${t.title} ${t.keywords}`.toLowerCase().includes(f));
  if (!shown.length) return <p className="text-muted-foreground text-sm">No topics match “{filter}”.</p>;
  return (
    <div className="space-y-5">
      {shown.map((t) => (
        <section key={t.id} id={`help-${t.id}`} className="space-y-2 text-sm leading-relaxed">
          <h3 className="text-base font-semibold">{t.title}</h3>
          {t.body}
        </section>
      ))}
    </div>
  );
}

/** Tool reference generated from the command registry: always matches the installed features. */
function ToolReference({ filter }: { filter: string }) {
  useCommandsVersion();
  const f = filter.trim().toLowerCase();
  const cmds = allCommands().filter(
    (c) =>
      !c.hidden && (!f || `${c.title} ${c.menu} ${(c.keywords ?? []).join(' ')}`.toLowerCase().includes(f)),
  );
  return (
    <div className="space-y-4" data-testid="help-tool-reference">
      {MENUS.map((m) => {
        const items = cmds.filter((c) => c.menu === m);
        if (!items.length) return null;
        return (
          <section key={m}>
            <h3 className="text-muted-foreground mb-1 text-xs font-semibold uppercase">{m}</h3>
            <ul className="divide-y text-sm">
              {items.map((c) => {
                const sc = effectiveShortcut(c);
                const Icon = c.icon;
                return (
                  <li key={c.id} className="flex items-center gap-2 py-1">
                    {Icon ? <Icon className="text-muted-foreground size-4" /> : <span className="size-4" />}
                    <span className="flex-1">{c.title}</span>
                    {sc && <Kbd>{formatShortcut(sc)}</Kbd>}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** In-app help (row 86): quick start, workflow guides W1–W4, tool reference and shortcuts — all offline. */
export function HelpDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const [filter, setFilter] = useState('');
  const [tab, setTab] = useState('start');
  const workflows = useMemo(() => WORKFLOWS, []);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl" data-testid="help-dialog">
        <DialogHeader>
          <DialogTitle>Help</DialogTitle>
          <DialogDescription>Everything here works offline.</DialogDescription>
        </DialogHeader>
        <Input
          placeholder="Search help…"
          aria-label="Search help"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <Tabs value={tab} onValueChange={setTab} className="min-h-0">
          <TabsList>
            <TabsTrigger value="start">Quick start</TabsTrigger>
            <TabsTrigger value="workflows">Workflows</TabsTrigger>
            <TabsTrigger value="tools">Tools and shortcuts</TabsTrigger>
          </TabsList>
          <ScrollArea className="h-[60vh] pr-3">
            <TabsContent value="start">
              <Topics topics={QUICK_START} filter={filter} />
            </TabsContent>
            <TabsContent value="workflows">
              <Topics topics={workflows} filter={filter} />
            </TabsContent>
            <TabsContent value="tools">
              <ToolReference filter={filter} />
            </TabsContent>
          </ScrollArea>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
