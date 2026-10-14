import { DEFAULT_STYLE } from '@/core/project';
import type {
  AnalysisLayer,
  AnalysisObject,
  ContourDataset,
  DashStyle,
  HatchPattern,
  LegendEntryOverride,
  Project,
  Style,
} from '@/core/types';
import { formatLength } from '@/core/units';
import { isClosed } from '@/geometry/convert';
import type { ContourItem } from '@/tables/contours';
import { sizeStyleFor } from '@/tables/access';
import { legendEntriesForRule } from '@/tables/style-rules';

/**
 * Legend builder (row 75). Entries are generated from what is drawn: visible analysis layers (plus
 * per-object styles that differ visibly from their layer), multi-ring offset groups, and contour
 * datasets (size columns, style-rule categories/classes actually used after filtering, envelopes).
 * User edits live in `Project.legend.overrides` keyed by stable entry keys: title, group, order and
 * hide/show. Pure (runs in the export worker as well as in the Legend panel).
 */

export interface LegendSwatch {
  /** 'area' = filled box, 'ring' = outlined box (contours), 'line' = stroke only, 'point' = marker. */
  shape: 'area' | 'ring' | 'line' | 'point';
  stroke?: { color: string; width: number; opacity: number; dash: DashStyle };
  fill?: { color: string; opacity: number; hatch: HatchPattern };
}

export type LegendSource = 'layer' | 'style' | 'ring' | 'size' | 'rule' | 'envelope';

export interface LegendItem {
  key: string;
  title: string;
  defaultTitle: string;
  group: string;
  defaultGroup: string;
  hidden: boolean;
  /** Hidden by default (e.g. a layer with "show in legend" off) before overrides. */
  defaultHidden: boolean;
  order: number;
  source: LegendSource;
  swatch: LegendSwatch;
  /** Number of drawn items the entry explains. */
  count: number;
}

export interface LegendGroup {
  title: string;
  items: LegendItem[];
}

export interface LegendModel {
  title: string;
  /** Every entry (hidden ones included), in legend order. */
  items: LegendItem[];
  /** Visible entries grouped, in legend order. */
  groups: LegendGroup[];
}

export interface LegendContourInput {
  datasetId: string;
  items: Pick<ContourItem, 'legendKey' | 'sizeColumn'>[];
  envelopes: { sizeColumn: string; label: string; color: string; dash: DashStyle; strokeWidth: number }[];
}

export interface LegendBuildOptions {
  /** Contour items per dataset as drawn (filters applied). */
  contours?: LegendContourInput[];
  /** Restrict to objects that are drawn (e.g. inside the exported window). */
  objectFilter?: (o: AnalysisObject) => boolean;
}

/** Visual fields of a style that a legend swatch shows. */
const VISUAL_KEYS = [
  'stroke',
  'strokeWidth',
  'strokeOpacity',
  'dash',
  'fill',
  'fillOpacity',
  'hatch',
] as const satisfies readonly (keyof Style)[];

function resolved(layer: AnalysisLayer | undefined, o?: AnalysisObject): Style {
  return { ...DEFAULT_STYLE, ...(layer?.style ?? {}), ...(o?.style ?? {}) };
}

function signature(s: Style): string {
  return VISUAL_KEYS.map((k) => {
    const v = s[k];
    return typeof v === 'string' ? v.toLowerCase() : String(v);
  }).join('|');
}

/** Short stable hash (FNV-1a, base 36) for entry keys. */
export function hashKey(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
  return h.toString(36);
}

function swatchOf(s: Style, shape: LegendSwatch['shape']): LegendSwatch {
  const sw: LegendSwatch = { shape };
  if (s.strokeOpacity > 0 && s.strokeWidth > 0)
    sw.stroke = { color: s.stroke, width: s.strokeWidth, opacity: s.strokeOpacity, dash: s.dash };
  if (shape === 'area' && s.hatch !== 'none' && s.fillOpacity > 0)
    sw.fill = { color: s.fill, opacity: s.fillOpacity, hatch: s.hatch };
  return sw;
}

/** Objects that do not carry a styled shape of their own (free text and callouts are labels). */
function isStyledObject(o: AnalysisObject): boolean {
  return o.kind !== 'text' && o.kind !== 'callout';
}

function shapeOf(objs: readonly AnalysisObject[]): LegendSwatch['shape'] {
  if (objs.some((o) => isClosed(o.geometry))) return 'area';
  if (objs.every((o) => o.geometry.type === 'point')) return 'point';
  return 'line';
}

interface Draft {
  key: string;
  title: string;
  group: string;
  source: LegendSource;
  swatch: LegendSwatch;
  count: number;
  hidden: boolean;
}

/** Legend key of the entry that explains an object (layer, style variant or ring entry). */
export function objectLegendKeys(project: Project): Map<string, string> {
  const out = new Map<string, string>();
  for (const layer of project.layers) {
    const base = signature(resolved(layer));
    for (const o of project.objects) {
      if (o.layerId !== layer.id || !isStyledObject(o)) continue;
      if (o.derived?.ringGroup) out.set(o.id, ringKey(o.derived.ringGroup, o.derived.distance));
      else {
        const sig = signature(resolved(layer, o));
        out.set(o.id, sig === base ? `layer:${layer.id}` : `style:${layer.id}:${hashKey(sig)}`);
      }
    }
  }
  return out;
}

function ringKey(group: string, distance: number): string {
  return `ring:${group}:${Number(distance.toPrecision(12))}`;
}

function analysisDrafts(project: Project, opts: LegendBuildOptions): Draft[] {
  const out: Draft[] = [];
  const { units, precision } = project.display;
  // Legend lists layers top-most first, like the Layers panel.
  for (const layer of [...project.layers].reverse()) {
    if (!layer.visible) continue;
    const objs = project.objects.filter(
      (o) => o.layerId === layer.id && isStyledObject(o) && (!opts.objectFilter || opts.objectFilter(o)),
    );
    if (!objs.length) continue;
    const group = layer.legend.group?.trim() || 'Analysis';
    const layerHidden = layer.legend.show === false;
    const layerStyle = resolved(layer);
    const base = signature(layerStyle);
    const plain: AnalysisObject[] = [];
    const variants = new Map<string, AnalysisObject[]>();
    const rings = new Map<string, AnalysisObject[]>();
    for (const o of objs) {
      const rg = o.derived?.ringGroup;
      if (rg) {
        const list = rings.get(rg) ?? [];
        list.push(o);
        rings.set(rg, list);
        continue;
      }
      const sig = signature(resolved(layer, o));
      if (sig === base) plain.push(o);
      else {
        const list = variants.get(sig) ?? [];
        list.push(o);
        variants.set(sig, list);
      }
    }
    if (plain.length) {
      out.push({
        key: `layer:${layer.id}`,
        title: layer.legend.label?.trim() || layer.name,
        group,
        source: 'layer',
        swatch: swatchOf(layerStyle, shapeOf(plain)),
        count: plain.length,
        hidden: layerHidden,
      });
    }
    let n = 0;
    for (const [sig, list] of variants) {
      n++;
      const cats = new Set(list.map((o) => o.category?.trim() ?? ''));
      const cat = cats.size === 1 ? [...cats][0] : '';
      const title =
        cat || (list.length === 1 ? list[0].name : `${layer.legend.label?.trim() || layer.name} (${n})`);
      out.push({
        key: `style:${layer.id}:${hashKey(sig)}`,
        title,
        group,
        source: 'style',
        swatch: swatchOf(resolved(layer, list[0]), shapeOf(list)),
        count: list.length,
        hidden: layerHidden,
      });
    }
    for (const [rg, list] of rings) {
      const src = project.objects.find((o) => o.id === list[0].derived?.sourceId);
      const ringGroup = `Offset rings${src ? ` – ${src.name}` : ''}`;
      const sorted = [...list].sort((a, b) => (a.derived?.distance ?? 0) - (b.derived?.distance ?? 0));
      const seen = new Set<string>();
      for (const o of sorted) {
        const d = o.derived?.distance ?? 0;
        const key = ringKey(rg, d);
        if (seen.has(key)) continue;
        seen.add(key);
        const same = sorted.filter((x) => ringKey(rg, x.derived?.distance ?? 0) === key);
        out.push({
          key,
          title: `${d > 0 ? '+' : ''}${formatLength(d, units, precision)}`,
          group: ringGroup,
          source: 'ring',
          swatch: swatchOf(resolved(layer, o), shapeOf([o])),
          count: same.length,
          hidden: layerHidden,
        });
      }
    }
  }
  return out;
}

const NEUTRAL = '#6b7280';

function datasetDrafts(ds: ContourDataset, input: LegendContourInput | undefined): Draft[] {
  const out: Draft[] = [];
  const group = ds.legendGroup?.trim() || ds.name;
  const items = input?.items ?? [];
  const used = new Map<string, number>();
  for (const it of items) if (it.legendKey) used.set(it.legendKey, (used.get(it.legendKey) ?? 0) + 1);
  const sizes = ds.mapping.sizeColumns
    .map((c, i) => sizeStyleFor(ds, c, i))
    .filter((s) => s.visible && items.some((it) => it.sizeColumn === s.column));
  const first = sizes[0];
  const hasRules = ds.styleRules.length > 0;
  for (const rule of ds.styleRules) {
    for (const e of legendEntriesForRule(rule)) {
      const count = used.get(e.key) ?? 0;
      if (!count) continue;
      out.push({
        key: `ds:${ds.id}:${e.key}`,
        title: e.label,
        group,
        source: 'rule',
        swatch: {
          shape: 'ring',
          stroke: {
            color: e.color,
            width: first?.strokeWidth ?? 0.35,
            opacity: 1,
            dash: rule.dash ?? first?.dash ?? 'solid',
          },
          fill: { color: e.color, opacity: rule.fillOpacity ?? first?.fillOpacity ?? 0.1, hatch: 'solid' },
        },
        count,
        hidden: false,
      });
    }
  }
  if (!hasRules || sizes.length > 1) {
    for (const s of sizes) {
      const color = hasRules ? NEUTRAL : s.color;
      out.push({
        key: `ds:${ds.id}:size:${s.column}`,
        title: s.legendLabel?.trim() || s.column,
        group,
        source: 'size',
        swatch: {
          shape: 'ring',
          stroke: { color, width: s.strokeWidth, opacity: 1, dash: s.dash },
          fill: { color, opacity: hasRules ? 0 : s.fillOpacity, hatch: 'solid' },
        },
        count: items.filter((it) => it.sizeColumn === s.column).length,
        hidden: false,
      });
    }
  }
  for (const env of input?.envelopes ?? []) {
    out.push({
      key: `ds:${ds.id}:envelope:${env.sizeColumn}`,
      title: `Envelope – ${env.label}`,
      group,
      source: 'envelope',
      swatch: {
        shape: 'line',
        stroke: { color: env.color, width: env.strokeWidth, opacity: 1, dash: env.dash },
      },
      count: 1,
      hidden: false,
    });
  }
  return out;
}

/** Applies overrides and ordering. */
function finish(title: string, drafts: Draft[], overrides: readonly LegendEntryOverride[]): LegendModel {
  const ov = new Map(overrides.map((o) => [o.key, o]));
  const items: LegendItem[] = drafts.map((d, i) => {
    const o = ov.get(d.key);
    return {
      key: d.key,
      title: o?.title?.trim() ? o.title : d.title,
      defaultTitle: d.title,
      group: o?.group !== undefined && o.group.trim() !== '' ? o.group : d.group,
      defaultGroup: d.group,
      hidden: o?.hidden ?? d.hidden,
      defaultHidden: d.hidden,
      order: o?.order ?? i,
      source: d.source,
      swatch: d.swatch,
      count: d.count,
    };
  });
  // Stable sort: explicit orders first by value; ties keep build order.
  const indexed = items.map((it, i) => ({ it, i }));
  indexed.sort((a, b) => a.it.order - b.it.order || a.i - b.i);
  const sorted = indexed.map((x) => x.it);
  const groups: LegendGroup[] = [];
  const byTitle = new Map<string, LegendGroup>();
  for (const it of sorted) {
    if (it.hidden) continue;
    let g = byTitle.get(it.group);
    if (!g) {
      g = { title: it.group, items: [] };
      byTitle.set(it.group, g);
      groups.push(g);
    }
    g.items.push(it);
  }
  return { title, items: sorted, groups };
}

/** Builds the legend for a project (see module notes). */
export function buildLegend(project: Project, opts: LegendBuildOptions = {}): LegendModel {
  const drafts = analysisDrafts(project, opts);
  const byId = new Map((opts.contours ?? []).map((c) => [c.datasetId, c]));
  const datasets = [...project.datasets].filter((d) => d.visible).sort((a, b) => a.order - b.order);
  for (const ds of datasets) drafts.push(...datasetDrafts(ds, byId.get(ds.id)));
  return finish(project.legend.title, drafts, project.legend.overrides);
}

/**
 * Order overrides that move `key` by `delta` positions in the full legend order (the whole order is
 * written explicitly so the result is unambiguous).
 */
export function reorderOverrides(model: LegendModel, key: string, delta: number): Map<string, number> {
  const keys = model.items.map((i) => i.key);
  const from = keys.indexOf(key);
  const out = new Map<string, number>();
  if (from < 0) return out;
  const to = Math.max(0, Math.min(keys.length - 1, from + delta));
  keys.splice(to, 0, ...keys.splice(from, 1));
  keys.forEach((k, i) => out.set(k, i));
  return out;
}
