/**
 * Minimal Unicode Bidirectional Algorithm (UAX #9, simplified) for single-paragraph labels:
 *
 * - paragraph level from the first strong character (P2/P3) unless forced;
 * - weak-type rules W1–W7 (NSM, European/Arabic numbers and their separators/terminators);
 * - neutral rules N1/N2, implicit levels I1/I2, trailing-whitespace rule L1 and reordering L2.
 *
 * Explicit embeddings/isolates (LRE, RLI …) are ignored (treated as boundary-neutral). Character
 * classes come from a compact range table covering Latin, Hebrew, Arabic (incl. presentation forms),
 * Syriac/Thaana/NKo, common punctuation and number forms; other code points default to L.
 */

export type BidiClass =
  'L' | 'R' | 'AL' | 'EN' | 'ES' | 'ET' | 'AN' | 'CS' | 'NSM' | 'BN' | 'B' | 'S' | 'WS' | 'ON';

type Range = readonly [number, number, BidiClass];

// Sorted, non-overlapping ranges. Anything not listed is 'L'.
const RANGES: readonly Range[] = [
  [0x0000, 0x0008, 'BN'],
  [0x0009, 0x0009, 'S'],
  [0x000a, 0x000a, 'B'],
  [0x000b, 0x000b, 'S'],
  [0x000c, 0x000c, 'WS'],
  [0x000d, 0x000d, 'B'],
  [0x000e, 0x001b, 'BN'],
  [0x001c, 0x001e, 'B'],
  [0x001f, 0x001f, 'S'],
  [0x0020, 0x0020, 'WS'],
  [0x0021, 0x0022, 'ON'],
  [0x0023, 0x0025, 'ET'],
  [0x0026, 0x002a, 'ON'],
  [0x002b, 0x002b, 'ES'],
  [0x002c, 0x002c, 'CS'],
  [0x002d, 0x002d, 'ES'],
  [0x002e, 0x002f, 'CS'],
  [0x0030, 0x0039, 'EN'],
  [0x003a, 0x003a, 'CS'],
  [0x003b, 0x0040, 'ON'],
  [0x005b, 0x0060, 'ON'],
  [0x007b, 0x007e, 'ON'],
  [0x007f, 0x0084, 'BN'],
  [0x0085, 0x0085, 'B'],
  [0x0086, 0x009f, 'BN'],
  [0x00a0, 0x00a0, 'CS'],
  [0x00a1, 0x00a1, 'ON'],
  [0x00a2, 0x00a5, 'ET'],
  [0x00a6, 0x00a9, 'ON'],
  [0x00ab, 0x00ac, 'ON'],
  [0x00ad, 0x00ad, 'BN'],
  [0x00ae, 0x00af, 'ON'],
  [0x00b0, 0x00b1, 'ET'],
  [0x00b2, 0x00b3, 'EN'],
  [0x00b4, 0x00b4, 'ON'],
  [0x00b6, 0x00b8, 'ON'],
  [0x00b9, 0x00b9, 'EN'],
  [0x00bb, 0x00bf, 'ON'],
  [0x00d7, 0x00d7, 'ON'],
  [0x00f7, 0x00f7, 'ON'],
  [0x02b9, 0x02ba, 'ON'],
  [0x02c2, 0x02cf, 'ON'],
  [0x02d2, 0x02df, 'ON'],
  [0x02e5, 0x02ed, 'ON'],
  [0x02ef, 0x02ff, 'ON'],
  [0x0300, 0x036f, 'NSM'],
  [0x0374, 0x0375, 'ON'],
  [0x037e, 0x037e, 'ON'],
  [0x0384, 0x0385, 'ON'],
  [0x0387, 0x0387, 'ON'],
  [0x0483, 0x0489, 'NSM'],
  [0x058a, 0x058a, 'ON'],
  [0x058d, 0x058e, 'ON'],
  [0x058f, 0x058f, 'ET'],
  [0x0590, 0x0590, 'R'],
  [0x0591, 0x05bd, 'NSM'],
  [0x05be, 0x05be, 'R'],
  [0x05bf, 0x05bf, 'NSM'],
  [0x05c0, 0x05c0, 'R'],
  [0x05c1, 0x05c2, 'NSM'],
  [0x05c3, 0x05c3, 'R'],
  [0x05c4, 0x05c5, 'NSM'],
  [0x05c6, 0x05c6, 'R'],
  [0x05c7, 0x05c7, 'NSM'],
  [0x05c8, 0x05ff, 'R'],
  [0x0600, 0x0605, 'AN'],
  [0x0606, 0x0607, 'ON'],
  [0x0608, 0x0608, 'AL'],
  [0x0609, 0x060a, 'ET'],
  [0x060b, 0x060b, 'AL'],
  [0x060c, 0x060c, 'CS'],
  [0x060d, 0x060d, 'AL'],
  [0x060e, 0x060f, 'ON'],
  [0x0610, 0x061a, 'NSM'],
  [0x061b, 0x064a, 'AL'],
  [0x064b, 0x065f, 'NSM'],
  [0x0660, 0x0669, 'AN'],
  [0x066a, 0x066a, 'ET'],
  [0x066b, 0x066c, 'AN'],
  [0x066d, 0x066f, 'AL'],
  [0x0670, 0x0670, 'NSM'],
  [0x0671, 0x06d5, 'AL'],
  [0x06d6, 0x06dc, 'NSM'],
  [0x06dd, 0x06dd, 'AN'],
  [0x06de, 0x06de, 'ON'],
  [0x06df, 0x06e4, 'NSM'],
  [0x06e5, 0x06e6, 'AL'],
  [0x06e7, 0x06e8, 'NSM'],
  [0x06e9, 0x06e9, 'ON'],
  [0x06ea, 0x06ed, 'NSM'],
  [0x06ee, 0x06ef, 'AL'],
  [0x06f0, 0x06f9, 'EN'],
  [0x06fa, 0x0710, 'AL'],
  [0x0711, 0x0711, 'NSM'],
  [0x0712, 0x072f, 'AL'],
  [0x0730, 0x074a, 'NSM'],
  [0x074b, 0x07a5, 'AL'],
  [0x07a6, 0x07b0, 'NSM'],
  [0x07b1, 0x07bf, 'AL'],
  [0x07c0, 0x07ea, 'R'],
  [0x07eb, 0x07f3, 'NSM'],
  [0x07f4, 0x07f5, 'R'],
  [0x07f6, 0x07f9, 'ON'],
  [0x07fa, 0x0815, 'R'],
  [0x0816, 0x082d, 'NSM'],
  [0x082e, 0x0858, 'R'],
  [0x0859, 0x085b, 'NSM'],
  [0x085c, 0x085f, 'R'],
  [0x0860, 0x08c9, 'AL'],
  [0x08ca, 0x08e1, 'NSM'],
  [0x08e2, 0x08e2, 'AN'],
  [0x08e3, 0x0902, 'NSM'],
  [0x093a, 0x093a, 'NSM'],
  [0x093c, 0x093c, 'NSM'],
  [0x0941, 0x0948, 'NSM'],
  [0x094d, 0x094d, 'NSM'],
  [0x0951, 0x0957, 'NSM'],
  [0x0962, 0x0963, 'NSM'],
  [0x0e31, 0x0e31, 'NSM'],
  [0x0e34, 0x0e3a, 'NSM'],
  [0x0e3f, 0x0e3f, 'ET'],
  [0x0e47, 0x0e4e, 'NSM'],
  [0x1680, 0x1680, 'WS'],
  [0x1ab0, 0x1aff, 'NSM'],
  [0x1dc0, 0x1dff, 'NSM'],
  [0x1fbd, 0x1fbd, 'ON'],
  [0x1fbf, 0x1fc1, 'ON'],
  [0x1fcd, 0x1fcf, 'ON'],
  [0x1fdd, 0x1fdf, 'ON'],
  [0x1fed, 0x1fef, 'ON'],
  [0x1ffd, 0x1ffe, 'ON'],
  [0x2000, 0x200a, 'WS'],
  [0x200b, 0x200d, 'BN'],
  [0x200e, 0x200e, 'L'],
  [0x200f, 0x200f, 'R'],
  [0x2010, 0x2027, 'ON'],
  [0x2028, 0x2028, 'WS'],
  [0x2029, 0x2029, 'B'],
  [0x202a, 0x202e, 'BN'],
  [0x202f, 0x202f, 'CS'],
  [0x2030, 0x2034, 'ET'],
  [0x2035, 0x2043, 'ON'],
  [0x2044, 0x2044, 'CS'],
  [0x2045, 0x205e, 'ON'],
  [0x205f, 0x205f, 'WS'],
  [0x2060, 0x206f, 'BN'],
  [0x2070, 0x2070, 'EN'],
  [0x2074, 0x2079, 'EN'],
  [0x207a, 0x207b, 'ES'],
  [0x207c, 0x207e, 'ON'],
  [0x2080, 0x2089, 'EN'],
  [0x208a, 0x208b, 'ES'],
  [0x208c, 0x208e, 'ON'],
  [0x20a0, 0x20cf, 'ET'],
  [0x20d0, 0x20f0, 'NSM'],
  [0x2100, 0x2101, 'ON'],
  [0x2103, 0x2106, 'ON'],
  [0x2108, 0x2109, 'ON'],
  [0x2114, 0x2114, 'ON'],
  [0x2116, 0x2118, 'ON'],
  [0x211e, 0x2123, 'ON'],
  [0x2125, 0x2125, 'ON'],
  [0x2127, 0x2127, 'ON'],
  [0x2129, 0x2129, 'ON'],
  [0x212e, 0x212e, 'ET'],
  [0x213a, 0x213b, 'ON'],
  [0x2140, 0x2144, 'ON'],
  [0x214a, 0x214d, 'ON'],
  [0x2150, 0x215f, 'ON'],
  [0x2189, 0x2211, 'ON'],
  [0x2212, 0x2212, 'ES'],
  [0x2213, 0x2213, 'ET'],
  [0x2214, 0x2335, 'ON'],
  [0x237b, 0x2394, 'ON'],
  [0x2396, 0x2487, 'ON'],
  [0x2488, 0x249b, 'EN'],
  [0x24ea, 0x26ab, 'ON'],
  [0x26ad, 0x27ff, 'ON'],
  [0x2900, 0x2b73, 'ON'],
  [0x2b76, 0x2bff, 'ON'],
  [0x2ce5, 0x2cea, 'ON'],
  [0x2cef, 0x2cf1, 'NSM'],
  [0x2cf9, 0x2cff, 'ON'],
  [0x2de0, 0x2dff, 'NSM'],
  [0x2e00, 0x2e5d, 'ON'],
  [0x2e80, 0x2ffb, 'ON'],
  [0x3000, 0x3000, 'WS'],
  [0x3001, 0x3004, 'ON'],
  [0x3008, 0x3020, 'ON'],
  [0x302a, 0x302d, 'NSM'],
  [0x3030, 0x3030, 'ON'],
  [0x3036, 0x3037, 'ON'],
  [0x303d, 0x303f, 'ON'],
  [0x3099, 0x309a, 'NSM'],
  [0x309b, 0x309c, 'ON'],
  [0x30a0, 0x30a0, 'ON'],
  [0x30fb, 0x30fb, 'ON'],
  [0xa490, 0xa4c6, 'ON'],
  [0xa60d, 0xa60f, 'ON'],
  [0xa66f, 0xa672, 'NSM'],
  [0xa673, 0xa673, 'ON'],
  [0xa674, 0xa67d, 'NSM'],
  [0xa67e, 0xa67f, 'ON'],
  [0xa700, 0xa721, 'ON'],
  [0xa788, 0xa788, 'ON'],
  [0xfb1d, 0xfb1d, 'R'],
  [0xfb1e, 0xfb1e, 'NSM'],
  [0xfb1f, 0xfb28, 'R'],
  [0xfb29, 0xfb29, 'ES'],
  [0xfb2a, 0xfb4f, 'R'],
  [0xfb50, 0xfd3d, 'AL'],
  [0xfd3e, 0xfd4f, 'ON'],
  [0xfd50, 0xfdcf, 'AL'],
  [0xfdf0, 0xfdfc, 'AL'],
  [0xfdfd, 0xfdff, 'ON'],
  [0xfe00, 0xfe0f, 'NSM'],
  [0xfe10, 0xfe19, 'ON'],
  [0xfe20, 0xfe2f, 'NSM'],
  [0xfe30, 0xfe4f, 'ON'],
  [0xfe50, 0xfe50, 'CS'],
  [0xfe51, 0xfe51, 'ON'],
  [0xfe52, 0xfe52, 'CS'],
  [0xfe54, 0xfe54, 'ON'],
  [0xfe55, 0xfe55, 'CS'],
  [0xfe56, 0xfe5e, 'ON'],
  [0xfe5f, 0xfe5f, 'ET'],
  [0xfe60, 0xfe61, 'ON'],
  [0xfe62, 0xfe63, 'ES'],
  [0xfe64, 0xfe68, 'ON'],
  [0xfe69, 0xfe6a, 'ET'],
  [0xfe6b, 0xfe6b, 'ON'],
  [0xfe70, 0xfefe, 'AL'],
  [0xfeff, 0xfeff, 'BN'],
  [0xff01, 0xff02, 'ON'],
  [0xff03, 0xff05, 'ET'],
  [0xff06, 0xff0a, 'ON'],
  [0xff0b, 0xff0b, 'ES'],
  [0xff0c, 0xff0c, 'CS'],
  [0xff0d, 0xff0d, 'ES'],
  [0xff0e, 0xff0f, 'CS'],
  [0xff10, 0xff19, 'EN'],
  [0xff1a, 0xff1a, 'CS'],
  [0xff1b, 0xff20, 'ON'],
  [0xff3b, 0xff40, 'ON'],
  [0xff5b, 0xff65, 'ON'],
  [0xffe0, 0xffe1, 'ET'],
  [0xffe2, 0xffe4, 'ON'],
  [0xffe5, 0xffe6, 'ET'],
  [0xffe8, 0xffee, 'ON'],
  [0xfff9, 0xfffd, 'ON'],
  [0x10800, 0x10cff, 'R'],
  [0x10d00, 0x10d23, 'AL'],
  [0x10d24, 0x10d27, 'NSM'],
  [0x10d30, 0x10d39, 'AN'],
  [0x10d3a, 0x10e5f, 'R'],
  [0x10e60, 0x10e7e, 'AN'],
  [0x10e7f, 0x10eff, 'R'],
  [0x10f00, 0x10f2f, 'R'],
  [0x10f30, 0x10f45, 'AL'],
  [0x10f46, 0x10f50, 'NSM'],
  [0x10f51, 0x10f6f, 'AL'],
  [0x10f70, 0x10fff, 'R'],
  [0x1d167, 0x1d169, 'NSM'],
  [0x1d17b, 0x1d182, 'NSM'],
  [0x1d7ce, 0x1d7ff, 'EN'],
  [0x1e800, 0x1ec6f, 'R'],
  [0x1ec70, 0x1ecbf, 'AL'],
  [0x1ecc0, 0x1ecff, 'R'],
  [0x1ed00, 0x1ed4f, 'AL'],
  [0x1ed50, 0x1edff, 'R'],
  [0x1ee00, 0x1eeef, 'AL'],
  [0x1eef0, 0x1eeff, 'ON'],
  [0x1ef00, 0x1efff, 'R'],
  [0x1f000, 0x1f0ff, 'ON'],
  [0x1f100, 0x1f10a, 'EN'],
  [0x1f10b, 0x1f10f, 'ON'],
  [0x1f12f, 0x1f12f, 'ON'],
  [0x1f16a, 0x1f16f, 'ON'],
  [0x1f1ad, 0x1f1ad, 'ON'],
  [0x1f260, 0x1fbff, 'ON'],
  [0x1fbf0, 0x1fbf9, 'EN'],
  [0xe0000, 0xe0fff, 'BN'],
];

export function bidiClass(cp: number): BidiClass {
  let lo = 0;
  let hi = RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [a, b, cls] = RANGES[mid];
    if (cp < a) hi = mid - 1;
    else if (cp > b) lo = mid + 1;
    else return cls;
  }
  return 'L';
}

/** True for code points of right-to-left scripts that need an Arabic-capable font. */
export function isArabicScript(cp: number): boolean {
  return (
    (cp >= 0x0600 && cp <= 0x06ff) ||
    (cp >= 0x0750 && cp <= 0x077f) ||
    (cp >= 0x0870 && cp <= 0x08ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfefe) ||
    (cp >= 0x10e60 && cp <= 0x10e7f) ||
    (cp >= 0x1ee00 && cp <= 0x1eeff)
  );
}

const MIRRORS: ReadonlyMap<number, number> = new Map(
  [
    ['(', ')'],
    ['[', ']'],
    ['{', '}'],
    ['<', '>'],
    ['«', '»'],
    ['‹', '›'],
    ['⁅', '⁆'],
    ['≤', '≥'],
    ['⟨', '⟩'],
    ['﴾', '﴿'],
  ].flatMap(([a, b]) => [
    [a.codePointAt(0)!, b.codePointAt(0)!],
    [b.codePointAt(0)!, a.codePointAt(0)!],
  ]),
);

/** Bidi_Mirroring_Glyph for the common paired punctuation (rule L4); identity otherwise. */
export function mirrorCodePoint(cp: number): number {
  return MIRRORS.get(cp) ?? cp;
}

const isStrong = (c: BidiClass) => c === 'L' || c === 'R' || c === 'AL';

/** Paragraph embedding level from the first strong character (P2/P3); `fallback` if none. */
export function paragraphLevel(codePoints: readonly number[], fallback: 0 | 1 = 0): 0 | 1 {
  for (const cp of codePoints) {
    const c = bidiClass(cp);
    if (c === 'L') return 0;
    if (c === 'R' || c === 'AL') return 1;
  }
  return fallback;
}

/**
 * Resolved embedding level for every code point of one paragraph (no 'B' inside), after rules
 * W1–W7, N1–N2, I1–I2 and L1.
 */
export function resolveLevels(codePoints: readonly number[], paraLevel: 0 | 1): Uint8Array {
  const n = codePoints.length;
  const orig = codePoints.map(bidiClass);
  const t: BidiClass[] = orig.slice();
  const e: BidiClass = paraLevel ? 'R' : 'L';
  // BN characters are treated like neutrals that follow their neighbours (X9 approximation).
  // W1: NSM takes the type of the previous character (sos at start).
  for (let i = 0; i < n; i++) {
    if (t[i] === 'NSM') t[i] = i === 0 ? e : t[i - 1] === 'BN' ? 'ON' : t[i - 1];
  }
  // W2: EN after AL (looking back to the last strong type) becomes AN.
  let lastStrong: BidiClass = e;
  for (let i = 0; i < n; i++) {
    if (isStrong(t[i])) lastStrong = t[i];
    else if (t[i] === 'EN' && lastStrong === 'AL') t[i] = 'AN';
  }
  // W3: AL → R.
  for (let i = 0; i < n; i++) if (t[i] === 'AL') t[i] = 'R';
  // W4: single ES between ENs → EN; single CS between same-type numbers → that type.
  for (let i = 1; i < n - 1; i++) {
    if (t[i] === 'ES' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    else if (t[i] === 'CS' && t[i - 1] === 'EN' && t[i + 1] === 'EN') t[i] = 'EN';
    else if (t[i] === 'CS' && t[i - 1] === 'AN' && t[i + 1] === 'AN') t[i] = 'AN';
  }
  // W5: sequences of ET adjacent to EN → EN.
  for (let i = 0; i < n; i++) {
    if (t[i] !== 'ET') continue;
    let j = i;
    while (j < n && t[j] === 'ET') j++;
    if ((i > 0 && t[i - 1] === 'EN') || (j < n && t[j] === 'EN')) for (let k = i; k < j; k++) t[k] = 'EN';
    i = j - 1;
  }
  // W6: remaining separators/terminators → ON.
  for (let i = 0; i < n; i++) if (t[i] === 'ES' || t[i] === 'ET' || t[i] === 'CS') t[i] = 'ON';
  // W7: EN after L (or sos L) → L.
  lastStrong = e;
  for (let i = 0; i < n; i++) {
    if (t[i] === 'L' || t[i] === 'R') lastStrong = t[i];
    else if (t[i] === 'EN' && lastStrong === 'L') t[i] = 'L';
  }
  // N1/N2: neutral sequences.
  const isNeutral = (c: BidiClass) => c === 'B' || c === 'S' || c === 'WS' || c === 'ON' || c === 'BN';
  const dirOf = (c: BidiClass): 'L' | 'R' => (c === 'L' ? 'L' : 'R'); // EN/AN count as R
  for (let i = 0; i < n; i++) {
    if (!isNeutral(t[i])) continue;
    let j = i;
    while (j < n && isNeutral(t[j])) j++;
    const before = i === 0 ? e : dirOf(t[i - 1]);
    const after = j === n ? e : dirOf(t[j]);
    const resolved: BidiClass = before === after ? before : e;
    for (let k = i; k < j; k++) t[k] = resolved;
    i = j - 1;
  }
  // I1/I2.
  const levels = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const c = t[i];
    if (paraLevel === 0) levels[i] = c === 'R' ? 1 : c === 'AN' || c === 'EN' ? 2 : 0;
    else levels[i] = c === 'L' || c === 'EN' || c === 'AN' ? 2 : 1;
  }
  // L1: trailing whitespace (and whitespace before segment separators) → paragraph level.
  const isWsLike = (c: BidiClass) => c === 'WS' || c === 'BN';
  for (let i = n - 1; i >= 0 && isWsLike(orig[i]); i--) levels[i] = paraLevel;
  for (let i = 0; i < n; i++) {
    if (orig[i] !== 'S') continue;
    levels[i] = paraLevel;
    for (let k = i - 1; k >= 0 && isWsLike(orig[k]); k--) levels[k] = paraLevel;
  }
  return levels;
}

/**
 * Visual order (rule L2) of a sequence of runs, each with its own level: returns run indices in
 * left-to-right display order. Runs at odd levels are displayed right-to-left internally.
 */
export function reorderRuns(levels: readonly number[]): number[] {
  const order = levels.map((_, i) => i);
  if (!levels.length) return order;
  let max = 0;
  let minOdd = Infinity;
  for (const l of levels) {
    if (l > max) max = l;
    if (l % 2 === 1 && l < minOdd) minOdd = l;
  }
  if (!Number.isFinite(minOdd)) return order;
  const lv = levels.slice();
  for (let level = max; level >= minOdd; level--) {
    for (let i = 0; i < lv.length; i++) {
      if (lv[i] < level) continue;
      let j = i;
      while (j < lv.length && lv[j] >= level) j++;
      reverseRange(order, i, j);
      reverseRange(lv, i, j);
      i = j - 1;
    }
  }
  return order;
}

function reverseRange<T>(arr: T[], start: number, end: number): void {
  for (let a = start, b = end - 1; a < b; a++, b--) {
    const tmp = arr[a];
    arr[a] = arr[b];
    arr[b] = tmp;
  }
}

/** Visual (display-order) string of a single line, with mirroring; mainly for tests and debugging. */
export function visualString(text: string, direction: 'auto' | 'ltr' | 'rtl' = 'auto'): string {
  const cps = [...text].map((c) => c.codePointAt(0)!);
  const para = direction === 'auto' ? paragraphLevel(cps) : direction === 'rtl' ? 1 : 0;
  const levels = resolveLevels(cps, para);
  const order = reorderRuns(Array.from(levels));
  return order.map((i) => String.fromCodePoint(levels[i] % 2 ? mirrorCodePoint(cps[i]) : cps[i])).join('');
}
