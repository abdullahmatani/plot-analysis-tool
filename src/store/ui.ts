import { create } from 'zustand';

/** UI preferences (theme, canvas background, panels) persisted per browser profile. */

export type ThemePref = 'light' | 'dark' | 'system';
export type CanvasBg = 'dark' | 'light';
export type InspectorTab = 'properties' | 'layers' | 'data' | 'legend';

export type DialogId =
  | 'about'
  | 'shortcuts'
  | 'settings'
  | 'history'
  | 'export'
  | 'import-table'
  | 'calibrate'
  | 'recovery'
  | 'new-project'
  | 'open-project'
  | 'storage'
  | 'help'
  | null;

interface Prefs {
  theme: ThemePref;
  canvasBg: CanvasBg;
  inspectorTab: InspectorTab;
  inspectorOpen: boolean;
  toolRailOpen: boolean;
  shortcuts: Record<string, string>;
  uiScale: number;
}

interface UiStore extends Prefs {
  resolvedTheme: 'light' | 'dark';
  dialog: DialogId;
  dialogPayload: unknown;
  paletteOpen: boolean;
  setTheme(t: ThemePref): void;
  setCanvasBg(b: CanvasBg): void;
  setInspectorTab(t: InspectorTab): void;
  toggleInspector(open?: boolean): void;
  toggleToolRail(open?: boolean): void;
  setShortcut(commandId: string, keys: string | null): void;
  resetShortcuts(): void;
  openDialog(id: DialogId, payload?: unknown): void;
  closeDialog(): void;
  setPaletteOpen(open: boolean): void;
  applySystemTheme(): void;
}

const KEY = 'pat:ui';

function loadPrefs(): Prefs {
  const defaults: Prefs = {
    theme: 'system',
    canvasBg: 'dark',
    inspectorTab: 'layers',
    inspectorOpen: true,
    toolRailOpen: true,
    shortcuts: {},
    uiScale: 1,
  };
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...defaults, ...(JSON.parse(raw) as Partial<Prefs>) } : defaults;
  } catch {
    return defaults;
  }
}

function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
}

function resolve(theme: ThemePref): 'light' | 'dark' {
  return theme === 'system' ? (systemDark() ? 'dark' : 'light') : theme;
}

const initial = loadPrefs();

export const useUiStore = create<UiStore>()((set, get) => {
  const persist = (patch: Partial<Prefs>) => {
    set(patch as Partial<UiStore>);
    const s = get();
    savePrefs({
      theme: s.theme,
      canvasBg: s.canvasBg,
      inspectorTab: s.inspectorTab,
      inspectorOpen: s.inspectorOpen,
      toolRailOpen: s.toolRailOpen,
      shortcuts: s.shortcuts,
      uiScale: s.uiScale,
    });
  };
  return {
    ...initial,
    resolvedTheme: resolve(initial.theme),
    dialog: null,
    dialogPayload: null,
    paletteOpen: false,
    setTheme: (theme) => {
      persist({ theme });
      set({ resolvedTheme: resolve(theme) });
    },
    setCanvasBg: (canvasBg) => persist({ canvasBg }),
    setInspectorTab: (inspectorTab) => persist({ inspectorTab, inspectorOpen: true }),
    toggleInspector: (open) => persist({ inspectorOpen: open ?? !get().inspectorOpen }),
    toggleToolRail: (open) => persist({ toolRailOpen: open ?? !get().toolRailOpen }),
    setShortcut: (id, keys) => {
      const shortcuts = { ...get().shortcuts };
      if (keys === null) delete shortcuts[id];
      else shortcuts[id] = keys;
      persist({ shortcuts });
    },
    resetShortcuts: () => persist({ shortcuts: {} }),
    openDialog: (dialog, payload = null) => set({ dialog, dialogPayload: payload, paletteOpen: false }),
    closeDialog: () => set({ dialog: null, dialogPayload: null }),
    setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
    applySystemTheme: () => set({ resolvedTheme: resolve(get().theme) }),
  };
});
