import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit, redo, undo, type HistoryState, type JournalOp } from '@/core/history';
import { createLayer, createProject } from '@/core/project';

import { AutosaveEngine } from './autosave';
import { getBlobBytes, putBlob } from './blobs';
import { getDb, PatDb, setDb, type JournalRecord } from './db';
import type { JournalWorkerMessage, JournalWriter } from './journal-client';
import { writeJournalBatch } from './journal-write';
import { DraftManager } from './drafts';
import { buildProjectFile, readProjectFile } from './project-file';
import { storeNewProject } from './projects';
import { loadProjectState, pendingRecovery } from './recovery';
import { serializeSnapshot } from './serialize';
import { DEFAULT_AUTOSAVE_SETTINGS } from './settings';
import type { StoreCheckpointer } from './serializer-client';
import { listSnapshots, preserveBeforeMigration, pruneSnapshots, verifySnapshot } from './snapshots';
import { checkpointFromStorage } from './store-checkpoint';

let dbCounter = 0;

beforeEach(async () => {
  setDb(new PatDb(`test-${dbCounter++}`));
});

afterEach(async () => {
  const db = getDb();
  db.close();
  await db.delete();
  setDb(null);
});

class Harness {
  state: HistoryState;
  engine: AutosaveEngine;
  ops: JournalOp[] = [];
  constructor(
    project = createProject('P'),
    settings = DEFAULT_AUTOSAVE_SETTINGS,
    storeCheckpoint: StoreCheckpointer | null = null,
  ) {
    this.state = { project, undo: [], redo: [] };
    this.engine = new AutosaveEngine(
      { projectId: project.id, getState: () => this.state },
      settings,
      serializeSnapshot,
      0,
      { storeCheckpoint },
    );
  }
  apply(r: { state: HistoryState; op: JournalOp } | null) {
    if (!r) throw new Error('no change');
    this.state = r.state;
    this.ops.push(r.op);
    this.engine.record(r.op);
  }
  addLayer(name: string) {
    this.apply(
      commit(this.state, `Add layer ${name}`, (d) => void d.layers.push(createLayer(name, d.layers.length))),
    );
  }
}

/** The snapshot worker's checkpoint path, run in-process. */
let storeCalls: string[] = [];
const fromStorage: StoreCheckpointer = async (a) => {
  const r = await checkpointFromStorage(a);
  storeCalls.push('record' in r ? 'stored' : `fallback: ${r.fallback}`);
  return 'record' in r ? r.record : null;
};

describe('checkpoints built from storage (NFR-10)', () => {
  beforeEach(() => {
    storeCalls = [];
  });

  it('produce exactly the in-memory state, including undo/redo history', async () => {
    const h = new Harness(
      createProject('P'),
      { ...DEFAULT_AUTOSAVE_SETTINGS, checkpointEvery: 1000 },
      fromStorage,
    );
    await storeNewProject(h.state.project);
    for (let i = 0; i < 8; i++) h.addLayer(`L${i}`);
    h.apply(undo(h.state));
    h.apply(undo(h.state));
    h.apply(redo(h.state));
    const rec = await h.engine.checkpoint('test');
    expect(storeCalls).toEqual(['stored']);
    expect(rec?.seq).toBe(11);
    const [latest] = await listSnapshots(h.state.project.id);
    const snap = await verifySnapshot(latest);
    expect(snap.project).toEqual(h.state.project);
    expect(snap.undo.map((e) => e.id)).toEqual(h.state.undo.map((e) => e.id));
    expect(snap.redo.map((e) => e.id)).toEqual(h.state.redo.map((e) => e.id));
    // Edits after the checkpoint still recover on top of it.
    h.addLayer('After');
    await h.engine.flush();
    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.report.snapshotSeq).toBe(11);
    expect(loaded.state.project).toEqual(h.state.project);
    h.engine.dispose();
  });

  it('a restore point captures the state at the moment it was requested', async () => {
    const h = new Harness(
      createProject('P'),
      { ...DEFAULT_AUTOSAVE_SETTINGS, checkpointEvery: 1000 },
      fromStorage,
    );
    await storeNewProject(h.state.project);
    h.addLayer('Before');
    const expected = h.state.project;
    const pending = h.engine.restorePoint('named', 'Baseline');
    h.addLayer('After'); // edited while the restore point is being written
    const rec = await pending;
    expect(storeCalls).toEqual(['stored']);
    const snap = await verifySnapshot(
      (await listSnapshots(h.state.project.id)).find((r) => r.id === rec!.id)!,
    );
    expect(snap.project).toEqual(expected);
    h.engine.dispose();
  });

  it('fall back to serialising the in-memory state when the stored journal has a gap', async () => {
    const h = new Harness(
      createProject('P'),
      { ...DEFAULT_AUTOSAVE_SETTINGS, checkpointEvery: 1000 },
      fromStorage,
    );
    await storeNewProject(h.state.project);
    for (let i = 0; i < 5; i++) h.addLayer(`L${i}`);
    await h.engine.flush();
    const entries = await getDb().journal.where('projectId').equals(h.state.project.id).toArray();
    await getDb().journal.delete([h.state.project.id, entries[2].seq]);
    await h.engine.checkpoint('test');
    expect(storeCalls[0]).toMatch(/^fallback/);
    const [latest] = await listSnapshots(h.state.project.id);
    expect((await verifySnapshot(latest)).project).toEqual(h.state.project);
    h.engine.dispose();
  });
});

describe('autosave journal + recovery', () => {
  it('replays journal entries on top of the initial snapshot', async () => {
    const h = new Harness();
    await storeNewProject(h.state.project);
    for (let i = 0; i < 10; i++) h.addLayer(`L${i}`);
    h.apply(undo(h.state));
    await h.engine.flush();
    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.state.project).toEqual(h.state.project);
    expect(loaded.report.replayed).toBe(11);
    expect(loaded.state.undo.map((e) => e.id)).toEqual(h.state.undo.map((e) => e.id));
    expect(loaded.state.redo.map((e) => e.id)).toEqual(h.state.redo.map((e) => e.id));
    h.engine.dispose();
  });

  it('status never reports saved while records are pending', async () => {
    const h = new Harness();
    await storeNewProject(h.state.project);
    const states: string[] = [];
    h.engine.subscribe((s) => states.push(`${s.state}:${s.pending}`));
    h.addLayer('A');
    expect(h.engine.status.state).toBe('saving');
    expect(h.engine.status.pending).toBeGreaterThan(0);
    await h.engine.flush();
    expect(h.engine.status.state).toBe('saved');
    for (const s of states) {
      const [state, pending] = s.split(':');
      if (state === 'saved') expect(Number(pending)).toBe(0);
    }
    h.engine.dispose();
  });

  it('checkpoints every N entries and compacts the journal (keeping entries after the previous snapshot)', async () => {
    const h = new Harness(createProject('P'), { ...DEFAULT_AUTOSAVE_SETTINGS, checkpointEvery: 5 });
    await storeNewProject(h.state.project);
    for (let i = 0; i < 12; i++) {
      h.addLayer(`L${i}`);
      await h.engine.flush();
    }
    // Let async checkpoints complete.
    await h.engine.checkpoint('test');
    const snaps = await listSnapshots(h.state.project.id);
    expect(snaps.filter((s) => s.kind === 'checkpoint').length).toBeLessThanOrEqual(3);
    const journal = await getDb().journal.where('projectId').equals(h.state.project.id).toArray();
    expect(journal.every((j) => j.seq > snaps[1].seq)).toBe(true);
    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.state.project).toEqual(h.state.project);
    h.engine.dispose();
  });

  it('a corrupted latest snapshot falls back to the previous one plus the journal with no loss (row 91)', async () => {
    const h = new Harness(createProject('P'), { ...DEFAULT_AUTOSAVE_SETTINGS, checkpointEvery: 1000 });
    await storeNewProject(h.state.project);
    for (let i = 0; i < 4; i++) h.addLayer(`A${i}`);
    await h.engine.checkpoint('t1');
    for (let i = 0; i < 4; i++) h.addLayer(`B${i}`);
    await h.engine.checkpoint('t2');
    for (let i = 0; i < 3; i++) h.addLayer(`C${i}`);
    await h.engine.flush();
    const [latest] = await listSnapshots(h.state.project.id);
    await getDb().snapshots.update(latest.id, { data: latest.data.replace('"B1"', '"XX"') });
    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.report.skippedSnapshots).toHaveLength(1);
    expect(loaded.state.project).toEqual(h.state.project);
    h.engine.dispose();
  });

  it('skips and reports a corrupt journal entry', async () => {
    const h = new Harness();
    await storeNewProject(h.state.project);
    h.addLayer('A');
    h.apply(commit(h.state, 'rename', (d) => void (d.name = 'Renamed')));
    await h.engine.flush();
    const rec = await getDb().journal.get([h.state.project.id, 1]);
    await getDb().journal.put({ ...rec!, hash: 'bad' });
    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.report.skippedEntries.map((e) => e.seq)).toEqual([1]);
    expect(loaded.state.project.name).toBe('Renamed');
    h.engine.dispose();
  });

  it('restore points reproduce the project exactly (hash) and retention keeps named points', async () => {
    const h = new Harness();
    await storeNewProject(h.state.project);
    h.addLayer('A');
    const named = await h.engine.restorePoint('named', 'Before change');
    h.addLayer('B');
    for (let i = 0; i < 40; i++) await h.engine.restorePoint('auto-restore-point', 'Automatic');
    await pruneSnapshots(h.state.project.id, { keepAutoPoints: 30, keepDailyDays: 30 });
    const snaps = await listSnapshots(h.state.project.id);
    expect(snaps.find((s) => s.id === named!.id)).toBeTruthy();
    expect(snaps.filter((s) => s.kind === 'auto-restore-point').length).toBeLessThanOrEqual(31);
    const { hashProject, parseSnapshotData } = await import('./serialize');
    const restored = parseSnapshotData(named!.data);
    expect(await hashProject(restored.project)).toBe(named!.projectHash);
    expect(restored.project.layers.map((l) => l.name)).toEqual(['Analysis', 'A']);
    h.engine.dispose();
  });

  it('pendingRecovery reports entries after the latest snapshot and drafts', async () => {
    const h = new Harness();
    await storeNewProject(h.state.project);
    h.addLayer('A');
    h.addLayer('B');
    await h.engine.flush();
    const drafts = new DraftManager(h.state.project.id);
    drafts.set({ key: 'trace', tool: 'trace', label: 'Trace' }, { pts: [1, 2, 3] });
    await drafts.flush();
    const p = await pendingRecovery(h.state.project.id);
    expect(p.entries).toHaveLength(2);
    expect(p.drafts).toBe(1);
    expect(p.summary).toContain('Add layer');
    expect((await drafts.list())[0].state).toEqual({ pts: [1, 2, 3] });
    drafts.dispose();
    h.engine.dispose();
  });

  it('redo/undo sequences survive reload (persistent undo, row 97)', async () => {
    const h = new Harness();
    await storeNewProject(h.state.project);
    h.addLayer('A');
    h.addLayer('B');
    h.apply(undo(h.state));
    h.apply(redo(h.state));
    await h.engine.checkpoint('mid');
    h.addLayer('C');
    await h.engine.flush();
    const loaded = await loadProjectState(h.state.project.id);
    const afterUndo = undo(loaded.state)!.state;
    expect(afterUndo.project.layers.map((l) => l.name)).toEqual(['Analysis', 'A', 'B']);
    h.engine.dispose();
  });
});

describe('blobs and project files', () => {
  it('deduplicates blobs by sha256', async () => {
    const bytes = new TextEncoder().encode('0\nSECTION\n0\nEOF\n');
    const a = await putBlob(bytes, 'a.dxf');
    const b = await putBlob(bytes, 'b.dxf');
    expect(a).toBe(b);
    expect(await getDb().blobs.count()).toBe(1);
    expect(await getBlobBytes(a)).toEqual(bytes);
  });

  it('round-trips a project file with drawings', async () => {
    const bytes = new TextEncoder().encode('drawing bytes');
    const sha = await putBlob(bytes, 'plan.dxf');
    const p = createProject('Site');
    p.drawings.push({
      id: 'd1',
      name: 'plan',
      source: { kind: 'dxf', fileName: 'plan.dxf', sha256: sha, blobKey: sha, size: bytes.length },
      opacity: 1,
      ghost: false,
      visible: true,
      hiddenSourceLayers: [],
      order: 0,
    });
    const file = await buildProjectFile(p, '0.1.0');
    await getDb().blobs.clear();
    const opened = await readProjectFile(file);
    expect(opened.project).toEqual(p);
    expect(opened.missingDrawings).toEqual([]);
    expect(await getBlobBytes(sha)).toEqual(bytes);
  });

  it('rejects files that are not projects with a readable error', async () => {
    await expect(readProjectFile(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a Plot Analysis project/);
  });
});

describe('schema migrations on open (row 87)', () => {
  it('replays the journal on the stored schema, migrates, and keeps the old state as a restore point', async () => {
    // A project as saved by a pre-release build: no schemaVersion field.
    const h = new Harness();
    const legacy = { ...h.state.project } as Record<string, unknown>;
    delete legacy.schemaVersion;
    h.state = { ...h.state, project: legacy as unknown as typeof h.state.project };
    await storeNewProject(h.state.project);
    h.addLayer('Old A');
    h.addLayer('Old B');
    await h.engine.flush();
    h.engine.dispose();

    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.report.migratedFrom).toBe(0);
    expect(loaded.state.project.schemaVersion).toBe(1);
    expect(loaded.state.project.layers.map((l) => l.name)).toEqual(['Analysis', 'Old A', 'Old B']);
    expect(loaded.state.undo).toEqual([]);
    expect(loaded.preMigration?.undo).toHaveLength(2);

    const rec = await preserveBeforeMigration(
      h.state.project.id,
      loaded.seq,
      loaded.preMigration!,
      0,
      serializeSnapshot,
    );
    expect(rec.kind).toBe('named');
    expect(rec.label).toBe('Before upgrade from schema 0');
    const kept = await verifySnapshot(rec);
    expect((kept.project as unknown as Record<string, unknown>).schemaVersion).toBeUndefined();

    // The session then checkpoints the migrated state, so the next open needs no migration.
    const engine = new AutosaveEngine(
      { projectId: h.state.project.id, getState: () => loaded.state },
      DEFAULT_AUTOSAVE_SETTINGS,
      serializeSnapshot,
      loaded.seq,
      { lastSnapshotSeq: -1 },
    );
    await engine.checkpoint('post-migration');
    engine.dispose();
    const again = await loadProjectState(h.state.project.id);
    expect(again.report.migratedFrom).toBeUndefined();
    expect(again.state.project).toEqual(loaded.state.project);
  });
});

/** In-process stand-in for the journal worker (same batching and ack protocol). */
function fakeWriter(opts: { failFirst?: number } = {}) {
  let fails = opts.failFirst ?? 0;
  const listeners = new Map<string, { fn: (m: JournalWorkerMessage) => void; onCrash: () => void }>();
  const pending = new Map<string, JournalRecord[]>();
  const rotations: string[] = [];
  const commit = async (projectId: string) => {
    const batch = pending.get(projectId) ?? [];
    if (!batch.length) return;
    pending.set(projectId, []);
    if (fails > 0) {
      fails--;
      pending.set(projectId, [...batch, ...(pending.get(projectId) ?? [])]);
      listeners
        .get(projectId)
        ?.fn({ type: 'error', projectId, message: 'disk busy', quota: false, retryInMs: 1 });
      setTimeout(() => void commit(projectId), 1);
      return;
    }
    await writeJournalBatch(projectId, batch);
    listeners.get(projectId)?.fn({ type: 'ack', projectId, upTo: batch[batch.length - 1].seq });
  };
  const writer: JournalWriter = {
    record(rec) {
      const q = pending.get(rec.projectId) ?? [];
      q.push(rec);
      pending.set(rec.projectId, q);
      setTimeout(() => void commit(rec.projectId), 5);
    },
    flush: (projectId) => void commit(projectId),
    rotate: (projectId) => void rotations.push(projectId),
    drop: () => {},
    listen(projectId, fn, onCrash) {
      listeners.set(projectId, { fn, onCrash });
      return () => listeners.delete(projectId);
    },
  };
  return { writer, rotations, crash: (projectId: string) => listeners.get(projectId)?.onCrash() };
}

describe('journal written off the main thread (row 90, NFR-9)', () => {
  function harness(writer: JournalWriter) {
    const h = new Harness();
    h.engine.dispose();
    h.engine = new AutosaveEngine(
      { projectId: h.state.project.id, getState: () => h.state },
      DEFAULT_AUTOSAVE_SETTINGS,
      serializeSnapshot,
      0,
      {
        journalWriter: writer,
      },
    );
    return h;
  }

  it('records reach storage through the writer and flush() waits for the acknowledgement', async () => {
    const { writer } = fakeWriter();
    const h = harness(writer);
    await storeNewProject(h.state.project);
    for (let i = 0; i < 6; i++) h.addLayer(`W${i}`);
    expect(h.engine.status.state).toBe('saving');
    await h.engine.flush();
    expect(h.engine.status.state).toBe('saved');
    expect(h.engine.hasUnflushed).toBe(false);
    const loaded = await loadProjectState(h.state.project.id);
    expect(loaded.state.project).toEqual(h.state.project);
    h.engine.dispose();
  });

  it('reports errors, keeps the records and recovers when the retry succeeds', async () => {
    const { writer } = fakeWriter({ failFirst: 2 });
    const h = harness(writer);
    await storeNewProject(h.state.project);
    const states: string[] = [];
    h.engine.subscribe((s) => states.push(s.state));
    h.addLayer('E1');
    await expect.poll(() => h.engine.status.state).toBe('saved');
    expect(states).toContain('error');
    expect((await loadProjectState(h.state.project.id)).state.project).toEqual(h.state.project);
    h.engine.dispose();
  });

  it('writes unacknowledged records on this thread when the worker dies', async () => {
    const { writer, crash } = fakeWriter();
    const h = harness(writer);
    await storeNewProject(h.state.project);
    // Records handed to a writer that never commits them, then the worker "crashes".
    const silent: JournalWriter = { ...writer, record: () => {}, flush: () => {} };
    h.engine.dispose();
    h.engine = new AutosaveEngine(
      { projectId: h.state.project.id, getState: () => h.state },
      DEFAULT_AUTOSAVE_SETTINGS,
      serializeSnapshot,
      0,
      {
        journalWriter: { ...silent, listen: writer.listen },
      },
    );
    h.addLayer('C1');
    h.addLayer('C2');
    const flushed = h.engine.flush();
    crash(h.state.project.id);
    await flushed;
    expect((await loadProjectState(h.state.project.id)).state.project).toEqual(h.state.project);
    h.engine.dispose();
  });
});
