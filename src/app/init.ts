import { toast } from 'sonner';

import { getDb } from '@/persistence/db';
import { checkMirror } from '@/persistence/mirror';
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
  installGlobalErrorReporting();
  const available = await probeIndexedDb();
  useAppStore.getState().set({ storageUnavailable: !available });
  if (available) await restoreLostProjects();
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

/**
 * Chromium can delete the whole local database after a crash in the middle of a write. Projects are
 * then rebuilt from the backup copy kept in the private file system (mirror.ts).
 */
async function restoreLostProjects() {
  try {
    const restored = await checkMirror();
    if (!restored.length) return;
    toast.warning(
      restored.length === 1
        ? `Project “${restored[0]}” was restored from its backup copy`
        : `${restored.length} projects were restored from their backup copies`,
      {
        description:
          'The browser lost this app’s local database, which can happen after a crash. Every saved edit was recovered; restore points and app settings from before the loss are not included.',
        duration: 30000,
      },
    );
  } catch (e) {
    console.warn('backup check failed', e);
  }
}

/** Row 12: unexpected errors surface as readable notifications instead of failing silently. */
function installGlobalErrorReporting() {
  let last = '';
  const report = (msg: string) => {
    if (msg === last) return;
    last = msg;
    toast.error('Unexpected error', {
      description: `${msg}. Your work is saved; if something looks wrong, reload the app.`,
    });
  };
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason as { name?: string; message?: string } | undefined;
    if (reason?.name === 'AbortError') return;
    report(reason?.message ?? String(e.reason));
  });
  window.addEventListener('error', (e) => {
    if (!e.message || /ResizeObserver loop/.test(e.message)) return;
    report(e.message);
  });
}
