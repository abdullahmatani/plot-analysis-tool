import type { ContourDataset, DashStyle } from '@/core/types';

/** Option lists shared by the contour dialogs and the Data panel. */

export const DASHES: { v: DashStyle; l: string }[] = [
  { v: 'solid', l: 'Solid' },
  { v: 'dash', l: 'Dashed' },
  { v: 'dot', l: 'Dotted' },
  { v: 'dash-dot', l: 'Dash-dot' },
  { v: 'long-dash', l: 'Long dash' },
];

export const LABEL_PLACEMENTS: { v: ContourDataset['labelPlacement']; l: string }[] = [
  { v: 'top', l: 'Top of ring' },
  { v: 'centre', l: 'Centre' },
  { v: 'leader', l: 'Leader' },
];
