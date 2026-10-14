import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLayer, createProject, SCHEMA_VERSION } from '@/core/project';
import type { AnalysisObject, Project } from '@/core/types';
import { makeObject } from '@/features/objects/ops';

import { hashBytes, putBlob } from './blobs';
import { getDb, PatDb, setDb } from './db';
import { buildProjectFile, readProjectFile } from './project-file';

/**
 * Row 87: project files saved by earlier builds open in this one. The fixtures in
 * tests/fixtures/projects are committed snapshots; regenerate the current-schema one with
 * `PAT_WRITE_FIXTURES=1 npx vitest run src/persistence/project-fixtures.test.ts` only when the
 * schema changes (keep the old files: they are what older builds produced).
 */

const DIR = path.resolve(__dirname, '../../tests/fixtures/projects');
let n = 0;
beforeEach(() => setDb(new PatDb(`fixtures-${n++}`)));
afterEach(async () => {
  const db = getDb();
  db.close();
  await db.delete();
  setDb(null);
});

function invariants(p: Project) {
  expect(p.schemaVersion).toBe(SCHEMA_VERSION);
  expect(p.layers.length).toBeGreaterThan(0);
  expect(p.layers.some((l) => l.id === p.activeLayerId)).toBe(true);
  const layerIds = new Set(p.layers.map((l) => l.id));
  for (const o of p.objects) expect(layerIds.has(o.layerId), o.name).toBe(true);
  for (const k of [
    'display',
    'legend',
    'sheet',
    'north',
    'anchors',
    'datasets',
    'views',
    'exportProfiles',
    'stylePresets',
  ] as const)
    expect(p[k], k).toBeDefined();
}

/** A project exercising every 0.x feature area, as saved by the 0.x builds (schema 1). */
async function richProject(): Promise<Uint8Array> {
  const dxf = new Uint8Array(
    readFileSync(path.resolve(__dirname, '../../tests/fixtures/dxf/r12_entities.dxf')),
  );
  const sha = await hashBytes(dxf);
  await putBlob(dxf, 'r12_entities.dxf', 'application/dxf', sha);
  const p = createProject('Fixture — all 0.x features');
  p.createdAt = p.updatedAt = '2026-10-14T00:00:00.000Z';
  p.layers.push(createLayer('Zones', 1));
  p.drawings.push({
    id: 'drw_fixture',
    name: 'r12_entities',
    source: { kind: 'dxf', fileName: 'r12_entities.dxf', sha256: sha, blobKey: sha, size: dxf.byteLength },
    nativeUnits: 'm',
    calibration: { method: 'two-point', transform: [1, 0, 0, 1, 0, 0], references: [], at: p.createdAt },
    opacity: 0.8,
    ghost: false,
    visible: true,
    hiddenSourceLayers: [],
    order: 0,
  });
  const add = (o: Parameters<typeof makeObject>[1]): AnalysisObject => {
    const obj = { ...makeObject(p, o), id: `obj_${p.objects.length}`, createdAt: p.createdAt };
    p.objects.push(obj);
    return obj;
  };
  const src = add({ geometry: { type: 'rect', c: { x: 10, y: 10 }, w: 8, h: 4, rot: 0.3 } });
  add({
    kind: 'offset',
    geometry: { type: 'circle', c: { x: 10, y: 10 }, r: 15 },
    derived: { kind: 'offset', sourceId: src.id, distance: 5, join: 'round' },
  });
  add({
    kind: 'trace',
    geometry: {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 5, y: 0, bulge: 0.4 },
        { x: 5, y: 5 },
      ],
      closed: true,
    },
  });
  add({ kind: 'text', geometry: { type: 'point', p: { x: 1, y: 2 } }, text: 'خزان T-101' });
  add({ kind: 'tag', geometry: { type: 'point', p: { x: 3, y: 4 } }, tagNumber: 1 });
  add({
    kind: 'measurement',
    geometry: {
      type: 'polyline',
      pts: [
        { x: 0, y: 0 },
        { x: 3, y: 4 },
      ],
      closed: false,
    },
    measurement: { mode: 'distance' },
  });
  p.anchors.push({ id: 'anc_1', name: 'P-101', p: { x: 20, y: 20 } });
  p.datasets.push({
    id: 'ds_1',
    name: 'Jet fire',
    visible: true,
    table: { columns: ['Tag', 'R1'], rows: [['P-101', 12.5]] },
    mapping: {
      position: { mode: 'anchor', anchor: 'Tag' },
      sizeColumns: ['R1'],
      sizeMode: 'radius',
      sizeUnit: 'm',
      label: 'Tag',
    },
    sizeStyles: [],
    styleRules: [],
    labelTemplate: '{label}',
    labelPlacement: 'top',
    envelope: false,
    order: 0,
  });
  p.views.push({ id: 'view_1', name: 'Overview', centre: { x: 10, y: 10 }, scale: 4, rotation: 0 });
  return buildProjectFile(p, '0.9.0');
}

describe('project files from earlier builds (row 87)', () => {
  it('opens a pre-release (schema 0) project file', async () => {
    const legacy = { name: 'Draft', layers: [], objects: [], drawings: [] };
    const bytes = zipSync({
      'project.json': strToU8(
        JSON.stringify({ format: 'plot-analysis-tool/project', formatVersion: 1, project: legacy }),
      ),
    });
    const file = path.join(DIR, 'schema0-draft.patproj');
    if (process.env.PAT_WRITE_FIXTURES || !existsSync(file)) writeFileSync(file, bytes);
    const opened = await readProjectFile(new Uint8Array(readFileSync(file)));
    expect(opened.migratedFrom).toBe(0);
    invariants(opened.project);
  });

  it('opens a project saved by the 0.x builds (schema 1) with every feature area', async () => {
    const file = path.join(DIR, 'schema1-0x-all-features.patproj');
    if (process.env.PAT_WRITE_FIXTURES || !existsSync(file)) writeFileSync(file, await richProject());
    const opened = await readProjectFile(new Uint8Array(readFileSync(file)));
    expect(opened.missingDrawings).toEqual([]);
    invariants(opened.project);
    expect(opened.project.objects.map((o) => o.kind)).toEqual([
      'shape',
      'offset',
      'trace',
      'text',
      'tag',
      'measurement',
    ]);
    expect(opened.project.datasets[0].name).toBe('Jet fire');
    expect(opened.project.anchors[0].name).toBe('P-101');
  });
});
