import { create } from 'zustand';

/** Visibility of the on-canvas scale bar and north arrow (row 36), remembered per browser. */

interface OverlayPrefs {
  scaleBar: boolean;
  northArrow: boolean;
  toggle(key: 'scaleBar' | 'northArrow'): void;
}

const KEY = 'pat:map-overlays';

function load(): Pick<OverlayPrefs, 'scaleBar' | 'northArrow'> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { scaleBar: true, northArrow: true, ...(JSON.parse(raw) as object) };
  } catch {
    /* ignore */
  }
  return { scaleBar: true, northArrow: true };
}

export const useOverlayPrefs = create<OverlayPrefs>()((set, get) => ({
  ...load(),
  toggle: (key) => {
    set({ [key]: !get()[key] } as Partial<OverlayPrefs>);
    try {
      const { scaleBar, northArrow } = get();
      localStorage.setItem(KEY, JSON.stringify({ scaleBar, northArrow }));
    } catch {
      /* ignore */
    }
  },
}));
