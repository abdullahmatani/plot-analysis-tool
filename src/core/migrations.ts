import { createProject, SCHEMA_VERSION } from './project';
import type { Project } from './types';

/**
 * Project schema migrations (row 87). Each step upgrades version n → n+1. Projects saved by any
 * earlier build open in the current one; an automatic restore point is taken before migrating
 * (see persistence/autosave).
 */
type Migration = (p: Record<string, unknown>) => Record<string, unknown>;

/** MIGRATIONS[n] upgrades schema n → n+1. Schema 0 = pre-release drafts without a version field. */
const MIGRATIONS: Record<number, Migration> = {
  0: (p) => ({ ...p, schemaVersion: 1 }),
};

export class SchemaTooNewError extends Error {
  constructor(public version: number) {
    super(
      `This project was saved by a newer version of the app (schema ${version}; this build reads up to ${SCHEMA_VERSION}).`,
    );
  }
}

export function migrateProject(input: unknown): { project: Project; from: number } {
  if (!input || typeof input !== 'object') throw new Error('Not a project');
  let p = input as Record<string, unknown>;
  const from = typeof p.schemaVersion === 'number' ? p.schemaVersion : 0;
  if (from > SCHEMA_VERSION) throw new SchemaTooNewError(from);
  for (let v = from; v < SCHEMA_VERSION; v++) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`No migration from schema ${v}`);
    p = step(p);
  }
  return { project: fillDefaults(p as unknown as Project), from };
}

/** Adds fields introduced after a project was created, without touching existing values. */
function fillDefaults(p: Project): Project {
  const d = createProject(p.name);
  const out = { ...d, ...p } as Project;
  out.display = { ...d.display, ...(p.display ?? {}) };
  out.legend = { ...d.legend, ...(p.legend ?? {}) };
  out.sheet = {
    ...d.sheet,
    ...(p.sheet ?? {}),
    titleBlock: { ...d.sheet.titleBlock, ...(p.sheet?.titleBlock ?? {}) },
  };
  out.north = { ...d.north, ...(p.north ?? {}) };
  if (!p.layers?.length) {
    out.layers = d.layers;
    out.activeLayerId = d.activeLayerId;
  } else if (!p.layers.some((l) => l.id === p.activeLayerId)) {
    out.activeLayerId = p.layers[0].id;
  }
  // If nothing needed filling, return the original object (keeps Immer structural sharing).
  return JSON.stringify(out) === JSON.stringify(p) ? p : out;
}
