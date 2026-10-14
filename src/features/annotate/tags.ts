import { toast } from 'sonner';

import type { AnalysisObject, Geometry, Project } from '@/core/types';
import { activeLayerWritable, makeObject } from '@/features/objects/ops';
import { commit, getProject } from '@/store/project';
import { useViewStore } from '@/store/view';

/** Auto-numbered bubble tags: a sequence per layer, with renumbering (row 41). */

export function nextTagNumber(p: Project, layerId: string): number {
  const layer = p.layers.find((l) => l.id === layerId);
  const max = p.objects.reduce(
    (m, o) => (o.kind === 'tag' && o.layerId === layerId ? Math.max(m, o.tagNumber ?? 0) : m),
    0,
  );
  return Math.max(layer?.nextTag ?? 1, max + 1);
}

export function addTag(geometry: Geometry): string | null {
  const p = getProject();
  if (!p || !activeLayerWritable()) return null;
  const layerId = p.activeLayerId;
  const n = nextTagNumber(p, layerId);
  const o = makeObject(p, { kind: 'tag', geometry, tagNumber: n, name: `Tag ${n}` });
  const ok = commit(`Place tag ${n}`, (d) => {
    d.objects.push(o);
    const l = d.layers.find((x) => x.id === layerId);
    if (l) l.nextTag = n + 1;
  });
  if (!ok) return null;
  useViewStore.getState().set({ selection: [o.id] });
  return o.id;
}

/** Renumbers the tags of a layer 1…n in their current order; one undo step. */
export function renumberTags(layerId: string): number {
  const p = getProject();
  if (!p) return 0;
  const tags = p.objects
    .filter((o) => o.kind === 'tag' && o.layerId === layerId)
    .sort((a, b) => (a.tagNumber ?? 0) - (b.tagNumber ?? 0));
  const order = new Map(tags.map((t, i) => [t.id, i + 1]));
  const changed = tags.some((t, i) => t.tagNumber !== i + 1);
  const layer = p.layers.find((l) => l.id === layerId);
  if (!changed && layer?.nextTag === tags.length + 1) return 0;
  commit(`Renumber tags on “${layer?.name ?? 'layer'}”`, (d) => {
    for (const o of d.objects) {
      const n = order.get(o.id);
      if (n === undefined) continue;
      if (o.name === `Tag ${o.tagNumber}`) o.name = `Tag ${n}`;
      o.tagNumber = n;
    }
    const l = d.layers.find((x) => x.id === layerId);
    if (l) l.nextTag = tags.length + 1;
  });
  return tags.length;
}

/** After tags are deleted, offer to close the gap in the sequence. */
export function offerRenumber(deleted: AnalysisObject[]) {
  const layers = [...new Set(deleted.filter((o) => o.kind === 'tag').map((o) => o.layerId))];
  if (!layers.length) return;
  const p = getProject();
  if (!p) return;
  for (const layerId of layers) {
    const sorted = p.objects
      .filter((o) => o.kind === 'tag' && o.layerId === layerId)
      .sort((a, b) => (a.tagNumber ?? 0) - (b.tagNumber ?? 0));
    const gap = sorted.some((t, i) => t.tagNumber !== i + 1);
    if (!gap) continue;
    const name = p.layers.find((l) => l.id === layerId)?.name ?? 'layer';
    toast(`Tag deleted from “${name}”`, {
      description: 'Renumber the remaining tags so the sequence has no gaps?',
      duration: 12000,
      action: { label: 'Renumber', onClick: () => renumberTags(layerId) },
    });
  }
}
