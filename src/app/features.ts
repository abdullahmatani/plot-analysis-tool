import '@/tools/nav-tools';
import '@/tools/select-tool';

import { useProjectStore } from '@/store/project';

import { registerImportCommands } from './import-commands';
import { registerSavedViewCommands, registerViewCommands } from './view-commands';

/**
 * Feature modules live in src/features/<name>/register.ts and self-register their commands, tools,
 * overlays, dialogs and panels when imported. They are discovered at build time, so features can be
 * added without editing shared files.
 */
const modules = import.meta.glob<{ register?: () => (() => void) | void }>('../features/*/register.ts', {
  eager: true,
});

export function registerFeatures(): () => void {
  const unregs: ((() => void) | void)[] = [registerViewCommands(), registerImportCommands()];
  for (const m of Object.values(modules)) unregs.push(m.register?.());
  registerSavedViewCommands();
  const unsub = useProjectStore.subscribe((s, p) => {
    if (s.history?.project.views !== p.history?.project.views) registerSavedViewCommands();
  });
  return () => {
    unsub();
    unregs.forEach((u) => u?.());
  };
}
