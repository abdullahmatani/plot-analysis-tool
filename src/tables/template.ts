import { parseNumber } from './values';

/**
 * Label templates (rows 40, 70): `{field}`, `{field:0.0}` (fixed decimals), `{field:0}`; field
 * lookup is case-insensitive; missing fields render as ''. `{{` and `}}` are literal braces.
 */

export type TemplatePart = string | { field: string; key: string; decimals?: number };

const FORMAT_RE = /^0(?:\.(0+))?$/;
const cache = new Map<string, TemplatePart[]>();

/** Parses a template into literal and field parts (cached). */
export function parseTemplate(template: string): TemplatePart[] {
  const hit = cache.get(template);
  if (hit) return hit;
  const parts: TemplatePart[] = [];
  let lit = '';
  let i = 0;
  const n = template.length;
  while (i < n) {
    const ch = template[i];
    if (ch === '{' && template[i + 1] === '{') {
      lit += '{';
      i += 2;
      continue;
    }
    if (ch === '}' && template[i + 1] === '}') {
      lit += '}';
      i += 2;
      continue;
    }
    if (ch === '{') {
      const close = template.indexOf('}', i + 1);
      if (close < 0) {
        lit += template.slice(i);
        break;
      }
      const body = template.slice(i + 1, close);
      const colon = body.lastIndexOf(':');
      let field = body;
      let decimals: number | undefined;
      if (colon >= 0) {
        const m = FORMAT_RE.exec(body.slice(colon + 1).trim());
        if (m) {
          field = body.slice(0, colon);
          decimals = m[1] ? m[1].length : 0;
        }
      }
      field = field.trim();
      if (lit) parts.push(lit);
      lit = '';
      parts.push(
        decimals === undefined
          ? { field, key: field.toLowerCase() }
          : { field, key: field.toLowerCase(), decimals },
      );
      i = close + 1;
      continue;
    }
    lit += ch;
    i++;
  }
  if (lit) parts.push(lit);
  if (cache.size > 500) cache.clear();
  cache.set(template, parts);
  return parts;
}

/** Field names used by a template, in order of first use (as written). */
export function templateFields(template: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parseTemplate(template)) {
    if (typeof p === 'string' || seen.has(p.key)) continue;
    seen.add(p.key);
    out.push(p.field);
  }
  return out;
}

/**
 * Formats a value for a label: numbers with `decimals` fixed decimals when given, otherwise
 * rounded to `precision` decimals (default 6) without trailing zeros; numeric strings are
 * formatted like numbers when `decimals` is given.
 */
export function formatTemplateValue(v: unknown, decimals?: number, precision = 6): string {
  if (v === null || v === undefined) return '';
  let num: number | null = null;
  if (typeof v === 'number') num = v;
  else if (decimals !== undefined && typeof v === 'string') num = parseNumber(v);
  if (num !== null) {
    if (!Number.isFinite(num)) return '';
    if (decimals !== undefined) return num.toFixed(Math.min(20, decimals));
    const p = Math.max(0, Math.min(20, precision));
    const r = Number(num.toFixed(p));
    return String(Object.is(r, -0) ? 0 : r);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}

/** Renders `template` against `ctx` (keys matched case-insensitively). */
export function renderTemplate(
  template: string,
  ctx: Record<string, unknown>,
  opts: { precision?: number } = {},
): string {
  const parts = parseTemplate(template);
  let lower: Map<string, unknown> | null = null;
  let out = '';
  for (const p of parts) {
    if (typeof p === 'string') {
      out += p;
      continue;
    }
    let v: unknown;
    if (Object.prototype.hasOwnProperty.call(ctx, p.field)) v = ctx[p.field];
    else {
      if (!lower) {
        lower = new Map();
        for (const k of Object.keys(ctx)) if (!lower.has(k.toLowerCase())) lower.set(k.toLowerCase(), ctx[k]);
      }
      v = lower.get(p.key);
    }
    out += formatTemplateValue(v, p.decimals, opts.precision);
  }
  return out;
}
