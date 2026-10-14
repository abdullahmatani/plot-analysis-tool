import type { AnalysisObject, Geometry, OffsetDerivation, Project, StyleOverride, Units } from '@/core/types';
import { formatNumber, fromMetres, UNIT_LABEL } from '@/core/units';
import { newId } from '@/core/ids';
import { unionGeometries } from '@/geometry/boolean';
import { isClosed } from '@/geometry/convert';
import type { OffsetCap, OffsetJoin } from '@/geometry/offset';
import { rampColors } from '@/tables/style-rules';
import type { NewObjectInput } from '@/features/objects/ops';

import { computeOffset } from './derive';

/**
 * Planning of offset commands (rows 55–60), free of UI and store access so it can be unit tested:
 * single and batch offsets (optionally merged into one envelope), multi-ring offsets with labels and
 * ramp colours, and the distance label text.
 */

export interface OffsetParams {
  distance: number;
  join: OffsetJoin;
  cap: OffsetCap;
  miterLimit: number;
  /** Keep a live link to the source (row 59). */
  live: boolean;
  /** Merge overlapping closed results into one envelope (row 60). */
  merge: boolean;
}

export const DEFAULT_OFFSET_PARAMS: OffsetParams = {
  distance: 10,
  join: 'round',
  cap: 'round',
  miterLimit: 2,
  live: true,
  merge: false,
};

export interface OffsetPlan {
  inputs: NewObjectInput[];
  /** Messages for sources that produced no result or a partial result. */
  warnings: string[];
}

/** "+10 m", "-2.5 m": signed distance in display units with trailing zeros removed. */
export function formatOffset(d: number, units: Units, precision: number): string {
  const n = formatNumber(fromMetres(Math.abs(d), units), precision)
    .replace(/(\.\d*?)0+$/, '$1')
    .replace(/\.$/, '');
  return `${d < 0 ? '-' : '+'}${n} ${UNIT_LABEL[units]}`;
}

export function derivation(sourceId: string, p: OffsetParams, distance = p.distance): OffsetDerivation {
  const der: OffsetDerivation = { kind: 'offset', sourceId, distance, join: p.join };
  der.cap = p.cap;
  if (p.join === 'miter') der.miterLimit = p.miterLimit;
  return der;
}

/** Offsets of each source (one object per source, or one merged envelope). */
export function planOffsets(project: Project, sources: AnalysisObject[], p: OffsetParams): OffsetPlan {
  const { units, precision } = project.display;
  const tol = project.chordTolerance;
  const label = formatOffset(p.distance, units, precision);
  const warnings: string[] = [];
  const results: { src: AnalysisObject; geometry: Geometry }[] = [];
  for (const src of sources) {
    const der = derivation(src.id, p);
    const res = computeOffset(src.geometry, der, tol);
    if (res.warning) warnings.push(`${src.name}: ${res.warning}`);
    if (res.geometry) results.push({ src, geometry: res.geometry });
  }
  const one = (src: AnalysisObject, geometry: Geometry): NewObjectInput => ({
    kind: 'offset',
    geometry,
    name: `${src.name} ${label}`,
    derived: p.live ? derivation(src.id, p) : undefined,
    attributes: { offset: label, source: src.name },
  });
  if (!p.merge || results.length < 2) return { inputs: results.map((r) => one(r.src, r.geometry)), warnings };
  const closed = results.filter((r) => isClosed(r.geometry));
  const open = results.filter((r) => !isClosed(r.geometry));
  const inputs: NewObjectInput[] = open.map((r) => one(r.src, r.geometry));
  if (closed.length === 1) inputs.unshift(one(closed[0].src, closed[0].geometry));
  else if (closed.length > 1) {
    const env = unionGeometries(
      closed.map((r) => r.geometry),
      tol,
    );
    if (env)
      inputs.unshift({
        kind: 'offset',
        geometry: env,
        name: `Envelope ${label}`,
        attributes: { offset: label, sources: closed.length },
      });
  }
  if (open.length && closed.length > 1)
    warnings.push(`${open.length} open result(s) (arcs) have no area and were not merged`);
  return { inputs, warnings };
}

export interface RingParams extends Omit<OffsetParams, 'distance' | 'merge' | 'live'> {
  distances: number[];
  ramp: string;
}

/** Parses "10, 25, 50" (display units unless a unit is given) into metres; null on error. */
export function parseDistanceList(text: string, parse: (s: string) => number | null): number[] | null {
  // Comma/semicolon separated ("10, 25 m, 50"), or whitespace separated without units ("10 25 50").
  let parts = text.split(/[,;]/);
  if (parts.length === 1 && parse(text.trim()) === null) parts = text.trim().split(/\s+/);
  parts = parts.map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;
  const out: number[] = [];
  for (const s of parts) {
    const v = parse(s);
    if (v === null || !Number.isFinite(v) || v === 0) return null;
    out.push(v);
  }
  return out;
}

/**
 * Rings around one source (row 58): one live offset per distance on the same layer, sharing a ring
 * group id (`derived.ringGroup`, used by the legend to show them as one group), labelled with the
 * distance and coloured from a ramp (nearest ring strongest). Larger rings come first so smaller ones
 * draw on top.
 */
export function planRings(
  project: Project,
  src: AnalysisObject,
  p: RingParams,
): OffsetPlan & { group: string } {
  const { units, precision } = project.display;
  const group = newId('ring');
  const distances = [...new Set(p.distances)].sort((a, b) => a - b);
  // Nearest ring gets the strongest colour (end of the ramp).
  const colors = rampColors(p.ramp, distances.length).reverse();
  const warnings: string[] = [];
  const rings: NewObjectInput[] = [];
  distances.forEach((d, k) => {
    const der = { ...derivation(src.id, { ...p, distance: d, merge: false, live: true }), ringGroup: group };
    const res = computeOffset(src.geometry, der, project.chordTolerance);
    const label = formatOffset(d, units, precision);
    if (res.warning) warnings.push(`${label}: ${res.warning}`);
    if (!res.geometry) return;
    const style: StyleOverride = { stroke: colors[k], fill: colors[k], fillOpacity: 0.12, hatch: 'solid' };
    rings.push({
      kind: 'offset',
      geometry: res.geometry,
      name: `${src.name} ${label}`,
      derived: der,
      style,
      label: { template: '{offset}', placement: 'top', visible: true },
      attributes: { offset: label, source: src.name, ring: k + 1 },
    });
  });
  rings.reverse();
  return { inputs: rings, warnings, group };
}
