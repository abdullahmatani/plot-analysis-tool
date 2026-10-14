/**
 * Text decoding for imported tables (row 62). Detects BOMs (UTF-8, UTF-16LE/BE), BOM-less UTF-16,
 * then tries strict UTF-8 and falls back to a single-byte Windows code page chosen by heuristics:
 * windows-1256 (Arabic, common for CSV exported by Arabic-locale Excel) or windows-1252 (Western).
 * Pure and worker-safe; the code page tables are embedded so nothing depends on optional ICU data.
 */

export type DetectedEncoding = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1256' | 'windows-1252';

// prettier-ignore
const CP1256_HIGH =
  '\u20ac\u067e\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0679\u2039\u0152\u0686\u0698\u0688' +
  '\u06af\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u06a9\u2122\u0691\u203a\u0153\u200c\u200d\u06ba' +
  '\u00a0\u060c\u00a2\u00a3\u00a4\u00a5\u00a6\u00a7\u00a8\u00a9\u06be\u00ab\u00ac\u00ad\u00ae\u00af' +
  '\u00b0\u00b1\u00b2\u00b3\u00b4\u00b5\u00b6\u00b7\u00b8\u00b9\u061b\u00bb\u00bc\u00bd\u00be\u061f' +
  '\u06c1\u0621\u0622\u0623\u0624\u0625\u0626\u0627\u0628\u0629\u062a\u062b\u062c\u062d\u062e\u062f' +
  '\u0630\u0631\u0632\u0633\u0634\u0635\u0636\u00d7\u0637\u0638\u0639\u063a\u0640\u0641\u0642\u0643' +
  '\u00e0\u0644\u00e2\u0645\u0646\u0647\u0648\u00e7\u00e8\u00e9\u00ea\u00eb\u0649\u064a\u00ee\u00ef' +
  '\u064b\u064c\u064d\u064e\u00f4\u064f\u0650\u00f7\u0651\u00f9\u0652\u00fb\u00fc\u200e\u200f\u06d2';

/** windows-1252 bytes 0x80-0x9F (0xA0-0xFF equal Latin-1). Undefined bytes map to C1 controls (WHATWG). */
// prettier-ignore
const CP1252_C1 =
  '\u20ac\u0081\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\u008d\u017d\u008f' +
  '\u0090\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\u009d\u017e\u0178';

function decodeSingleByte(bytes: Uint8Array, high: (b: number) => string): string {
  const parts: string[] = [];
  const CHUNK = 8192;
  for (let start = 0; start < bytes.length; start += CHUNK) {
    const end = Math.min(bytes.length, start + CHUNK);
    let s = '';
    for (let i = start; i < end; i++) {
      const b = bytes[i];
      s += b < 0x80 ? String.fromCharCode(b) : high(b);
    }
    parts.push(s);
  }
  return parts.join('');
}

export function decodeWindows1256(bytes: Uint8Array): string {
  return decodeSingleByte(bytes, (b) => CP1256_HIGH[b - 0x80]);
}

export function decodeWindows1252(bytes: Uint8Array): string {
  return decodeSingleByte(bytes, (b) => (b < 0xa0 ? CP1252_C1[b - 0x80] : String.fromCharCode(b)));
}

function decodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const parts: string[] = [];
  const units: number[] = [];
  const end = bytes.length - ((bytes.length - start) % 2);
  for (let i = start; i < end; i += 2) {
    units.push(littleEndian ? bytes[i] | (bytes[i + 1] << 8) : (bytes[i] << 8) | bytes[i + 1]);
    if (units.length === 8192) {
      parts.push(String.fromCharCode(...units));
      units.length = 0;
    }
  }
  if (units.length) parts.push(String.fromCharCode(...units));
  return parts.join('');
}

/** BOM-less UTF-16 guess: text with many NUL bytes on one parity. */
function sniffUtf16(bytes: Uint8Array): 'utf-16le' | 'utf-16be' | null {
  const n = Math.min(bytes.length, 4096) & ~1;
  if (n < 4) return null;
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < n; i += 2) {
    if (bytes[i] === 0) evenZero++;
    if (bytes[i + 1] === 0) oddZero++;
  }
  const pairs = n / 2;
  if (oddZero > pairs * 0.3 && evenZero < pairs * 0.05) return 'utf-16le';
  if (evenZero > pairs * 0.3 && oddZero < pairs * 0.05) return 'utf-16be';
  return null;
}

function isArabicIn1256(b: number): boolean {
  if (b < 0x80) return false;
  const cp = CP1256_HIGH.charCodeAt(b - 0x80);
  return cp >= 0x0600 && cp <= 0x06ff;
}

/**
 * Chooses between windows-1256 and windows-1252 for non-UTF-8 bytes. Arabic text is written as
 * runs of consecutive high bytes (words), Western text has accented letters scattered between
 * ASCII letters, so the share of high bytes that sit next to another Arabic-letter byte decides.
 */
export function guessSingleByteEncoding(bytes: Uint8Array): 'windows-1256' | 'windows-1252' {
  let high = 0;
  let adjacent = 0;
  const n = Math.min(bytes.length, 1 << 20);
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b < 0x80) continue;
    high++;
    if (
      isArabicIn1256(b) &&
      ((i > 0 && isArabicIn1256(bytes[i - 1])) || (i + 1 < n && isArabicIn1256(bytes[i + 1])))
    ) {
      adjacent++;
    }
  }
  return high > 0 && adjacent / high >= 0.5 ? 'windows-1256' : 'windows-1252';
}

/** Strict UTF-8 decode; null when the bytes are not valid UTF-8. */
function tryUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Detects the encoding used by `bytes` (see module comment). */
export function detectEncoding(bytes: Uint8Array): { encoding: DetectedEncoding; bomLength: number } {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { encoding: 'utf-8', bomLength: 3 };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe)
    return { encoding: 'utf-16le', bomLength: 2 };
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff)
    return { encoding: 'utf-16be', bomLength: 2 };
  const utf16 = sniffUtf16(bytes);
  if (utf16) return { encoding: utf16, bomLength: 0 };
  if (tryUtf8(bytes) !== null) return { encoding: 'utf-8', bomLength: 0 };
  return { encoding: guessSingleByteEncoding(bytes), bomLength: 0 };
}

/** Decodes the bytes of a text file (CSV/TSV) into a string without BOM. */
export function decodeText(bytes: Uint8Array): string {
  const hasBomOrUtf16 =
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
  if (!hasBomOrUtf16 && !sniffUtf16(bytes)) {
    // Common case first: (BOM-less or BOM-prefixed) valid UTF-8, decoded once.
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    const utf8 = tryUtf8(bytes.subarray(bom));
    if (utf8 !== null) return utf8;
    // A BOM says UTF-8 even when some sequences are broken: decode leniently (U+FFFD).
    if (bom) return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(bom));
  }
  const { encoding, bomLength } = detectEncoding(bytes);
  switch (encoding) {
    case 'utf-16le':
      return decodeUtf16(bytes, bomLength, true);
    case 'utf-16be':
      return decodeUtf16(bytes, bomLength, false);
    case 'windows-1256':
      return decodeWindows1256(bytes);
    case 'windows-1252':
      return decodeWindows1252(bytes);
    default:
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(bomLength));
  }
}
