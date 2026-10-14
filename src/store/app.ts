import { create } from 'zustand';

import type { ProjectMeta } from '@/persistence/db';
import type { StorageInfo } from '@/persistence/storage';

export interface RecoveryCandidate {
  projectId: string;
  name: string;
  lastChangeAt: string | null;
  entries: number;
  drafts: number;
  summary: string;
}

interface AppStore {
  ready: boolean;
  /** IndexedDB unavailable (e.g. some private-browsing modes): autosave is off (row 99). */
  storageUnavailable: boolean;
  storage: StorageInfo | null;
  persistGranted: boolean | null;
  recents: ProjectMeta[];
  recovery: RecoveryCandidate[];
  busy: string | null;
  set(patch: Partial<AppStore>): void;
}

export const useAppStore = create<AppStore>()((set) => ({
  ready: false,
  storageUnavailable: false,
  storage: null,
  persistGranted: null,
  recents: [],
  recovery: [],
  busy: null,
  set: (patch) => set(patch),
}));
