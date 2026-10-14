/**
 * Small formatting helpers shared by the export backends (PDF, SVG, DXF). Pure functions with no
 * DOM dependencies so they run on the main thread and in Web Workers.
 */

/**
 * Formats a number with at most `decimals` fractional digits, without trailing zeros and never in
 * exponent notation (PDF and SVG path data must not contain exponents in every consumer).
 */
export function fmt(n: number, decimals = 6): string {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return n === 0 ? '0' : String(n);
  const k = 10 ** decimals;
  const r = Math.round(n * k) / k;
  if (r === 0) return '0';
  const s = String(r);
  if (!s.includes('e')) return s;
  // Only reachable for |n| >= 1e21 (or extreme decimals): fall back to toFixed, clamped.
  const clamped = Math.max(-1e20, Math.min(1e20, r));
  return clamped.toFixed(Math.min(decimals, 20)).replace(/\.?0+$/, '');
}

export interface Rgba {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

/** Parses `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. Anything else yields opaque black. */
export function parseColor(color: string | undefined): Rgba {
  if (!color) return { r: 0, g: 0, b: 0, a: 1 };
  const s = color.trim();
  const m = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (!m) return { r: 0, g: 0, b: 0, a: 1 };
  let hex = m[1];
  if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join('');
  if (hex.length !== 6 && hex.length !== 8) return { r: 0, g: 0, b: 0, a: 1 };
  const v = (i: number) => parseInt(hex.slice(i, i + 2), 16);
  return { r: v(0), g: v(2), b: v(4), a: hex.length === 8 ? v(6) / 255 : 1 };
}

/** Normalised `#rrggbb` (alpha dropped). */
export function hexColor(c: Rgba): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/** Clamps an opacity to [0, 1]; undefined → 1. */
export function opacityOf(...values: (number | undefined)[]): number {
  let o = 1;
  for (const v of values) if (v !== undefined && Number.isFinite(v)) o *= Math.max(0, Math.min(1, v));
  return o;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 (RFC 4648) without relying on `btoa` or `Buffer`. */
export function base64Encode(bytes: Uint8Array): string {
  const parts: string[] = [];
  const CHUNK = 3 * 4096;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    let s = '';
    let i = start;
    for (; i + 2 < end; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < end) {
      const rem = end - i;
      const n = (bytes[i] << 16) | (rem > 1 ? bytes[i + 1] << 8 : 0);
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (rem > 1 ? B64[(n >> 6) & 63] : '=') + '=';
    }
    parts.push(s);
  }
  return parts.join('');
}

/** Escapes text for XML character data and attribute values; drops characters XML 1.0 forbids. */
export function xmlEscape(s: string): string {
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&apos;';
    else if (cp === 0x9 || cp === 0xa || cp === 0xd) out += `&#${cp};`;
    else if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) continue;
    else out += ch;
  }
  return out;
}
