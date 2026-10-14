import { describe, expect, it } from 'vitest';

import { decodeText, detectEncoding, guessSingleByteEncoding } from './decode';
import { readFixture } from './test-helpers';

const enc = (s: string) => new TextEncoder().encode(s);

function utf16(s: string, le: boolean, bom: boolean): Uint8Array {
  const out = new Uint8Array((s.length + (bom ? 1 : 0)) * 2);
  let o = 0;
  const put = (u: number) => {
    out[o++] = le ? u & 255 : u >> 8;
    out[o++] = le ? u >> 8 : u & 255;
  };
  if (bom) put(0xfeff);
  for (let i = 0; i < s.length; i++) put(s.charCodeAt(i));
  return out;
}

describe('decodeText', () => {
  const sample = 'Tag,الوصف\nP-101,حريق نفاث 😀\n';

  it('decodes UTF-8 with and without BOM', () => {
    expect(decodeText(enc(sample))).toBe(sample);
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc(sample)]))).toBe(sample);
  });

  it('decodes UTF-16LE/BE with BOM and sniffs BOM-less UTF-16', () => {
    expect(decodeText(utf16(sample, true, true))).toBe(sample);
    expect(decodeText(utf16(sample, false, true))).toBe(sample);
    const ascii = 'Tag\tRadius\r\nP-101\t25\r\n';
    expect(detectEncoding(utf16(ascii, true, false)).encoding).toBe('utf-16le');
    expect(decodeText(utf16(ascii, true, false))).toBe(ascii);
    expect(decodeText(utf16(ascii, false, false))).toBe(ascii);
  });

  it('falls back to windows-1256 for Arabic and windows-1252 for Western text', () => {
    // "حريق نفاث" in windows-1256.
    const arabic = new Uint8Array([0xcd, 0xd1, 0xed, 0xde, 0x20, 0xe4, 0xdd, 0xc7, 0xcb, 0x2c, 0x31]);
    expect(guessSingleByteEncoding(arabic)).toBe('windows-1256');
    expect(decodeText(arabic)).toBe('حريق نفاث,1');
    // "Café, Zürich – 25 m²" in windows-1252.
    const western = new Uint8Array([
      0x43, 0x61, 0x66, 0xe9, 0x2c, 0x20, 0x5a, 0xfc, 0x72, 0x69, 0x63, 0x68, 0x20, 0x96, 0x20, 0x32, 0x35,
      0x20, 0x6d, 0xb2,
    ]);
    expect(guessSingleByteEncoding(western)).toBe('windows-1252');
    expect(decodeText(western)).toBe('Café, Zürich – 25 m²');
  });

  it('decodes the windows-1256 fixture identically to the UTF-8 one', () => {
    const a = decodeText(readFixture('consequences-1256.csv'));
    const b = decodeText(readFixture('consequences.csv'));
    expect(a.replace(/\r\n/g, '\n')).toBe(b.replace(/\r\n/g, '\n'));
  });

  it('keeps a BOM-marked file as UTF-8 even with a broken sequence', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0xff, 0x62]))).toBe('a�b');
  });
});
