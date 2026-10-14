import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { commit, type HistoryState } from '@/core/history';
import { createLayer, createProject } from '@/core/project';

import { AutosaveEngine } from './autosave';
import { getDb, PatDb, setDb, type JournalRecord } from './db';
import type { JournalWorkerMessage, JournalWriter } from './journal-client';
import { writeJournalBatch } from './journal-write';
import { checkMirror, type MirrorSource } from './mirror';
import {
  decodeFrames,
  encodeBase,
  encodeJournal,
  mirrorFileName,
  pickMirror,
  readMirrorFile,
  type MirrorBase,
} from './mirror-format';
import { MirrorWriter, type MirrorFile, type MirrorFiles } from './mirror-writer';
import { deleteProject, storeNewProject } from './projects';
import { loadProjectState } from './recovery';
import { serializeSnapshot } from './serialize';
import { DEFAULT_AUTOSAVE_SETTINGS } from './settings';
import { checkpointFromStorage } from './store-checkpoint';

let dbCounter = 0;
beforeEach(() => setDb(new PatDb(`mirror-${dbCounter++}`)));
afterEach(async () => {
  const db = getDb();
  db.close();
  await db.delete();
  setDb(null);
});

/** In-memory stand-in for the private file system. */
function memoryFs() {
  const files = new Map<string, Uint8Array>();
  const blobs = new Map<string, number>();
  const mf: MirrorFiles = {
    async open(name, fn) {
      if (!files.has(name)) files.set(name, new Uint8Array(0));
      const f: MirrorFile = {
        size: () => files.get(name)!.length,
        read: () => files.get(name)!.slice(),
        write: (bytes, at) => {
          const cur = files.get(name)!;
          const next = new Uint8Array(Math.max(cur.length, at + bytes.length));
          next.set(cur);
          next.set(bytes, at);
          files.set(name, next);
        },
        truncate: (size) => files.set(name, files.get(name)!.slice(0, size)),
        flush: () => {},
      };
      return fn(f);
    },
    async remove(name) {
      files.delete(name);
    },
  };
  const src: MirrorSource = {
    list: async () => [...files.keys()],
    read: async (n) => files.get(n) ?? null,
    remove: async (n) => void files.delete(n),
    blobSize: async (sha) => blobs.get(sha) ?? null,
  };
  return { files, blobs, mf, src };
}

/** The journal worker's behaviour: write the batch, append it to the backup, acknowledge. */
function workerLike(mirror: MirrorWriter): JournalWriter {
  const pending = new Map<string, JournalRecord[]>();
  const listeners = new Map<string, (m: JournalWorkerMessage) => void>();
  return {
    record(rec) {
      pending.set(rec.projectId, [...(pending.get(rec.projectId) ?? []), rec]);
    },
    flush(projectId) {
      const batch = pending.get(projectId) ?? [];
      pending.set(projectId, []);
      void (async () => {
        if (batch.length) await writeJournalBatch(projectId, batch);
        if (batch.length) await mirror.append(projectId, batch);
        if (batch.length) listeners.get(projectId)?.({ type: 'ack', projectId, upTo: batch.at(-1)!.seq });
      })();
    },
    rotate: (projectId) => void mirror.rotate(projectId),
    drop: (projectId) => void mirror.drop(projectId),
    listen(projectId, fn) {
      listeners.set(projectId, fn);
      return () => listeners.delete(projectId);
    },
  };
}

async function setup() {
  const fs = memoryFs();
  const mirror = new MirrorWriter(fs.mf);
  let state: HistoryState = { project: createProject('Mirrored'), undo: [], redo: [] };
  await storeNewProject(state.project);
  await mirror.rotate(state.project.id);
  const engine = new AutosaveEngine(
    { projectId: state.project.id, getState: () => state },
    DEFAULT_AUTOSAVE_SETTINGS,
    serializeSnapshot,
    0,
    { journalWriter: workerLike(mirror) },
  );
  const addLayer = (name: string) => {
    const r = commit(
      state,
      `Add layer ${name}`,
      (d) => void d.layers.push(createLayer(name, d.layers.length)),
    )!;
    state = r.state;
    engine.record(r.op);
  };
  return {
    fs,
    mirror,
    engine,
    addLayer,
    get state() {
      return state;
    },
  };
}

/** What Chromium does to a damaged store: the whole database is gone at the next start. */
async function wipeDatabase() {
  const db = getDb();
  db.close();
  await db.delete();
  setDb(new PatDb(`mirror-${dbCounter++}`));
}

const sampleBase = (gen: number): MirrorBase => ({
  v: 1,
  gen,
  meta: {
    id: 'p1',
    name: 'P',
    createdAt: 't',
    updatedAt: 't',
    lastOpenedAt: 't',
    lastSeq: 0,
    drawingCount: 0,
    objectCount: 0,
    blobKeys: [],
  },
  snapshot: { seq: 0, at: 't', sha256: 'x', projectHash: 'y', data: '{}', size: 2 },
  blobs: [],
});
const rec = (seq: number): JournalRecord => ({
  projectId: 'p1',
  seq,
  at: `t${seq}`,
  op: { label: `op ${seq}`, patches: [], inverse: [] } as unknown as JournalRecord['op'],
  hash: 'h',
});
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

describe('backup file format', () => {
  it('reads frames up to a damaged or incomplete one', () => {
    const good = concat(encodeBase(sampleBase(1)), encodeJournal({ recs: [rec(1), rec(2)] }));
    const third = encodeJournal({ recs: [rec(3)] });
    // Incomplete last frame (the crash happened while it was written).
    const cut = concat(good, third.subarray(0, third.length - 3));
    expect(readMirrorFile('a', cut)!.lastSeq).toBe(2);
    expect(decodeFrames(cut).validBytes).toBe(good.length);
    // A damaged frame in the middle: nothing after it is used.
    const damaged = concat(good, third, encodeJournal({ recs: [rec(4)] }));
    damaged[good.length + 12] ^= 0xff;
    expect(readMirrorFile('a', damaged)!.lastSeq).toBe(2);
    expect(readMirrorFile('a', concat(good, third))!.journal.map((r) => r.seq)).toEqual([1, 2, 3]);
  });

  it('stops at a gap in the sequence and skips records already in the base', () => {
    const bytes = concat(
      encodeBase(sampleBase(1)),
      encodeJournal({ recs: [rec(0), rec(1)] }),
      encodeJournal({ recs: [rec(3)] }),
    );
    expect(readMirrorFile('a', bytes)!.journal.map((r) => r.seq)).toEqual([1]);
  });

  it('a file without a valid base is ignored, and the newer generation wins', () => {
    expect(readMirrorFile('a', encodeJournal({ recs: [rec(1)] }))).toBeNull();
    expect(readMirrorFile('a', new Uint8Array(0))).toBeNull();
    const a = readMirrorFile('a', encodeBase(sampleBase(4)));
    const b = readMirrorFile('b', encodeBase(sampleBase(5)));
    expect(pickMirror(a, b)!.slot).toBe('b');
    expect(pickMirror(a, null)!.slot).toBe('a');
  });
});

describe('backup copy outside IndexedDB (C7, rows 90 and 102)', () => {
  it('a project is rebuilt with every saved edit after the browser deletes the database', async () => {
    const t = await setup();
    for (let i = 0; i < 5; i++) t.addLayer(`L${i}`);
    await t.engine.flush();
    t.addLayer('L5');
    await t.engine.flush();
    const expected = t.state.project;
    t.engine.dispose();
    await wipeDatabase();
    expect(await checkMirror(t.fs.src)).toEqual(['Mirrored']);
    const loaded = await loadProjectState(expected.id);
    expect(loaded.state.project).toEqual(expected);
    expect((await getDb().projects.get(expected.id))!.lastSeq).toBe(6);
  });

  it('after a checkpoint the backup starts a new base in the other file', async () => {
    const t = await setup();
    for (let i = 0; i < 3; i++) t.addLayer(`A${i}`);
    await t.engine.flush();
    await checkpointFromStorage({
      projectId: t.state.project.id,
      seq: 3,
      kind: 'checkpoint',
      settings: DEFAULT_AUTOSAVE_SETTINGS,
    });
    await t.mirror.rotate(t.state.project.id);
    t.addLayer('B0');
    await t.engine.flush();
    const id = t.state.project.id;
    const b = readMirrorFile('b', t.fs.files.get(mirrorFileName(id, 'b'))!)!;
    expect(b.base.snapshot.seq).toBe(3);
    expect(b.journal.map((r) => r.seq)).toEqual([4]);
    const expected = t.state.project;
    t.engine.dispose();
    await wipeDatabase();
    await checkMirror(t.fs.src);
    expect((await loadProjectState(id)).state.project).toEqual(expected);
  });

  it('a damaged tail loses only the batch being written', async () => {
    const t = await setup();
    t.addLayer('K0');
    await t.engine.flush();
    const atK0 = t.state.project;
    t.addLayer('K1');
    await t.engine.flush();
    const name = mirrorFileName(atK0.id, 'a');
    const bytes = t.fs.files.get(name)!;
    t.fs.files.set(name, bytes.subarray(0, bytes.length - 5));
    t.engine.dispose();
    await wipeDatabase();
    await checkMirror(t.fs.src);
    expect((await loadProjectState(atK0.id)).state.project).toEqual(atK0);
  });

  it('appends after a damaged tail land after the last valid frame', async () => {
    const t = await setup();
    t.addLayer('D0');
    await t.engine.flush();
    const id = t.state.project.id;
    const name = mirrorFileName(id, 'a');
    // A frame cut short by a crash, then a restart (the writer reloads the file).
    t.fs.files.set(name, concat(t.fs.files.get(name)!, new Uint8Array([9, 9, 9])));
    const fresh = new MirrorWriter(t.fs.mf);
    const r = commit(t.state, 'Add layer D1', (d) => void d.layers.push(createLayer('D1', d.layers.length)))!;
    const batch: JournalRecord = {
      projectId: id,
      seq: 2,
      at: new Date().toISOString(),
      op: r.op,
      hash: 'test',
    };
    await writeJournalBatch(id, [batch]);
    await fresh.append(id, [batch]);
    expect(readMirrorFile('a', t.fs.files.get(name)!)!.lastSeq).toBe(2);
    t.engine.dispose();
  });

  it('an intact database is left alone and backups of deleted projects are removed', async () => {
    const t = await setup();
    t.addLayer('X');
    await t.engine.flush();
    t.engine.dispose();
    expect(await checkMirror(t.fs.src)).toEqual([]); // marker written, nothing to restore
    expect(await checkMirror(t.fs.src)).toEqual([]);
    const id = t.state.project.id;
    expect(t.fs.files.has(mirrorFileName(id, 'a'))).toBe(true);
    await deleteProject(id);
    await checkMirror(t.fs.src);
    expect([...t.fs.files.keys()]).toEqual([]);
  });

  it('a new base is started once the journal part grows past its limit', async () => {
    const t = await setup();
    t.engine.dispose();
    const id = t.state.project.id;
    const mirror = new MirrorWriter(t.fs.mf, { frames: 3, bytes: Infinity });
    let state = t.state;
    for (let seq = 1; seq <= 5; seq++) {
      const r = commit(
        state,
        `Add ${seq}`,
        (d) => void d.layers.push(createLayer(`N${seq}`, d.layers.length)),
      )!;
      state = r.state;
      const batch: JournalRecord = { projectId: id, seq, at: `t${seq}`, op: r.op, hash: 'test' };
      await writeJournalBatch(id, [batch]);
      await mirror.append(id, [batch]);
    }
    // Base (gen 1, slot a) + 3 frames, then the 4th append rotated into slot b, then one more frame.
    const b = readMirrorFile('b', t.fs.files.get(mirrorFileName(id, 'b'))!)!;
    expect(b.base.gen).toBe(2);
    expect(b.lastSeq).toBe(5);
    expect(pickMirror(readMirrorFile('a', t.fs.files.get(mirrorFileName(id, 'a'))!), b)!.slot).toBe('b');
  });

  it('drawing files kept in the private file system are re-attached', async () => {
    const t = await setup();
    const id = t.state.project.id;
    await getDb().blobs.put({
      sha256: 'abc',
      size: 3,
      name: 'site.dxf',
      type: 'image/vnd.dxf',
      where: 'opfs',
      createdAt: 'now',
    });
    await getDb().projects.update(id, { blobKeys: ['abc'] });
    await t.mirror.rotate(id);
    t.fs.blobs.set('abc', 3);
    // A drawing imported after the base is known only by its key in the journal's metadata.
    t.fs.blobs.set('def', 7);
    const r = commit(t.state, 'Import', (d) => void d.layers.push(createLayer('Imported', 1)))!;
    const batch: JournalRecord = {
      projectId: id,
      seq: 1,
      at: new Date().toISOString(),
      op: r.op,
      hash: 'test',
    };
    await writeJournalBatch(id, [batch]);
    await t.mirror.append(id, [batch], {
      name: 'Mirrored',
      drawingCount: 2,
      objectCount: 0,
      blobKeys: ['abc', 'def', 'missing'],
    });
    t.engine.dispose();
    await wipeDatabase();
    await checkMirror(t.fs.src);
    expect(await getDb().blobs.get('abc')).toMatchObject({ name: 'site.dxf', size: 3, where: 'opfs' });
    expect(await getDb().blobs.get('def')).toMatchObject({ size: 7, where: 'opfs' });
    expect(await getDb().blobs.get('missing')).toBeUndefined();
    expect((await getDb().projects.get(id))!.blobKeys).toEqual(['abc', 'def', 'missing']);
  });

  it('the autosave engine asks for a new backup base after each checkpoint', async () => {
    const rotations: string[] = [];
    const t = await setup();
    t.engine.dispose();
    let state: HistoryState = { project: createProject('R'), undo: [], redo: [] };
    await storeNewProject(state.project);
    const writer = workerLike(t.mirror);
    const engine = new AutosaveEngine(
      { projectId: state.project.id, getState: () => state },
      DEFAULT_AUTOSAVE_SETTINGS,
      serializeSnapshot,
      0,
      { journalWriter: { ...writer, rotate: (p) => void rotations.push(p) } },
    );
    const r = commit(state, 'Add layer', (d) => void d.layers.push(createLayer('Z', 1)))!;
    state = r.state;
    engine.record(r.op);
    await engine.checkpoint('test');
    expect(rotations).toEqual([state.project.id]);
    engine.dispose();
  });
});
