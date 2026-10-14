import { create } from 'zustand';

/**
 * Transient contour UI state (not part of the project document): the dataset open in the Data panel
 * and row ↔ contour cross-highlighting (row 68): rows hovered or selected in the data grid are
 * highlighted on the canvas and vice versa.
 */

export interface RowRef {
  ds: string;
  row: number;
}

interface ContoursUi {
  activeDatasetId: string | null;
  hover: RowRef | null;
  /** Selected rows of one dataset. */
  selection: { ds: string; rows: number[] } | null;
  /** Bumped to ask the data grid to scroll a row into view. */
  reveal: (RowRef & { seq: number }) | null;
  set(patch: Partial<Omit<ContoursUi, 'set' | 'revealRow'>>): void;
  revealRow(ref: RowRef): void;
}

let seq = 0;

export const useContoursUi = create<ContoursUi>()((set) => ({
  activeDatasetId: null,
  hover: null,
  selection: null,
  reveal: null,
  set: (patch) => set(patch),
  revealRow: (ref) => set({ reveal: { ...ref, seq: ++seq } }),
}));

export function isRowSelected(ds: string, row: number): boolean {
  const s = useContoursUi.getState().selection;
  return !!s && s.ds === ds && s.rows.includes(row);
}
