import { Zlib } from 'fflate';

/**
 * Streaming PNG encoder (row 78). Scanlines are filtered ("Up") and fed to a streaming zlib
 * compressor strip by strip, so a 300 dpi A1 sheet (≈ 10 000 × 7 000 px) never needs the whole
 * image in memory: only one strip of pixels plus the compressed output. The pHYs chunk records the
 * DPI so the image prints at the sheet's paper size (and therefore at true scale).
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (PNG/zip polynomial), continuing from a previous value. */
export function crc32(bytes: Uint8Array, prev = 0): number {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface PngEncoderOptions {
  /** Keep the alpha channel (RGBA); default false (RGB on an opaque background). */
  alpha?: boolean;
  /** Pixels per inch written to pHYs. */
  dpi?: number;
  /** zlib level 0–9 (default 6). */
  level?: number;
  /** IDAT chunk size target in bytes (default 256 KiB). */
  idatSize?: number;
}

export class PngStreamEncoder {
  readonly parts: Uint8Array[] = [];
  private readonly zlib: Zlib;
  private readonly channels: number;
  private readonly rowBytes: number;
  private prev: Uint8Array;
  private cur: Uint8Array;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private rows = 0;
  private done = false;
  private readonly idatSize: number;

  constructor(
    readonly width: number,
    readonly height: number,
    opts: PngEncoderOptions = {},
  ) {
    if (!(width > 0 && height > 0) || width > 0x7fffffff || height > 0x7fffffff)
      throw new Error('PNG size out of range');
    this.channels = opts.alpha ? 4 : 3;
    this.rowBytes = width * this.channels;
    this.prev = new Uint8Array(this.rowBytes);
    this.cur = new Uint8Array(this.rowBytes);
    this.idatSize = opts.idatSize ?? 256 * 1024;
    this.parts.push(PNG_SIGNATURE.slice());
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, width);
    dv.setUint32(4, height);
    ihdr[8] = 8;
    ihdr[9] = opts.alpha ? 6 : 2;
    this.parts.push(chunk('IHDR', ihdr));
    if (opts.dpi && opts.dpi > 0) {
      const ppm = Math.round(opts.dpi / 0.0254);
      const phys = new Uint8Array(9);
      const pv = new DataView(phys.buffer);
      pv.setUint32(0, ppm);
      pv.setUint32(4, ppm);
      phys[8] = 1; // metres
      this.parts.push(chunk('pHYs', phys));
    }
    this.zlib = new Zlib({ level: (opts.level ?? 6) as 6 });
    this.zlib.ondata = (data, final) => {
      if (data.length) {
        this.pending.push(data);
        this.pendingBytes += data.length;
      }
      if (this.pendingBytes >= this.idatSize || (final && this.pendingBytes > 0)) this.flushIdat();
    };
  }

  private flushIdat() {
    const all = new Uint8Array(this.pendingBytes);
    let o = 0;
    for (const p of this.pending) {
      all.set(p, o);
      o += p.length;
    }
    this.pending = [];
    this.pendingBytes = 0;
    this.parts.push(chunk('IDAT', all));
  }

  /** Rows written so far. */
  get rowsWritten(): number {
    return this.rows;
  }

  /**
   * Appends `count` rows of RGBA pixels (`stride` bytes per row, default width × 4), e.g. the
   * `data` of an ImageData for a strip.
   */
  pushRgba(rgba: Uint8Array | Uint8ClampedArray, count: number, stride = this.width * 4): void {
    if (this.done) throw new Error('PNG already finished');
    if (this.rows + count > this.height) throw new Error('Too many PNG rows');
    const ch = this.channels;
    const w = this.width;
    const lineBytes = this.rowBytes + 1;
    // Filtered scanlines of the whole strip, compressed in one push.
    const out = new Uint8Array(count * lineBytes);
    for (let r = 0; r < count; r++) {
      const src = r * stride;
      const cur = this.cur;
      if (ch === 4) cur.set(rgba.subarray(src, src + w * 4));
      else
        for (let x = 0, s = src, d = 0; x < w; x++, s += 4, d += 3) {
          cur[d] = rgba[s];
          cur[d + 1] = rgba[s + 1];
          cur[d + 2] = rgba[s + 2];
        }
      const o = r * lineBytes;
      if (this.rows === 0) {
        out[o] = 0; // None for the first row
        out.set(cur, o + 1);
      } else {
        out[o] = 2; // Up
        const prev = this.prev;
        for (let i = 0; i < cur.length; i++) out[o + 1 + i] = (cur[i] - prev[i]) & 255;
      }
      this.rows++;
      this.cur = this.prev;
      this.prev = cur;
    }
    this.zlib.push(out, false);
  }

  /** Finishes the stream and returns the PNG file as parts (concatenate or wrap in a Blob). */
  finish(): Uint8Array[] {
    if (this.done) return this.parts;
    if (this.rows !== this.height) throw new Error(`PNG incomplete: ${this.rows} of ${this.height} rows`);
    this.zlib.push(new Uint8Array(0), true);
    if (this.pendingBytes) this.flushIdat();
    this.parts.push(chunk('IEND', new Uint8Array(0)));
    this.done = true;
    return this.parts;
  }
}

export function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
