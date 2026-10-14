/**
 * CAD text font substitution (row 24). Drawings name SHX or TrueType fonts that are not available
 * offline; text is drawn with the bundled open-licence fonts instead (Noto Sans as "PAT CAD Sans",
 * Noto Sans Arabic for Arabic) and is never downloaded. Each rule adjusts the glyph width so
 * substituted text keeps roughly its original extent and alignment (SHX stick fonts are narrower
 * than Noto Sans). The table is shown in Help → CAD fonts.
 */

export type FontKind = 'sans' | 'serif' | 'mono' | 'symbol';

export interface FontRule {
  /** Matched against the font file name without directory and extension, case-insensitive. */
  match: RegExp;
  examples: string;
  kind: FontKind;
  /** Multiplies the text's width factor. */
  widthScale: number;
  note?: string;
}

export const CAD_SANS = '"PAT CAD Sans", "Noto Sans", "Noto Sans Arabic", sans-serif';
const CAD_MONO = 'ui-monospace, "PAT CAD Sans", "Noto Sans Arabic", monospace';

export const FONT_RULES: FontRule[] = [
  { match: /^txt$/, examples: 'txt.shx', kind: 'sans', widthScale: 0.85, note: 'AutoCAD default stick font' },
  {
    match: /^(simplex|romans|romand|romanc|romant|isocp\d*|isoct\d*|isocteur|isocpeur|iso3098b?|iso)$/,
    examples: 'simplex.shx, romans.shx, isocp.shx, isocpeur.ttf',
    kind: 'sans',
    widthScale: 0.9,
  },
  { match: /^monotxt\d*$/, examples: 'monotxt.shx', kind: 'mono', widthScale: 1 },
  {
    match: /^(complex|italic[ct]?|scriptc|scripts|gothic[egi]?|greek[cs]|cyril[ct]?)$/,
    examples: 'complex.shx, italic.shx, gothice.shx',
    kind: 'serif',
    widthScale: 0.92,
    note: 'drawn with the sans fallback',
  },
  {
    match:
      /^(arial\w*|helvetica\w*|swiss\w*|calibri\w*|tahoma\w*|verdana\w*|segoe\w*|noto\s?sans\w*|dejavu\s?sans\w*|liberation\s?sans\w*)$/,
    examples: 'arial.ttf, Swiss 721, Calibri, Tahoma',
    kind: 'sans',
    widthScale: 1,
  },
  {
    match: /^(times\w*|georgia\w*|garamond\w*|cambria\w*|book\s?antiqua\w*|romantic\w*|dutch\w*)$/,
    examples: 'times.ttf, Georgia, Dutch 801',
    kind: 'serif',
    widthScale: 0.95,
    note: 'drawn with the sans fallback',
  },
  {
    match: /^(cour\w*|consola\w*|lucida\s?console\w*|monospac\w*)$/,
    examples: 'cour.ttf, Consolas',
    kind: 'mono',
    widthScale: 1,
  },
  {
    match: /^(gdt|amgdt\w*|symap|symath|symeteo|symusic|syastro|wingding\w*|webding\w*|symbol)$/,
    examples: 'gdt.shx, amgdt.shx, symath.shx',
    kind: 'symbol',
    widthScale: 1,
    note: 'symbol fonts: special glyphs may show as their character codes',
  },
  {
    match:
      /^(arabic\w*|trado\w*|simpo\w*|andlso|arabtype|majalla\w*|tradbdo|traditional\s?arabic|simplified\s?arabic)$/,
    examples: 'Traditional Arabic, Simplified Arabic, arabtype.ttf',
    kind: 'sans',
    widthScale: 1,
    note: 'Noto Sans Arabic (shaped, right-to-left)',
  },
];

const DEFAULT_RULE: FontRule = {
  match: /.*/,
  examples: 'any other font',
  kind: 'sans',
  widthScale: 0.92,
  note: 'unknown fonts use the sans fallback',
};

export interface FontSubstitute {
  font: string;
  css: string;
  kind: FontKind;
  widthScale: number;
  rule: FontRule;
}

const cache = new Map<string, FontSubstitute>();

/** The bundled font and width compensation used for a CAD font file name. */
export function substituteFont(font: string | undefined): FontSubstitute {
  const name = (font ?? '').trim();
  const hit = cache.get(name);
  if (hit) return hit;
  const base = name
    .replace(/^.*[\\/]/, '')
    .replace(/\.(shx|ttf|ttc|otf|fon)$/i, '')
    .trim()
    .toLowerCase();
  const rule = (base && FONT_RULES.find((r) => r.match.test(base))) || DEFAULT_RULE;
  const sub: FontSubstitute = {
    font: name || '(default)',
    css: rule.kind === 'mono' ? CAD_MONO : CAD_SANS,
    kind: rule.kind,
    widthScale: rule.widthScale,
    rule,
  };
  cache.set(name, sub);
  return sub;
}

export const DEFAULT_FONT_RULE = DEFAULT_RULE;
