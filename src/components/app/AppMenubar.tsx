import { useSyncExternalStore } from 'react';

import {
  allCommands,
  commandsVersion,
  effectiveShortcut,
  formatShortcut,
  subscribeCommands,
  type MenuGroup,
} from '@/app/commands';
import { Button } from '@/components/ui/button';
import { Kbd } from '@/components/ui/kbd';
import {
  Menubar,
  MenubarCheckboxItem,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarSeparator,
  MenubarShortcut,
  MenubarTrigger,
} from '@/components/ui/menubar';
import { useProjectStore } from '@/store/project';
import { useUiStore } from '@/store/ui';

const MENUS: MenuGroup[] = ['File', 'Edit', 'View', 'Draw', 'Trace', 'Offset', 'Data', 'Export', 'Help'];

export function useCommandsVersion() {
  return useSyncExternalStore(subscribeCommands, commandsVersion);
}

export function AppMenubar() {
  useCommandsVersion();
  // Re-render on project/history changes so enabled/checked states stay current.
  useProjectStore((s) => s.history);
  useUiStore((s) => s.theme + s.canvasBg + s.inspectorOpen + s.toolRailOpen + JSON.stringify(s.shortcuts));
  const cmds = allCommands().filter((c) => !c.hidden);
  const projectName = useProjectStore((s) => s.history?.project.name);

  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b px-1.5">
      <Menubar className="border-0 shadow-none">
        {MENUS.map((menu) => {
          const items = cmds.filter((c) => c.menu === menu);
          if (!items.length) return null;
          const sections: string[] = [];
          for (const c of items) if (!sections.includes(c.section ?? '')) sections.push(c.section ?? '');
          return (
            <MenubarMenu key={menu}>
              <MenubarTrigger>{menu}</MenubarTrigger>
              <MenubarContent>
                {sections.map((sec, i) => (
                  <div key={sec || i}>
                    {i > 0 && <MenubarSeparator />}
                    {items
                      .filter((c) => (c.section ?? '') === sec)
                      .map((c) => {
                        const disabled = c.enabled ? !c.enabled() : false;
                        const sc = formatShortcut(effectiveShortcut(c));
                        if (c.checked) {
                          return (
                            <MenubarCheckboxItem
                              key={c.id}
                              checked={c.checked()}
                              disabled={disabled}
                              onSelect={() => void c.run()}
                            >
                              {c.title}
                              {sc && <MenubarShortcut>{sc}</MenubarShortcut>}
                            </MenubarCheckboxItem>
                          );
                        }
                        const Icon = c.icon;
                        return (
                          <MenubarItem
                            key={c.id}
                            disabled={disabled}
                            onSelect={() => void c.run()}
                            data-command={c.id}
                          >
                            {Icon ? <Icon /> : <span className="size-4" />}
                            {c.title}
                            {sc && <MenubarShortcut>{sc}</MenubarShortcut>}
                          </MenubarItem>
                        );
                      })}
                  </div>
                ))}
              </MenubarContent>
            </MenubarMenu>
          );
        })}
      </Menubar>
      <div className="text-muted-foreground min-w-0 flex-1 truncate text-center text-sm" title={projectName}>
        {projectName}
      </div>
      <Button
        variant="outline"
        size="xs"
        className="text-muted-foreground"
        onClick={() => useUiStore.getState().setPaletteOpen(true)}
      >
        Search commands <Kbd>{formatShortcut('Mod+K')}</Kbd>
      </Button>
    </div>
  );
}
