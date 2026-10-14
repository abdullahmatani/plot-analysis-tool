import type { SheetLayout, TitleBlock } from '@/core/types';
import { commit, getProject } from '@/store/project';
import { useViewStore } from '@/store/view';

import { niceScaleAtLeast, sheetFrame } from './scene/sheet';

/** Sheet layout edits (row 76): one undoable commit per change (typing coalesces). */

export function setSheet(patch: Partial<SheetLayout>, label: string, coalesceKey?: string): boolean {
  return commit(
    label,
    (d) => {
      Object.assign(d.sheet, patch);
      for (const k of Object.keys(patch) as (keyof SheetLayout)[])
        if (patch[k] === undefined) delete d.sheet[k];
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

export function setTitleField(field: keyof TitleBlock, value: string): boolean {
  return commit(
    `Title block: ${field}`,
    (d) => {
      d.sheet.titleBlock[field] = value;
    },
    { coalesceKey: `title-block-${field}` },
  );
}

/** Scale and centre that print the current screen view on the sheet viewport. */
export function sheetFromCurrentView(
  sheet: SheetLayout,
): Pick<SheetLayout, 'scale' | 'viewCentre' | 'viewRotation'> {
  const { view, canvasSize } = useViewStore.getState();
  const vp = sheetFrame(sheet).viewport;
  const wm = canvasSize.w / view.scale;
  const hm = canvasSize.h / view.scale;
  const exact = Math.max((wm * 1000) / vp.w, (hm * 1000) / vp.h);
  return {
    scale: niceScaleAtLeast(exact),
    viewCentre: { x: view.cx, y: view.cy },
    viewRotation: view.rotation,
  };
}

export function applyCurrentViewToSheet(): boolean {
  const p = getProject();
  if (!p) return false;
  return setSheet(sheetFromCurrentView(p.sheet), 'Sheet: use current view');
}

export function fitSheetToContent(): boolean {
  return setSheet({ scale: null, viewCentre: undefined }, 'Sheet: fit to content');
}
