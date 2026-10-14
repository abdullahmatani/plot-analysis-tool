import type { ComponentType } from 'react';

import type { DialogId } from '@/store/ui';

/** Feature dialogs registered by later modules (help, export, table import, calibration…). */
export const extraDialogs: {
  id: DialogId;
  Component: ComponentType<{ open: boolean; onOpenChange: (o: boolean) => void }>;
}[] = [];
