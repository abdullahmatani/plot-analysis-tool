import { MAX_GROUP_CODE, VALUE_TYPE, VT } from './codes';
import { DxfAbortError, DxfParseError } from './errors';

/**
 * Flat storage of all group code/value pairs of a DXF file. Numeric values live in `num`, string
 * values in `str` (the other array holds a placeholder). Records (one per code-0 tag) reference
 * contiguous ranges of this store, so the file is tokenized once without per-entity arrays.
 */
export class Tags {
  code: Int32Array;
  num: Float64Array;
  str: string[] = [];
  n = 0;

  constructor(capacity = 4096) {
    this.code = new Int32Array(capacity);
    this.num = new Float64Array(capacity);
  }

  private grow() {
    const cap = this.code.length * 2;
    const c = new Int32Array(cap);
    c.set(this.code);
    this.code = c;
    const v = new Float64Array(cap);
    v.set(this.num);
    this.num = v;
  }

  push(code: number, num: number, str: string): void {
    if (this.n === this.code.length) this.grow();
    this.code[this.n] = code;
    this.num[this.n] = num;
    this.str.push(str);
    this.n++;
  }
}

/** One DXF record: the tags following a code-0 tag up to the next code-0 tag. */
export interface Rec {
  /** Upper-case record type (code 0 value), e.g. "LINE", "SECTION". */
  type: string;
  /** Tag range [s, e) in Tags. Extended data (1001…) and embedded objects (101…) are excluded. */
  s: number;
  e: number;
  /** ASCII: 1-based line number of the code-0 line. Binary: byte offset. */
  line: number;
  /** Child records: VERTEX list of a POLYLINE, ATTRIB list of an INSERT. */
  sub: Rec[] | null;
}

export interface TokenizeOptions {
  onProgress?: (fraction: number) => void;
  signal?: { aborted: boolean };
  /** Fraction of the overall progress bar covered by tokenizing. */
  progressScale?: number;
}

export interface Tokenized {
  tags: Tags;
  recs: Rec[];
  /** True when the data ended in the middle of a tag pair. */
  truncated: boolean;
}

/** Progress/abort checks happen about every 1 % of the input (and at least every 256 KiB). */
function tickStep(len: number): number {
  return Math.max(4096, Math.min(1 << 18, Math.floor(len / 100)));
}

class Progress {
  private last = -1;
  constructor(private opts: TokenizeOptions) {}
  tick(fraction: number) {
    if (this.opts.signal?.aborted) throw new DxfAbortError();
    const f = fraction * (this.opts.progressScale ?? 1);
    if (this.opts.onProgress && f - this.last >= 0.01) {
      this.last = f;
      this.opts.onProgress(f);
    }
  }
}

function parseNumber(v: string): number {
  const x = Number(v);
  if (x === x) return x; // not NaN
  return parseFloat(v); // lenient: "1.5 abc", trailing garbage
}

/**
 * Tokenizes ASCII DXF text. Lines are located with indexOf (no line array is built); each pair's
 * value is converted to a number or kept as a string depending on its group code.
 */
export function tokenizeAscii(text: string, opts: TokenizeOptions = {}): Tokenized {
  let s = text;
  if (s.indexOf('\n') < 0 && s.indexOf('\r') >= 0) s = s.replace(/\r/g, '\n'); // classic Mac line ends
  const len = s.length;
  const tags = new Tags(Math.max(4096, Math.min(1 << 24, (len / 12) | 0)));
  const recs: Rec[] = [];
  const progress = new Progress(opts);
  let pos = s.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 0;
  let cur: Rec | null = null;
  let skipping = false;
  let truncated = false;
  const step = tickStep(len);
  let nextTick = step;

  while (pos < len) {
    if (pos >= nextTick) {
      nextTick = pos + step;
      progress.tick(pos / len);
    }
    // --- group code line ---
    let e = s.indexOf('\n', pos);
    if (e < 0) e = len;
    line++;
    const codeLine = line;
    let i = pos;
    let end = e;
    let c = 0;
    while (i < end && ((c = s.charCodeAt(i)) === 32 || c === 9)) i++;
    while (end > i && ((c = s.charCodeAt(end - 1)) === 13 || c === 32 || c === 9)) end--;
    if (i === end) {
      // Blank line: tolerated only as trailing whitespace at the end of the file.
      // eslint-disable-next-line no-control-regex
      if (/^[\s\x00\x1a]*$/.test(s.slice(pos))) break;
      throw new DxfParseError('Empty line where a group code was expected', { line: codeLine });
    }
    let neg = false;
    if (s.charCodeAt(i) === 45) {
      neg = true;
      i++;
    }
    let code = 0;
    let digits = 0;
    for (; i < end; i++) {
      c = s.charCodeAt(i);
      if (c < 48 || c > 57) break;
      code = code * 10 + (c - 48);
      digits++;
    }
    if (i !== end || digits === 0 || digits > 5) {
      // eslint-disable-next-line no-control-regex
      if (/^[\s\x00\x1a]+$/.test(s.slice(pos))) break; // EOF padding
      const shown = s.slice(pos, Math.min(e, pos + 40)).trim();
      throw new DxfParseError(`Invalid group code "${shown}" — expected an integer`, { line: codeLine });
    }
    if (neg) code = -code;
    pos = e + 1;
    // --- value line ---
    if (pos > len) {
      truncated = true;
      break;
    }
    e = s.indexOf('\n', pos);
    if (e < 0) e = len;
    line++;
    let ve = e;
    if (ve > pos && s.charCodeAt(ve - 1) === 13) ve--;

    if (code === 0) {
      if (cur && !skipping) cur.e = tags.n;
      let type = s.substring(pos, ve).trim();
      if (type !== type.toUpperCase()) type = type.toUpperCase();
      cur = { type, s: tags.n, e: tags.n, line: codeLine, sub: null };
      recs.push(cur);
      skipping = false;
      pos = e + 1;
      if (type === 'EOF') break;
      continue;
    }
    if (!skipping) {
      if (code === 1001 || code === 101) {
        skipping = true;
        if (cur) cur.e = tags.n;
      } else if (code !== 999) {
        const vt = code >= 0 && code <= MAX_GROUP_CODE ? VALUE_TYPE[code] : VT.STRING;
        if (vt === VT.STRING || vt === VT.BINARY) tags.push(code, 0, s.substring(pos, ve));
        else tags.push(code, parseNumber(s.substring(pos, ve)), '');
      }
    }
    pos = e + 1;
  }
  if (cur && !skipping) cur.e = tags.n;
  progress.tick(1);
  return { tags, recs, truncated };
}

export const BINARY_SENTINEL = 'AutoCAD Binary DXF\r\n\x1a\x00';

/**
 * Tokenizes binary DXF. Group codes are 2 bytes (little endian) for R13+ and 1 byte (255 = escape
 * followed by a 2-byte code) for R12 and earlier; detected from the first tag (0 / "SECTION").
 */
export function tokenizeBinary(
  bytes: Uint8Array,
  decoder: TextDecoder,
  opts: TokenizeOptions = {},
): Tokenized {
  const len = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tags = new Tags(Math.max(4096, Math.min(1 << 24, (len / 10) | 0)));
  const recs: Rec[] = [];
  const progress = new Progress(opts);
  let pos = BINARY_SENTINEL.length;
  // R13+: "00 00 'SECTION'"; R12: "00 'SECTION'".
  const twoByte = !(bytes[pos] === 0 && bytes[pos + 1] === 0x53);
  let cur: Rec | null = null;
  let skipping = false;
  let truncated = false;
  const step = tickStep(len);
  let nextTick = step;

  const readString = (start: number, end: number): string => {
    const n = end - start;
    if (n < 64) {
      let ascii = true;
      for (let k = start; k < end; k++) {
        if (bytes[k] >= 0x80) {
          ascii = false;
          break;
        }
      }
      if (ascii) {
        let r = '';
        for (let k = start; k < end; k++) r += String.fromCharCode(bytes[k]);
        return r;
      }
    }
    return decoder.decode(bytes.subarray(start, end));
  };

  while (pos < len) {
    if (pos >= nextTick) {
      nextTick = pos + step;
      progress.tick(pos / len);
    }
    const off = pos;
    let code: number;
    if (twoByte) {
      if (pos + 2 > len) {
        truncated = true;
        break;
      }
      code = dv.getInt16(pos, true);
      pos += 2;
    } else {
      code = bytes[pos++];
      if (code === 255) {
        if (pos + 2 > len) {
          truncated = true;
          break;
        }
        code = dv.getUint16(pos, true);
        pos += 2;
      }
    }
    if (code < 0 || code > MAX_GROUP_CODE) {
      throw new DxfParseError(`Invalid group code ${code} in binary DXF`, { offset: off });
    }
    const vt = VALUE_TYPE[code];
    let num = 0;
    let str = '';
    let need = 0;
    switch (vt) {
      case VT.DOUBLE:
        need = 8;
        break;
      case VT.INT16:
        need = 2;
        break;
      case VT.INT32:
        need = 4;
        break;
      case VT.INT64:
        need = 8;
        break;
      case VT.BOOL:
        need = 1;
        break;
      case VT.BINARY:
        need = 1 + (pos < len ? bytes[pos] : 0);
        break;
    }
    if (pos + need > len) {
      truncated = true;
      break;
    }
    switch (vt) {
      case VT.DOUBLE:
        num = dv.getFloat64(pos, true);
        break;
      case VT.INT16:
        num = dv.getInt16(pos, true);
        break;
      case VT.INT32:
        num = dv.getInt32(pos, true);
        break;
      case VT.INT64:
        num = dv.getUint32(pos, true) + dv.getInt32(pos + 4, true) * 4294967296;
        break;
      case VT.BOOL:
        num = bytes[pos];
        break;
      case VT.BINARY: {
        let hex = '';
        for (let k = pos + 1; k < pos + need; k++) hex += (bytes[k] < 16 ? '0' : '') + bytes[k].toString(16);
        str = hex.toUpperCase();
        break;
      }
      default: {
        const z = bytes.indexOf(0, pos);
        if (z < 0) {
          truncated = true;
          pos = len;
          break;
        }
        str = readString(pos, z);
        need = z + 1 - pos;
      }
    }
    if (truncated) break;
    pos += need;

    if (code === 0) {
      if (cur && !skipping) cur.e = tags.n;
      let type = str.trim();
      if (type !== type.toUpperCase()) type = type.toUpperCase();
      cur = { type, s: tags.n, e: tags.n, line: off, sub: null };
      recs.push(cur);
      skipping = false;
      if (type === 'EOF') break;
      continue;
    }
    if (skipping) continue;
    if (code === 1001 || code === 101) {
      skipping = true;
      if (cur) cur.e = tags.n;
    } else if (code !== 999) {
      tags.push(code, num, str);
    }
  }
  if (cur && !skipping) cur.e = tags.n;
  progress.tick(1);
  return { tags, recs, truncated };
}

// ---------------------------------------------------------------------------------------------
// Record accessors

export function recStr(t: Tags, r: Rec, code: number, def = ''): string {
  const c = t.code;
  for (let i = r.s; i < r.e; i++) if (c[i] === code) return t.str[i];
  return def;
}

export function recNum(t: Tags, r: Rec, code: number, def: number): number {
  const c = t.code;
  for (let i = r.s; i < r.e; i++) if (c[i] === code) return t.num[i];
  return def;
}

export function recHas(t: Tags, r: Rec, code: number): boolean {
  const c = t.code;
  for (let i = r.s; i < r.e; i++) if (c[i] === code) return true;
  return false;
}
