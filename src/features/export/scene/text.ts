import { layoutText, splitLines } from '@/export/fonts';
import type { FontSet } from '@/export/fonts';
import type { FontFamily } from '@/export/scene';

/**
 * Text measurement for sheet decorations (legend, title block). Uses the bundled fonts when
 * available (exact widths, identical in every backend); otherwise an average-advance estimate.
 */

const AVG_ADVANCE = 0.56;

export interface TextStyle {
  size: number;
  font?: FontFamily;
  bold?: boolean;
}

const cache = new Map<string, number>();

/** Width of the widest line in mm. */
export function textWidth(fonts: FontSet | undefined, text: string, st: TextStyle): number {
  if (!text) return 0;
  if (!fonts) {
    const longest = Math.max(...splitLines(text).map((l) => [...l].length));
    return longest * st.size * AVG_ADVANCE * (st.bold ? 1.06 : 1);
  }
  const key = `${st.font ?? 'sans'}|${st.bold ? 1 : 0}|${text}`;
  let w = cache.get(key);
  if (w === undefined) {
    w = layoutText(fonts, text, { size: 1, font: st.font, bold: st.bold }).width;
    if (cache.size > 5000) cache.clear();
    cache.set(key, w);
  }
  return w * st.size;
}

/** Greedy word wrap to `maxWidth` mm; long words are broken by characters. Keeps explicit newlines. */
export function wrapText(
  fonts: FontSet | undefined,
  text: string,
  st: TextStyle,
  maxWidth: number,
): string[] {
  const out: string[] = [];
  for (const para of splitLines(text)) {
    if (!para) {
      out.push('');
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w.length > 0);
    let line = '';
    for (const w of words) {
      const candidate = line + w;
      if (!line || textWidth(fonts, candidate.trimEnd(), st) <= maxWidth) {
        line = candidate;
        continue;
      }
      out.push(line.trimEnd());
      line = /^\s+$/.test(w) ? '' : w;
      // Break a single over-long word.
      while (line && textWidth(fonts, line, st) > maxWidth && [...line].length > 1) {
        const chars = [...line];
        let n = chars.length - 1;
        while (n > 1 && textWidth(fonts, chars.slice(0, n).join(''), st) > maxWidth) n--;
        out.push(chars.slice(0, n).join(''));
        line = chars.slice(n).join('');
      }
    }
    if (line.trim() || !out.length) out.push(line.trimEnd());
  }
  return out;
}

/** Truncates a single line with an ellipsis to fit `maxWidth`. */
export function fitLine(fonts: FontSet | undefined, text: string, st: TextStyle, maxWidth: number): string {
  if (textWidth(fonts, text, st) <= maxWidth) return text;
  const chars = [...text];
  let n = chars.length;
  while (n > 0 && textWidth(fonts, chars.slice(0, n).join('') + '…', st) > maxWidth) n--;
  return n > 0 ? chars.slice(0, n).join('') + '…' : '';
}
