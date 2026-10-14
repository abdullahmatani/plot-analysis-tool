import { toast } from 'sonner';

import { getDb } from '@/persistence/db';
import { pendingRecovery } from '@/persistence/recovery';
import { probeIndexedDb } from '@/persistence/storage';
import { useAppStore, type RecoveryCandidate } from '@/store/app';
import { useUiStore } from '@/store/ui';

import { refreshRecents, downloadBackup } from './file-ops';
import { installTestHooks, sessionTracker } from './session';
import { registerServiceWorker } from './pwa';

/** App start-up: storage probe, crash detection (row 95), recent projects, service worker. */
export async function initApp() {
  installTestHooks();
  const available = await probeIndexedDb();
  useAppStore.getState().set({ storageUnavailable: !available });
  const crashed = await sessionTracker.start();
  if (available) {
    await refreshRecents();
    const candidates: RecoveryCandidate[] = [];
    const seen = new Set<string>();
    for (const c of crashed) {
      if (seen.has(c.projectId)) continue;
      seen.add(c.projectId);
      try {
        const meta = await getDb().projects.get(c.projectId);
        if (!meta) continue;
        const p = await pendingRecovery(c.projectId);
        if (p.entries.length === 0 && p.drafts === 0) continue;
        candidates.push({
          projectId: c.projectId,
          name: meta.name,
          lastChangeAt: p.lastChangeAt ?? meta.updatedAt,
          entries: p.entries.length,
          drafts: p.drafts,
          summary: p.summary,
        });
      } catch {
        /* ignore unreadable project */
      }
    }
    if (candidates.length) {
      useAppStore.getState().set({ recovery: candidates });
      useUiStore.getState().openDialog('recovery');
    }
  }
  window.addEventListener('pat:backup-reminder', () => {
    toast.warning('Your recent work has not been saved to a file.', {
      description: 'Autosave keeps it in this browser. Download a backup copy to be safe.',
      action: { label: 'Download backup', onClick: () => void downloadBackup() },
      duration: 20000,
    });
  });
  registerServiceWorker();
  useAppStore.getState().set({ ready: true });
}
