import type { OffsetCap, OffsetJoin } from '@/geometry/offset';
import { useUiStore } from '@/store/ui';

/** Shared choices of the offset dialog and the offset properties section. */

export const OFFSET_DIALOG = 'offset';

export type OffsetDialogMode = 'single' | 'rings';

export function openOffsetDialog(mode: OffsetDialogMode) {
  useUiStore.getState().openDialog(OFFSET_DIALOG, { mode });
}

export const JOINS: { v: OffsetJoin; l: string; short: string }[] = [
  { v: 'round', l: 'Round — true distance', short: 'Round' },
  { v: 'miter', l: 'Mitre — square corners', short: 'Mitre' },
  { v: 'bevel', l: 'Bevel', short: 'Bevel' },
  { v: 'square', l: 'Square (cut at distance)', short: 'Square' },
];

export const CAPS: { v: OffsetCap; l: string }[] = [
  { v: 'round', l: 'Round' },
  { v: 'butt', l: 'Butt (flat at the end)' },
  { v: 'square', l: 'Square (extended)' },
];
