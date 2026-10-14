import { FileInput } from 'lucide-react';

import { importFiles } from '@/import/import-drawing';
import { pickFileViaInput } from '@/persistence/file-link';
import { getProject, useProjectStore } from '@/store/project';

import { registerCommands } from './commands';

export const DRAWING_ACCEPT = '.dxf,.dwg,.pdf,application/pdf,image/vnd.dxf,image/vnd.dwg';

export function registerImportCommands() {
  return registerCommands([
    {
      id: 'file.importDrawing',
      title: 'Import drawing (DXF, DWG, PDF)…',
      menu: 'File',
      section: 'import',
      shortcut: 'Mod+I',
      icon: FileInput,
      needsProject: true,
      enabled: () => !!getProject() && !useProjectStore.getState().readOnly,
      run: async () => {
        // Any file type is accepted by the picker too: the type is detected from the content (row 13).
        const files = await pickFileViaInput(`${DRAWING_ACCEPT},*/*`, true);
        if (files.length) await importFiles(files);
      },
    },
  ]);
}
