import type { LegendConfig, LegendEntryOverride } from '@/core/types';
import { commit } from '@/store/project';

/** Legend edits (row 75): each user action is one undoable commit on `Project.legend`. */

type OverridePatch = Partial<Omit<LegendEntryOverride, 'key'>>;

function clean(o: LegendEntryOverride): boolean {
  for (const k of ['title', 'hidden', 'order', 'group'] as const) if (o[k] === undefined) delete o[k];
  return Object.keys(o).length > 1;
}

export function setLegendOverride(
  key: string,
  patch: OverridePatch,
  label: string,
  coalesceKey?: string,
): boolean {
  return commit(
    label,
    (d) => {
      let o = d.legend.overrides.find((x) => x.key === key);
      if (!o) {
        o = { key };
        d.legend.overrides.push(o);
      }
      Object.assign(o, patch);
      if (!clean(o)) d.legend.overrides = d.legend.overrides.filter((x) => x.key !== key);
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}

/** Writes an explicit order for every entry (one commit). */
export function setLegendOrder(order: Map<string, number>): boolean {
  return commit('Reorder legend entries', (d) => {
    for (const [key, n] of order) {
      let o = d.legend.overrides.find((x) => x.key === key);
      if (!o) {
        o = { key };
        d.legend.overrides.push(o);
      }
      o.order = n;
    }
  });
}

export function resetLegendEntry(key: string): boolean {
  return commit('Reset legend entry', (d) => {
    d.legend.overrides = d.legend.overrides.filter((x) => x.key !== key);
  });
}

export function resetLegend(): boolean {
  return commit('Reset legend edits', (d) => {
    d.legend.overrides = [];
  });
}

export function setLegendConfig(patch: Partial<LegendConfig>, label: string, coalesceKey?: string): boolean {
  return commit(
    label,
    (d) => {
      Object.assign(d.legend, patch);
    },
    coalesceKey ? { coalesceKey } : undefined,
  );
}
