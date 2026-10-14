import { create } from 'zustand';

/**
 * Tracing preferences (rows 51–54), per browser profile: gap tolerance for chain tracing and
 * boundary pick, island detection, simplify tolerance and the raster aids (magnifier loupe,
 * edge-contrast enhancement). Not part of the project document.
 */

export interface TraceSettings {
  /** Endpoint gaps up to this size are closed (world metres). */
  gapTol: number;
  /** Boundary pick returns enclosed islands as holes. */
  detectIslands: boolean;
  /** Default tolerance offered by Simplify (world metres). */
  simplifyTol: number;
  /** Magnifier loupe near the cursor. */
  loupe: boolean;
  /** Loupe magnification. */
  loupeZoom: number;
  /** Edge-contrast enhancement for raster (scanned) PDF pages. */
  edgeContrast: boolean;
}

export const DEFAULT_TRACE_SETTINGS: TraceSettings = {
  gapTol: 0.1,
  detectIslands: true,
  simplifyTol: 0.05,
  loupe: false,
  loupeZoom: 4,
  edgeContrast: false,
};

const KEY = 'pat:trace';

function load(): TraceSettings {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(KEY) : null;
    return raw
      ? { ...DEFAULT_TRACE_SETTINGS, ...(JSON.parse(raw) as Partial<TraceSettings>) }
      : DEFAULT_TRACE_SETTINGS;
  } catch {
    return DEFAULT_TRACE_SETTINGS;
  }
}

interface Store extends TraceSettings {
  set(patch: Partial<TraceSettings>): void;
}

export const useTraceSettings = create<Store>()((set, get) => ({
  ...load(),
  set: (patch) => {
    set(patch);
    try {
      const { set: _omit, ...rest } = { ...get() };
      void _omit;
      localStorage.setItem(KEY, JSON.stringify(rest));
    } catch {
      /* storage unavailable: keep in memory */
    }
  },
}));

export function traceSettings(): TraceSettings {
  return useTraceSettings.getState();
}
