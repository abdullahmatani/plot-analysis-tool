import { allCommands, effectiveShortcut, formatShortcut, type MenuGroup } from '@/app/commands';
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command';
import { useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';

import { useCommandsVersion } from './AppMenubar';

/** Every query word must occur in the item text; titles that start with the query rank first. */
export function paletteFilter(value: string, search: string, keywords?: string[]): number {
  const hay = `${value} ${(keywords ?? []).join(' ')}`.toLowerCase();
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  if (!words.every((w) => hay.includes(w))) return 0;
  const title = value.toLowerCase().split('|')[1] ?? '';
  if (title.startsWith(search.toLowerCase())) return 1;
  if (words.every((w) => title.split(/\W+/).some((t) => t.startsWith(w)))) return 0.8;
  return 0.5;
}

const ORDER: MenuGroup[] = ['File', 'Edit', 'View', 'Draw', 'Trace', 'Offset', 'Data', 'Export', 'Help'];

/** Ctrl/⌘+K palette listing every command (row 4). */
export function CommandPalette() {
  useCommandsVersion();
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const hasProject = useProjectStore((s) => !!s.history);
  const cmds = allCommands().filter((c) => !c.needsProject || hasProject);

  return (
    <CommandDialog open={open} onOpenChange={setOpen} filter={paletteFilter}>
      <CommandInput placeholder="Type a command or tool…" />
      <CommandList>
        <CommandEmpty>No matching command.</CommandEmpty>
        {ORDER.map((group) => {
          const items = cmds.filter((c) => c.menu === group);
          if (!items.length) return null;
          return (
            <CommandGroup key={group} heading={group}>
              {items.map((c) => {
                const Icon = c.icon;
                const disabled = c.enabled ? !c.enabled() : false;
                return (
                  <CommandItem
                    key={c.id}
                    value={`${group}|${c.title}|${c.id}`}
                    keywords={c.keywords}
                    disabled={disabled}
                    onSelect={() => {
                      setOpen(false);
                      void c.run();
                    }}
                  >
                    {Icon ? <Icon /> : <span className="size-4" />}
                    {c.title}
                    <CommandShortcut>{formatShortcut(effectiveShortcut(c))}</CommandShortcut>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}
