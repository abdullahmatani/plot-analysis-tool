import { newId, nowIso } from '@/core/ids';
import type { ContourDataset, ContourLabelStyle, SizeColumnStyle, StyleRule } from '@/core/types';
import { getSetting, setSetting } from '@/persistence/settings';
import { findColumn } from '@/tables/access';
import { mappingErrors, type Mapping } from '@/tables/suggest';
import { normaliseKey } from '@/tables/values';

import { resolveMappingColumns } from './ops';

/**
 * Mapping templates (row 73): column mapping, size-column styles, style rules and label template saved
 * once and reused across projects (stored in the app settings store, not in a project). A template is
 * suggested when the imported table has every column the template maps; it applies in one click.
 */

export interface MappingTemplate {
  id: string;
  name: string;
  /** Headers of the table the template was made from. */
  headers: string[];
  mapping: Mapping;
  sizeStyles: SizeColumnStyle[];
  styleRules: StyleRule[];
  labelTemplate: string;
  labelPlacement: ContourDataset['labelPlacement'];
  labelStyle?: ContourLabelStyle;
  createdAt: string;
}

export const TEMPLATES_KEY = 'contours.templates';

export async function listTemplates(): Promise<MappingTemplate[]> {
  const list = await getSetting<MappingTemplate[]>(TEMPLATES_KEY, []);
  return Array.isArray(list) ? list : [];
}

export async function saveTemplate(t: MappingTemplate): Promise<void> {
  const list = (await listTemplates()).filter((x) => x.id !== t.id && x.name !== t.name);
  await setSetting(TEMPLATES_KEY, [...list, t]);
}

export async function deleteTemplate(id: string): Promise<void> {
  await setSetting(
    TEMPLATES_KEY,
    (await listTemplates()).filter((x) => x.id !== id),
  );
}

export interface TemplateSource {
  mapping: Mapping;
  sizeStyles: SizeColumnStyle[];
  styleRules: StyleRule[];
  labelTemplate: string;
  labelPlacement: ContourDataset['labelPlacement'];
  labelStyle?: ContourLabelStyle;
}

export function makeTemplate(name: string, headers: string[], src: TemplateSource): MappingTemplate {
  return {
    id: newId('tpl'),
    name,
    headers: [...headers],
    mapping: structuredClone(src.mapping),
    sizeStyles: structuredClone(src.sizeStyles),
    styleRules: structuredClone(src.styleRules),
    labelTemplate: src.labelTemplate,
    labelPlacement: src.labelPlacement,
    ...(src.labelStyle ? { labelStyle: { ...src.labelStyle } } : {}),
    createdAt: nowIso(),
  };
}

export interface TemplateMatch {
  template: MappingTemplate;
  /** Every header of the template is in the table and vice versa (case/space-insensitive). */
  exact: boolean;
  /** Share of matching headers (Jaccard). */
  score: number;
}

/**
 * Templates applicable to a table: every column the template maps must exist in the table (so the
 * mapping is complete). Best first: exact header matches, then by header overlap.
 */
export function matchTemplates(templates: MappingTemplate[], columns: string[]): TemplateMatch[] {
  const cols = new Set(columns.map(normaliseKey));
  const out: TemplateMatch[] = [];
  for (const t of templates) {
    const mapped = resolveMappingColumns(t.mapping, columns);
    if (mappingErrors(mapped, columns).length > 0) continue;
    const heads = new Set(t.headers.map(normaliseKey));
    let common = 0;
    for (const h of heads) if (cols.has(h)) common++;
    const union = heads.size + cols.size - common;
    const score = union === 0 ? 0 : common / union;
    out.push({ template: t, exact: common === heads.size && common === cols.size, score });
  }
  return out.sort((a, b) => Number(b.exact) - Number(a.exact) || b.score - a.score);
}

/** The template's settings with column names resolved against the table's columns. */
export function applyTemplate(t: MappingTemplate, columns: string[]): TemplateSource {
  const fix = (c: string) => {
    const i = findColumn(columns, c);
    return i >= 0 ? columns[i] : c;
  };
  return {
    mapping: resolveMappingColumns(t.mapping, columns),
    sizeStyles: t.sizeStyles.map((s) => ({ ...s, column: fix(s.column) })),
    styleRules: t.styleRules.map((r) => ({
      ...structuredClone(r),
      id: newId('rule'),
      column: fix(r.column),
    })),
    labelTemplate: t.labelTemplate,
    labelPlacement: t.labelPlacement,
    ...(t.labelStyle ? { labelStyle: { ...t.labelStyle } } : {}),
  };
}
