import { useUiStore } from '@/store/ui';

import { IMPORT_DIALOG, type ImportPayload } from './ImportTableDialog';

/** Opens the table import dialog (file, paste, re-import or a recovered draft). */
export function openImport(payload: ImportPayload = {}) {
  useUiStore.getState().openDialog(IMPORT_DIALOG, payload);
}
