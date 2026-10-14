import { describe, expect, it } from 'vitest';

import { applyOp, commit, MAX_UNDO, redo, undo, type HistoryState, type JournalOp } from './history';
import { createProject } from './project';
import { createLayer } from './project';

function fresh(): HistoryState {
  return { project: createProject('Test'), undo: [], redo: [] };
}

describe('history', () => {
  it('undo restores the exact prior state and redo re-applies', () => {
    let s = fresh();
    const before = s.project;
    const r = commit(s, 'Add layer', (d) => {
      d.layers.push(createLayer('Zones', 1));
    })!;
    s = r.state;
    expect(s.project.layers).toHaveLength(2);
    const u = undo(s)!;
    expect(u.state.project).toEqual(before);
    const rr = redo(u.state)!;
    expect(rr.state.project).toEqual(s.project);
  });

  it('no-op recipes do not create history entries', () => {
    expect(commit(fresh(), 'nothing', () => {})).toBeNull();
  });

  it('keeps at least 200 undo steps', () => {
    let s = fresh();
    for (let i = 0; i < MAX_UNDO + 20; i++) {
      s = commit(s, `rename ${i}`, (d) => {
        d.name = `n${i}`;
      })!.state;
    }
    expect(s.undo).toHaveLength(MAX_UNDO);
    for (let i = 0; i < MAX_UNDO; i++) s = undo(s)!.state;
    expect(s.project.name).toBe('n19');
    expect(undo(s)).toBeNull();
  });

  it('replaying the journal reproduces state and stacks', () => {
    let s = fresh();
    const base = s;
    const ops: JournalOp[] = [];
    const step = (r: { state: HistoryState; op: JournalOp } | null) => {
      if (!r) throw new Error('expected change');
      s = r.state;
      ops.push(r.op);
    };
    step(commit(s, 'a', (d) => void (d.name = 'A')));
    step(commit(s, 'b', (d) => void d.layers.push(createLayer('L2', 1))));
    step(undo(s));
    step(commit(s, 'c', (d) => void (d.display.precision = 4)));
    step(undo(s));
    step(redo(s));
    let replay = base;
    for (const op of ops) replay = applyOp(replay, JSON.parse(JSON.stringify(op)) as JournalOp);
    expect(replay.project).toEqual(s.project);
    expect(replay.undo.map((e) => e.id)).toEqual(s.undo.map((e) => e.id));
    expect(replay.redo.map((e) => e.id)).toEqual(s.redo.map((e) => e.id));
  });

  it('coalesces commits with the same key into one undo step', () => {
    let s = fresh();
    const ops: JournalOp[] = [];
    for (let i = 0; i < 5; i++) {
      const r = commit(s, 'opacity', (d) => void (d.display.precision = i), { coalesceKey: 'k' })!;
      s = r.state;
      ops.push(r.op);
    }
    expect(s.undo).toHaveLength(1);
    expect(undo(s)!.state.project.display.precision).toBe(2);
    let replay = fresh();
    replay = {
      ...replay,
      project: {
        ...replay.project,
        id: s.project.id,
        createdAt: s.project.createdAt,
        updatedAt: s.project.updatedAt,
        layers: s.project.layers,
        activeLayerId: s.project.activeLayerId,
      },
    };
    for (const op of ops) replay = applyOp(replay, op);
    expect(replay.undo).toHaveLength(1);
  });
});
