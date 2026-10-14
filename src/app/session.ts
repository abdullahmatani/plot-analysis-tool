import { create } from 'zustand';
import { toast } from 'sonner';

import { newId } from '@/core/ids';
import { createLayer } from '@/core/project';
import type { HistoryState, JournalOp } from '@/core/history';
import { AutosaveEngine, type AutosaveStatus } from '@/persistence/autosave';
import { getDb, type JournalRecord } from '@/persistence/db';
import { DraftManager } from '@/persistence/drafts';
import { FileLinkManager, fsaSupported, type FileLinkStatus } from '@/persistence/file-link';
import { ProjectLock, type ProjectChannelMessage } from '@/persistence/locks';
import { buildProjectFile } from '@/persistence/project-file';
import { metaFor, touchProject } from '@/persistence/projects';
import { loadProjectState, type RecoveryReport } from '@/persistence/recovery';
import { createSerializer } from '@/persistence/serializer-client';
import {
  DEFAULT_AUTOSAVE_SETTINGS,
  loadAutosaveSettings,
  type AutosaveSettings,
} from '@/persistence/settings';
import { getSnapshot, verifySnapshot } from '@/persistence/snapshots';
import { SessionTracker } from '@/persistence/sessions';
import { setJournalSink, useProjectStore } from '@/store/project';

/**
 * Project session controller: opens a project (recovering from snapshot + journal), owns its
 * autosave engine, drafts, multi-tab lock and linked-file autosave, and handles lifecycle saves.
 */

export const TAB_ID = newId('tab');
export const sessionTracker = new SessionTracker();
const serializer = createSerializer();

interface SessionStore {
  projectId: string | null;
  status: AutosaveStatus | null;
  file: FileLinkStatus | null;
  settings: AutosaveSettings;
  report: RecoveryReport | null;
  /** Another tab holds the write lock. */
  followerOf: boolean;
  set(patch: Partial<SessionStore>): void;
}

export const useSessionStore = create<SessionStore>()((set) => ({
  projectId: null,
  status: null,
  file: null,
  settings: DEFAULT_AUTOSAVE_SETTINGS,
  report: null,
  followerOf: false,
  set: (patch) => set(patch),
}));

export class ProjectSession {
  engine: AutosaveEngine | null = null;
  drafts: DraftManager;
  file: FileLinkManager;
  lock: ProjectLock;
  private unsubs: (() => void)[] = [];
  private followerSeq = 0;
  private closed = false;
  private backupTimer: ReturnType<typeof setInterval> | null = null;
  private lastFileOrBackupAt = Date.now();

  private constructor(
    readonly projectId: string,
    private settings: AutosaveSettings,
  ) {
    this.drafts = new DraftManager(projectId);
    this.lock = new ProjectLock(projectId, TAB_ID);
    this.file = new FileLinkManager(
      projectId,
      () => this.buildFile(),
      () => this.engine?.currentSeq ?? 0,
      settings.fileAutosaveIntervalSec,
    );
  }

  static async open(projectId: string, opts: { checkpointOnly?: boolean } = {}): Promise<ProjectSession> {
    const settings = await loadAutosaveSettings();
    const s = new ProjectSession(projectId, settings);
    await s.start(opts);
    return s;
  }

  private getState = (): HistoryState => {
    const st = useProjectStore.getState();
    return (st.stashed ?? st.history)!;
  };

  private async start(opts: { checkpointOnly?: boolean }) {
    const writer = await this.lock.acquire();
    const loaded = await loadProjectState(this.projectId, opts);
    const store = useProjectStore.getState();
    store.load(loaded.state);
    this.engine = new AutosaveEngine(
      {
        projectId: this.projectId,
        getState: this.getState,
        onFlushed: (records) => this.lock.post({ type: 'ops', from: TAB_ID, records }),
        getMeta: () => {
          const p = this.getState().project;
          const m = metaFor(p, 0);
          return {
            name: m.name,
            drawingCount: m.drawingCount,
            objectCount: m.objectCount,
            blobKeys: m.blobKeys,
          };
        },
      },
      this.settings,
      serializer,
      loaded.seq,
      { lastSnapshotSeq: loaded.report.snapshotSeq },
    );
    useSessionStore
      .getState()
      .set({ projectId: this.projectId, report: loaded.report, settings: this.settings });
    this.unsubs.push(this.engine.subscribe((status) => useSessionStore.getState().set({ status })));
    this.unsubs.push(this.file.subscribe((file) => useSessionStore.getState().set({ file })));
    this.unsubs.push(this.lock.onMessage((m) => this.onChannel(m)));
    this.unsubs.push(
      this.lock.onLost(() => {
        if (this.closed) return;
        this.becomeFollower();
        toast.warning('Editing was taken over by another tab. This tab is now read-only.');
      }),
    );
    setJournalSink((op: JournalOp) => this.engine?.record(op));
    if (writer) {
      this.becomeWriter(false);
      // A recovered journal tail is folded into a fresh checkpoint so recovery stays fast.
      if (loaded.report.replayed > 0 || loaded.report.skippedSnapshots.length > 0)
        void this.engine.checkpoint('post-recovery');
    } else {
      this.becomeFollower();
    }
    await this.file.load();
    await touchProject(this.projectId);
    sessionTracker.setProject(this.projectId);
    const onHidden = () => {
      if (document.visibilityState === 'hidden') void this.lifecycleSave();
    };
    const onPageHide = () => void this.lifecycleSave();
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', onPageHide);
    this.unsubs.push(() => document.removeEventListener('visibilitychange', onHidden));
    this.unsubs.push(() => window.removeEventListener('pagehide', onPageHide));
    this.startBackupReminder();
  }

  private becomeWriter(announce = true) {
    useProjectStore.getState().setReadOnly(false);
    this.engine?.setReadOnly(false);
    useSessionStore.getState().set({ followerOf: false });
    if (announce) this.lock.post({ type: 'writer', from: TAB_ID });
  }

  private becomeFollower() {
    this.followerSeq = this.engine?.currentSeq ?? 0;
    useProjectStore.getState().setReadOnly(true, 'other-tab');
    this.engine?.setReadOnly(true);
    useSessionStore.getState().set({ followerOf: true });
  }

  private onChannel(m: ProjectChannelMessage) {
    const isFollower = useSessionStore.getState().followerOf;
    if (m.type === 'ops' && isFollower) {
      const fresh = m.records
        .filter((r: JournalRecord) => r.seq > this.followerSeq)
        .sort((a, b) => a.seq - b.seq);
      if (!fresh.length) return;
      if (fresh[0].seq !== this.followerSeq + 1) {
        // Missed messages: reload from storage.
        void this.reloadFromStorage();
        return;
      }
      useProjectStore.getState().applyRemote(fresh.map((r) => r.op));
      this.followerSeq = fresh[fresh.length - 1].seq;
    } else if (m.type === 'takeover-request' && !isFollower && this.lock.held) {
      void (async () => {
        await this.lifecycleSave();
        this.lock.releaseLock();
        this.becomeFollower();
        this.lock.post({ type: 'released', from: TAB_ID });
        toast.info('Another tab took over editing this project. This tab is now read-only.');
      })();
    }
  }

  private async reloadFromStorage() {
    const loaded = await loadProjectState(this.projectId);
    useProjectStore.getState().load(loaded.state);
    this.followerSeq = loaded.seq;
  }

  /** Asks the writing tab to flush and release, then becomes the writer (row 100). */
  async takeOver(): Promise<boolean> {
    const released = new Promise<void>((resolve) => {
      const off = this.lock.onMessage((m) => {
        if (m.type === 'released') {
          off();
          resolve();
        }
      });
      setTimeout(resolve, 5000);
    });
    this.lock.post({ type: 'takeover-request', from: TAB_ID });
    await released;
    let ok = await this.lock.acquire({ wait: true, timeoutMs: 3000 });
    if (!ok) ok = await this.lock.acquire({ steal: true });
    if (!ok) return false;
    const loaded = await loadProjectState(this.projectId);
    useProjectStore.getState().load(loaded.state);
    this.engine?.dispose();
    this.engine = new AutosaveEngine(
      {
        projectId: this.projectId,
        getState: this.getState,
        onFlushed: (records) => this.lock.post({ type: 'ops', from: TAB_ID, records }),
      },
      this.settings,
      serializer,
      loaded.seq,
      { lastSnapshotSeq: loaded.report.snapshotSeq },
    );
    this.unsubs.push(this.engine.subscribe((status) => useSessionStore.getState().set({ status })));
    this.becomeWriter();
    return true;
  }

  async lifecycleSave() {
    if (this.closed || useSessionStore.getState().followerOf) return;
    await Promise.allSettled([this.drafts.flush(), this.engine?.lifecycleSave()]);
    await this.file.writeIfChanged('lifecycle').catch(() => false);
  }

  /** Automatic restore point before a high-impact operation (row 92). */
  async beforeHighImpact(label: string) {
    if (useSessionStore.getState().followerOf) return;
    await this.engine?.restorePoint('auto-restore-point', `Before ${label}`);
  }

  async createNamedRestorePoint(label: string) {
    return this.engine?.restorePoint('named', label) ?? null;
  }

  /** Before export (row 92): flush and checkpoint. */
  async beforeExport() {
    await this.engine?.lifecycleSave();
  }

  /** Restores a restore point as an undoable command, after taking a restore point of the current state. */
  async applyRestorePoint(snapshotId: string): Promise<boolean> {
    const rec = await getSnapshot(snapshotId);
    if (!rec) return false;
    const state = await verifySnapshot(rec);
    await this.beforeHighImpact(`restoring "${rec.label ?? 'restore point'}"`);
    const store = useProjectStore.getState();
    if (store.preview) store.endPreview();
    return store.commit(`Restore "${rec.label ?? rec.at}"`, () => ({ ...state.project, id: this.projectId }));
  }

  async previewRestorePoint(snapshotId: string): Promise<boolean> {
    const rec = await getSnapshot(snapshotId);
    if (!rec) return false;
    const state = await verifySnapshot(rec);
    useProjectStore
      .getState()
      .startPreview(state, { snapshotId, label: rec.label ?? 'Restore point', at: rec.at });
    useProjectStore.getState().setReadOnly(true, 'preview');
    return true;
  }

  endPreview() {
    const store = useProjectStore.getState();
    store.endPreview();
    store.setReadOnly(
      useSessionStore.getState().followerOf,
      useSessionStore.getState().followerOf ? 'other-tab' : null,
    );
  }

  async buildFile(): Promise<Uint8Array> {
    return buildProjectFile(this.getState().project, __APP_VERSION__);
  }

  noteFileSaved() {
    this.lastFileOrBackupAt = Date.now();
    this.engine?.markFileSaved();
  }

  private startBackupReminder() {
    if (fsaSupported()) return;
    this.backupTimer = setInterval(() => {
      const minutes = this.settings.backupReminderMin;
      const dirty = (this.engine?.currentSeq ?? 0) > 0;
      if (dirty && Date.now() - this.lastFileOrBackupAt > minutes * 60_000) {
        this.lastFileOrBackupAt = Date.now();
        window.dispatchEvent(new CustomEvent('pat:backup-reminder'));
      }
    }, 60_000);
  }

  updateSettings(s: AutosaveSettings) {
    this.settings = s;
    this.engine?.updateSettings(s);
    this.file.setInterval(s.fileAutosaveIntervalSec);
    useSessionStore.getState().set({ settings: s });
  }

  async close(save = true) {
    if (this.closed) return;
    if (save) await this.lifecycleSave();
    this.closed = true;
    setJournalSink(null);
    for (const u of this.unsubs) u();
    if (this.backupTimer) clearInterval(this.backupTimer);
    this.engine?.dispose();
    this.drafts.dispose();
    this.file.dispose();
    this.lock.dispose();
    useProjectStore.getState().unload();
    useSessionStore
      .getState()
      .set({ projectId: null, status: null, file: null, report: null, followerOf: false });
    sessionTracker.setProject(null);
  }
}

let current: ProjectSession | null = null;

export function currentSession(): ProjectSession | null {
  return current;
}

export async function openSession(
  projectId: string,
  opts: { checkpointOnly?: boolean } = {},
): Promise<ProjectSession> {
  if (current) await current.close();
  current = await ProjectSession.open(projectId, opts);
  return current;
}

export async function closeSession(save = true) {
  const s = current;
  current = null;
  await s?.close(save);
}

/** Test hook (row 94): lets E2E tests verify the indicator never claims "Saved" with unflushed edits. */
export function installTestHooks() {
  (window as unknown as { __pat?: unknown }).__pat = {
    session: () => current,
    status: () => current?.engine?.status ?? null,
    hasUnflushed: () => current?.engine?.hasUnflushed ?? false,
    project: () => useProjectStore.getState().history?.project ?? null,
    db: () => getDb(),
    store: () => useProjectStore.getState(),
    /** Links the project to a file in the Origin Private File System (fault-injection tests of row 98). */
    linkTestFile: async (name = 'linked.patproj') => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(name, { create: true });
      await current?.file.link(fh, -1, true);
      return true;
    },
    readTestFile: async (name = 'linked.patproj') => {
      const root = await navigator.storage.getDirectory();
      try {
        const fh = await root.getFileHandle(name);
        return Array.from(new Uint8Array(await (await fh.getFile()).arrayBuffer()));
      } catch {
        return null;
      }
    },
    /** Commits a "add layer" edit through the normal command path (used by fault-injection tests). */
    addLayer: (label: string, name: string) =>
      useProjectStore.getState().commit(label, (d) => {
        d.layers.push(createLayer(name, d.layers.length));
      }),
  };
}
