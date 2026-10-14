import { toast } from 'sonner';

import type { AnalysisObject, OffsetDerivation } from '@/core/types';
import { formatLength } from '@/core/units';
import { commit, getProject } from '@/store/project';
import { useViewStore } from '@/store/view';
import { addObjects } from '@/features/objects/ops';

import { computeOffset, type DeriveReport } from './derive';
import { formatOffset, planOffsets, planRings, type OffsetParams, type RingParams } from './plan';

/** Offset commands (rows 55–61): each user action is one command. */

/**
 * TODO(calibration): replace the body with `return warnIfUncalibrated(actionName)` from
 * '@/features/calibration/guard' once that module is merged (row 32: offset tools warn when the
 * drawings are not calibrated). Resolve false to abort the action.
 */
export async function calibrationGuard(actionName: string): Promise<boolean> {
  void actionName;
  return true;
}

/** Selected objects that can be offset (any selectable object; hidden and locked layers cannot be selected). */
export function offsetSources(): AnalysisObject[] {
  const p = getProject();
  if (!p) return [];
  const sel = new Set(useViewStore.getState().selection);
  return p.objects.filter((o) => sel.has(o.id));
}

function warn(warnings: string[]) {
  if (!warnings.length) return;
  toast.warning(warnings.length === 1 ? warnings[0] : `${warnings.length} warnings`, {
    description: warnings.length > 1 ? warnings.slice(0, 5).join('\n') : undefined,
  });
}

export async function runOffset(params: OffsetParams): Promise<string[]> {
  const sources = offsetSources();
  if (!sources.length) {
    toast.error('Select the objects to offset first.');
    return [];
  }
  if (!(await calibrationGuard('Offset'))) return [];
  const p = getProject();
  if (!p) return [];
  const plan = planOffsets(p, sources, params);
  if (!plan.inputs.length) {
    toast.error(plan.warnings[0] ?? 'Nothing to offset.');
    return [];
  }
  const label =
    params.merge && plan.inputs.length < sources.length
      ? `Offset and merge ${sources.length} objects`
      : sources.length === 1
        ? `Offset ${formatOffset(params.distance, p.display.units, p.display.precision)}`
        : `Offset ${sources.length} objects`;
  const ids = addObjects(plan.inputs, label);
  if (ids.length) warn(plan.warnings);
  return ids;
}

export async function runRings(params: RingParams): Promise<string[]> {
  const sources = offsetSources();
  if (sources.length !== 1) {
    toast.error('Select exactly one object for a multi-ring offset.');
    return [];
  }
  if (!(await calibrationGuard('Multi-ring offset'))) return [];
  const p = getProject();
  if (!p) return [];
  const plan = planRings(p, sources[0], params);
  if (!plan.inputs.length) {
    toast.error(plan.warnings[0] ?? 'No rings to create.');
    return [];
  }
  const ids = addObjects(plan.inputs, `Multi-ring offset (${plan.inputs.length} rings)`);
  if (ids.length) warn(plan.warnings);
  return ids;
}

/** Detach: live offsets become static geometry. */
export function detachOffsets(ids: string[]): boolean {
  const set = new Set(ids);
  const p = getProject();
  const n = p?.objects.filter((o) => set.has(o.id) && o.derived).length ?? 0;
  if (!n) return false;
  return commit(n === 1 ? 'Detach offset' : `Detach ${n} offsets`, (d) => {
    for (const o of d.objects) if (set.has(o.id)) delete o.derived;
  });
}

/**
 * Changes the parameters of a live offset; the derivation recomputes its geometry in the same
 * command. A contraction that would remove the shape is rejected with a message (row 55).
 */
export function setOffsetParams(
  id: string,
  patch: Partial<Omit<OffsetDerivation, 'kind' | 'sourceId'>>,
): boolean {
  const p = getProject();
  const o = p?.objects.find((x) => x.id === id);
  const src = o?.derived ? p!.objects.find((x) => x.id === o.derived!.sourceId) : undefined;
  if (!p || !o?.derived || !src) return false;
  const next: OffsetDerivation = { ...o.derived, ...patch };
  if (!Number.isFinite(next.distance) || next.distance === 0) {
    toast.error('Enter a non-zero distance.');
    return false;
  }
  const res = computeOffset(src.geometry, next, p.chordTolerance);
  if (!res.geometry) {
    toast.error(res.warning ?? 'The offset would collapse.');
    return false;
  }
  const { units, precision } = p.display;
  const label = formatOffset(next.distance, units, precision);
  return commit(
    patch.distance !== undefined ? `Offset distance ${label}` : 'Offset parameters',
    (d) => {
      const x = d.objects.find((q) => q.id === id);
      if (!x?.derived) return;
      Object.assign(x.derived, patch);
      if (patch.join && patch.join !== 'miter') delete x.derived.miterLimit;
      if (patch.join === 'miter' && x.derived.miterLimit === undefined) x.derived.miterLimit = 2;
      if (patch.distance !== undefined && typeof x.attributes.offset === 'string')
        x.attributes.offset = label;
    },
    { coalesceKey: `offset-params-${id}` },
  );
}

export function setChordTolerance(m: number): boolean {
  const p = getProject();
  if (!p) return false;
  if (!(m > 0) || m > 1) {
    toast.error('Enter a chord tolerance between 0.01 mm and 1 m.');
    return false;
  }
  return commit(`Chord tolerance ${formatLength(m, 'mm', 2)}`, (d) => void (d.chordTolerance = m));
}

/** Toast after a commit whose derivation detached or collapsed offsets. */
export function reportDerivation(r: DeriveReport) {
  const p = getProject();
  const name = (id: string) => p?.objects.find((o) => o.id === id)?.name ?? 'Offset';
  if (r.collapsed.length)
    toast.warning(
      r.collapsed.length === 1
        ? `${name(r.collapsed[0].id)}: ${r.collapsed[0].message}`
        : `${r.collapsed.length} live offsets collapse`,
      { description: 'They stay linked and reappear when the source grows again.' },
    );
  const edited = r.detached.filter((x) => x.reason === 'edited');
  const orphaned = r.detached.filter((x) => x.reason !== 'edited');
  if (edited.length)
    toast.info(
      edited.length === 1
        ? `${name(edited[0].id)} was edited directly and is now a static shape`
        : `${edited.length} offsets were edited directly and are now static shapes`,
    );
  if (orphaned.length)
    toast.info(
      orphaned.length === 1
        ? `${name(orphaned[0].id)} lost its source and is now a static shape`
        : `${orphaned.length} offsets lost their source and are now static shapes`,
    );
}
