import { unzlibSync } from 'fflate';

/** Minimal PNG decoder (8-bit RGB/RGBA, non-interlaced) for reading screenshots in tests. */
export function decodePng(buf: Uint8Array): {
  width: number;
  height: number;
  px(x: number, y: number): number[];
} {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 8;
  let width = 0;
  let height = 0;
  let channels = 4;
  const idat: Uint8Array[] = [];
  while (o < buf.length) {
    const len = dv.getUint32(o);
    const type = String.fromCharCode(...buf.subarray(o + 4, o + 8));
    const data = buf.subarray(o + 8, o + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(o + 8);
      height = dv.getUint32(o + 12);
      const colorType = data[9];
      if (data[8] !== 8 || data[12] !== 0 || (colorType !== 2 && colorType !== 6))
        throw new Error('unsupported PNG');
      channels = colorType === 6 ? 4 : 3;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    o += 12 + len;
  }
  const all = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let k = 0;
  for (const d of idat) all.set(d, (k += d.length) - d.length);
  const raw = unzlibSync(all);
  const stride = width * channels;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      const pred =
        f === 0
          ? 0
          : f === 1
            ? a
            : f === 2
              ? b
              : f === 3
                ? (a + b) >> 1
                : pa <= pb && pa <= pc
                  ? a
                  : pb <= pc
                    ? b
                    : c;
      out[y * stride + x] = (v + pred) & 255;
    }
  }
  return {
    width,
    height,
    px: (x, y) => Array.from(out.subarray((y * width + x) * channels, (y * width + x) * channels + 3)),
  };
}
