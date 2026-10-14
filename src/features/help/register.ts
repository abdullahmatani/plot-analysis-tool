import { extraDialogs } from '@/components/app/extra-dialogs';

import { HelpDialog } from './HelpDialog';

/** In-app help (row 86), opened by Help → Help and workflow guides (F1). */
export function register() {
  if (!extraDialogs.some((d) => d.id === 'help')) extraDialogs.push({ id: 'help', Component: HelpDialog });
}
