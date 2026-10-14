import '@/tools/nav-tools';
import '@/tools/select-tool';

import { registerImportCommands } from './import-commands';
import { registerSavedViewCommands, registerViewCommands } from './view-commands';

/** Registers feature commands and tools. Returns an unregister function. */
export function registerFeatures(): () => void {
  const unregs = [registerViewCommands(), registerImportCommands()];
  registerSavedViewCommands();
  return () => unregs.forEach((u) => u());
}
