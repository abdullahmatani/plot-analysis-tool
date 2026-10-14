import { original } from 'immer';
import { afterEach, describe, expect, it } from 'vitest';

import {
  applyOp,
  commit,
  redo,
  registerDerivation,
  undo,
  type HistoryState,
  type JournalOp,
} from './history';
import { createProject } from './project';

/** The derived-data hook of commit() (row 59): derived changes share the user's undo step. */

function fresh(): HistoryState {
  return { project: createProject('Derive'), undo: [], redo: [] };
}

let un: (() => void) | null = null;
afterEach(() => {
  un?.();
  un = null;
});

describe('registerDerivation', () => {
  it('runs after the recipe, inside the same patches and undo step', () => {
    const seen: string[] = [];
    un = registerDerivation((d, before) => {
      seen.push(`${before.name}→${d.name}`);
      // Derived value: the project's notes follow its name.
      d.legend.title = `Legend of ${d.name}`;
    });
    let s = fresh();
    const base = s.project;
    const r = commit(s, 'Rename', (d) => void (d.name = 'Plant A'))!;
    s = r.state;
    expect(seen).toEqual(['Derive→Plant A']);
    expect(s.project.legend.title).toBe('Legend of Plant A');
    expect(s.undo).toHaveLength(1);
    // One undo restores both the edit and the derived value.
    const u = undo(s)!;
    expect(u.state.project).toEqual(base);
    // Redo and journal replay apply the recorded patches only (no derivation run needed).
    un();
    un = null;
    const rr = redo(u.state)!;
    expect(rr.state.project.legend.title).toBe('Legend of Plant A');
    const replay = applyOp(fresh(), JSON.parse(JSON.stringify(r.op)) as JournalOp);
    expect(replay.project.legend.title).toBe('Legend of Plant A');
  });

  it('a derivation alone does not create a history entry when the recipe changes nothing', () => {
    un = registerDerivation((d) => {
      if (d.name === 'never') d.name = 'x';
    });
    expect(commit(fresh(), 'nothing', () => {})).toBeNull();
  });

  it('sees the post-recipe project with structural sharing; can be unregistered', () => {
    let calls = 0;
    let sharedLayers = false;
    un = registerDerivation((d, before) => {
      calls++;
      sharedLayers = original(d)!.layers === before.layers;
    });
    const s = fresh();
    commit(s, 'Replace', () => ({ ...s.project, name: 'Replaced' }));
    expect(calls).toBe(1);
    commit(s, 'Edit', (d) => void (d.name = 'Edited'));
    expect(calls).toBe(2);
    expect(sharedLayers).toBe(true);
    commit(s, 'Layer', (d) => void (d.layers[0].name = 'Renamed'));
    expect(sharedLayers).toBe(false);
    un();
    un = null;
    commit(s, 'Edit', (d) => void (d.name = 'Edited again'));
    expect(calls).toBe(3);
  });
});
