import { unzlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { concatParts, crc32, PngStreamEncoder } from './png-encoder';

interface Decoded {
  width: number;
  height: number;
  colorType: number;
  ppm?: number;
  pixels: Uint8Array;
  chunks: string[];
}

/** Minimal PNG decoder for the filters the encoder uses (None, Up). Checks every CRC. */
function decode(png: Uint8Array): Decoded {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let ppm: number | undefined;
  const idat: Uint8Array[] = [];
  const chunks: string[] = [];
  while (o < png.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    const data = png.subarray(o + 8, o + 8 + len);
    expect(dv.getUint32(o + 8 + len)).toBe(crc32(png.subarray(o + 4, o + 8 + len)));
    chunks.push(type);
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      colorType = data[9];
    } else if (type === 'pHYs') ppm = dv.getUint32(o + 8);
    else if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = unzlibSync(concatParts(idat));
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const up = y > 0 ? pixels[(y - 1) * stride + i] : 0;
      pixels[y * stride + i] = f === 2 ? (v + up) & 255 : v;
    }
  }
  return { width, height, colorType, ppm, pixels, chunks };
}

describe('streaming PNG encoder (row 78)', () => {
  it('encodes strips (RGB, Up filter) losslessly with DPI metadata', () => {
    const w = 37;
    const h = 23;
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        rgba.set([(x * 7) & 255, (y * 11) & 255, (x * y) & 255, 255], (y * w + x) * 4);
    const enc = new PngStreamEncoder(w, h, { dpi: 300, idatSize: 64 });
    // Three uneven strips.
    enc.pushRgba(rgba.subarray(0, w * 5 * 4), 5);
    enc.pushRgba(rgba.subarray(w * 5 * 4, w * 17 * 4), 12);
    enc.pushRgba(rgba.subarray(w * 17 * 4), 6);
    const png = concatParts(enc.finish());
    const d = decode(png);
    expect(d.width).toBe(w);
    expect(d.height).toBe(h);
    expect(d.colorType).toBe(2);
    expect(d.ppm).toBe(Math.round(300 / 0.0254));
    expect(d.chunks[0]).toBe('IHDR');
    expect(d.chunks[d.chunks.length - 1]).toBe('IEND');
    for (let i = 0; i < w * h; i++) {
      expect(d.pixels[i * 3]).toBe(rgba[i * 4]);
      expect(d.pixels[i * 3 + 1]).toBe(rgba[i * 4 + 1]);
      expect(d.pixels[i * 3 + 2]).toBe(rgba[i * 4 + 2]);
    }
  });

  it('streams compressed output while rows are pushed (bounded memory)', () => {
    const w = 1000;
    const h = 400;
    const enc = new PngStreamEncoder(w, h, { idatSize: 16 * 1024 });
    let seed = 1;
    const strip = new Uint8Array(w * 100 * 4);
    let before = 0;
    for (let s = 0; s < 4; s++) {
      for (let i = 0; i < strip.length; i++) strip[i] = (seed = (seed * 1103515245 + 12345) >>> 0) >>> 24;
      enc.pushRgba(strip, 100);
      if (s === 1) before = enc.parts.length;
    }
    // IDAT chunks were already emitted before the last strips were pushed.
    expect(before).toBeGreaterThanOrEqual(3);
    const d = decode(concatParts(enc.finish()));
    expect(d.height).toBe(h);
  });

  it('keeps alpha when asked and rejects incomplete images', () => {
    const enc = new PngStreamEncoder(2, 2, { alpha: true });
    enc.pushRgba(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]), 2);
    const d = decode(concatParts(enc.finish()));
    expect(d.colorType).toBe(6);
    expect([...d.pixels]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    const bad = new PngStreamEncoder(2, 2);
    bad.pushRgba(new Uint8Array(8), 1);
    expect(() => bad.finish()).toThrow(/incomplete/);
  });
});
