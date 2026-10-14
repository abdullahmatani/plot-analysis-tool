import { describe, expect, it } from 'vitest';

import { canvasSizeForDpi, decodeSceneImages, renderSceneCanvas } from './canvas-backend';
import type { Canvas2D } from './canvas-backend';
import { SceneBuilder, rectPath } from './scene';
import type { SceneItem } from './scene';
import { testFontSet } from './test-fonts';
import { makePng } from './test-png';

type Call = { name: string; args: unknown[]; state: Record<string, unknown> };

/** Minimal recording CanvasRenderingContext2D: logs calls with a snapshot of the drawing state. */
class RecordingContext {
  calls: Call[] = [];
  globalAlpha = 1;
  fillStyle: unknown = '#000000';
  strokeStyle: unknown = '#000000';
  lineWidth = 1;
  lineCap = 'butt';
  lineJoin = 'miter';
  miterLimit = 10;
  lineDashOffset = 0;
  font = '10px sans-serif';
  textAlign = 'start';
  textBaseline = 'alphabetic';
  direction = 'inherit';
  private dash: number[] = [];
  private matrix: number[] = [1, 0, 0, 1, 0, 0];
  private stack: { matrix: number[]; state: Record<string, unknown> }[] = [];

  private snapshot(): Record<string, unknown> {
    return {
      globalAlpha: this.globalAlpha,
      fillStyle: this.fillStyle,
      strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth,
      lineCap: this.lineCap,
      lineJoin: this.lineJoin,
      font: this.font,
      textAlign: this.textAlign,
      direction: this.direction,
      dash: [...this.dash],
      matrix: [...this.matrix],
    };
  }
  private rec(name: string, args: unknown[]) {
    this.calls.push({ name, args, state: this.snapshot() });
  }
  private mul(m: number[]) {
    const [a1, b1, c1, d1, e1, f1] = this.matrix;
    const [a2, b2, c2, d2, e2, f2] = m;
    this.matrix = [
      a1 * a2 + c1 * b2,
      b1 * a2 + d1 * b2,
      a1 * c2 + c1 * d2,
      b1 * c2 + d1 * d2,
      a1 * e2 + c1 * f2 + e1,
      b1 * e2 + d1 * f2 + f1,
    ];
  }
  save() {
    this.stack.push({ matrix: [...this.matrix], state: this.snapshot() });
    this.rec('save', []);
  }
  restore() {
    const s = this.stack.pop()!;
    this.matrix = s.matrix;
    Object.assign(this, { ...s.state, dash: s.state.dash });
    this.rec('restore', []);
  }
  scale(x: number, y: number) {
    this.mul([x, 0, 0, y, 0, 0]);
    this.rec('scale', [x, y]);
  }
  translate(x: number, y: number) {
    this.mul([1, 0, 0, 1, x, y]);
    this.rec('translate', [x, y]);
  }
  rotate(a: number) {
    this.mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
    this.rec('rotate', [a]);
  }
  transform(...m: number[]) {
    this.mul(m);
    this.rec('transform', m);
  }
  setLineDash(d: number[]) {
    this.dash = [...d];
    this.rec('setLineDash', [d]);
  }
  getLineDash() {
    return this.dash;
  }
}
for (const name of [
  'beginPath',
  'moveTo',
  'lineTo',
  'bezierCurveTo',
  'closePath',
  'arc',
  'fill',
  'stroke',
  'clip',
  'fillRect',
  'fillText',
  'strokeText',
  'drawImage',
]) {
  (RecordingContext.prototype as unknown as Record<string, unknown>)[name] = function (
    this: RecordingContext,
    ...args: unknown[]
  ) {
    (this as unknown as { rec: (n: string, a: unknown[]) => void }).rec(name, args);
  };
}

const mock = () => new RecordingContext();
const asCtx = (m: RecordingContext) => m as unknown as Canvas2D;
const names = (m: RecordingContext) => m.calls.map((c) => c.name);

describe('renderSceneCanvas', () => {
  it('scales mm to pixels and draws background, fills, strokes and dashes', () => {
    const m = mock();
    const scene = new SceneBuilder(100, 50, { background: '#ffffff' })
      .path(
        rectPath(10, 10, 20, 20),
        { color: '#ff0000', width: 0.5, dash: [2, 1], cap: 'round', opacity: 0.5 },
        { color: '#00ff00', opacity: 0.25, rule: 'evenodd' },
      )
      .build();
    renderSceneCanvas(asCtx(m), scene, 4);
    expect(m.calls[0]).toMatchObject({ name: 'save' });
    expect(m.calls[1]).toMatchObject({ name: 'scale', args: [4, 4] });
    const bg = m.calls.find((c) => c.name === 'fillRect')!;
    expect(bg.args).toEqual([0, 0, 100, 50]);
    expect(bg.state.fillStyle).toBe('#ffffff');
    const fill = m.calls.find((c) => c.name === 'fill')!;
    expect(fill.args).toEqual(['evenodd']);
    expect(fill.state.globalAlpha).toBe(0.25);
    expect(fill.state.fillStyle).toBe('#00ff00');
    const stroke = m.calls.find((c) => c.name === 'stroke')!;
    expect(stroke.state).toMatchObject({
      strokeStyle: '#ff0000',
      lineWidth: 0.5,
      lineCap: 'round',
      globalAlpha: 0.5,
      dash: [2, 1],
    });
    expect(names(m).at(-1)).toBe('restore');
  });

  it('draws hatches with clip + lines and dots', () => {
    const m = mock();
    const scene = new SceneBuilder(100, 100)
      .path(
        rectPath(0, 0, 20, 20),
        { color: '#000000', width: 0.2 },
        { color: '#ff0000', opacity: 0, hatch: { pattern: 'diagonal', spacing: 2, lineWidth: 0.1 } },
      )
      .path(rectPath(30, 0, 20, 20), undefined, {
        color: '#0000ff',
        opacity: 0,
        hatch: { pattern: 'dots', spacing: 5, lineWidth: 0.3 },
      })
      .build();
    renderSceneCanvas(asCtx(m), scene, 2);
    const n = names(m);
    expect(n.filter((x) => x === 'clip')).toHaveLength(2);
    expect(n.filter((x) => x === 'fill')).toHaveLength(1); // dots only (tint opacity 0)
    expect(m.calls.filter((c) => c.name === 'arc')).toHaveLength(25);
    const hatchStroke = m.calls.find((c) => c.name === 'stroke')!;
    expect(hatchStroke.state).toMatchObject({ strokeStyle: '#ff0000', lineWidth: 0.1 });
    expect(m.calls.filter((c) => c.name === 'moveTo').length).toBeGreaterThan(20);
  });

  it('draws text with fillText, physical alignment, direction and halo in device pixels', () => {
    const m = mock();
    const scene = new SceneBuilder(100, 100)
      .text('منطقة الخطر 15 م', 50, 50, {
        size: 5,
        anchor: 'start',
        baseline: 'top',
        halo: { color: '#ffffff', width: 1 },
        rotation: Math.PI / 2,
      })
      .text('one\ntwo', 10, 10, { size: 2, anchor: 'end', bold: true, font: 'mono' })
      .build();
    renderSceneCanvas(asCtx(m), scene, 10);
    const texts = m.calls.filter((c) => c.name === 'fillText');
    expect(texts.map((t) => t.args[0])).toEqual(['منطقة الخطر 15 م', 'one', 'two']);
    expect(texts[0].state).toMatchObject({ direction: 'rtl', textAlign: 'left' });
    expect(texts[0].state.font).toBe("50px 'Noto Sans', 'Noto Sans Arabic', sans-serif");
    expect(texts[0].args[2]).toBeCloseTo(5 * 1.069 * 10, 9); // 'top' → baseline one ascent down, in px
    // net transform: scale 10 · translate(50,50) · rotate(−90°) · scale(1/10)
    const mtx = texts[0].state.matrix as number[];
    expect(mtx[0]).toBeCloseTo(0, 9);
    expect(mtx[1]).toBeCloseTo(-1, 9);
    expect(mtx[4]).toBeCloseTo(500, 9);
    const halo = m.calls.find((c) => c.name === 'strokeText')!;
    expect(halo.state).toMatchObject({ strokeStyle: '#ffffff', lineWidth: 10, lineJoin: 'round' });
    expect(texts[1].state).toMatchObject({ direction: 'ltr', textAlign: 'right' });
    expect(texts[1].state.font).toContain('bold 20px');
    expect((texts[2].args[2] as number) - (texts[1].args[2] as number)).toBeCloseTo(2 * 1.2 * 10, 9);
  });

  it('draws text as glyph outlines when fonts are supplied', () => {
    const m = mock();
    const scene = new SceneBuilder(100, 100)
      .text('Hi', 10, 10, { size: 3, halo: { color: '#ffffff', width: 0.5 } })
      .build();
    renderSceneCanvas(asCtx(m), scene, 3, { fonts: testFontSet(), textAsPaths: true });
    expect(names(m)).not.toContain('fillText');
    expect(m.calls.filter((c) => c.name === 'bezierCurveTo').length).toBeGreaterThan(4);
    expect(m.calls.find((c) => c.name === 'stroke')!.state.lineWidth).toBe(0.5);
  });

  it('draws images, placed PDF page rasters and fallbacks; skips undecoded images', () => {
    const png = makePng(1, 1, () => [0, 0, 0, 255]);
    const fb = makePng(1, 1, () => [255, 0, 0, 255]);
    const scene = new SceneBuilder(100, 100)
      .image(10, 10, 20, 10, png, { rotation: 0.5, opacity: 0.5 })
      .image(10, 10, 20, 10, new Uint8Array([1])) // not in cache
      .pdfPage(new Uint8Array([9]), 0, [1, 0, 0, 1, 0, 0], {
        fallbackPng: { png: fb, x: 0, y: 0, w: 50, h: 40 },
      })
      .pdfPage(new Uint8Array([9]), 1, [1, 0, 0, 1, 0, 0])
      .build();
    const img = { tag: 'bitmap' } as unknown as CanvasImageSource;
    const fbImg = { tag: 'fallback' } as unknown as CanvasImageSource;
    const pageImg = { tag: 'page' } as unknown as CanvasImageSource;
    const pdfPageImages = new Map<
      SceneItem,
      | CanvasImageSource
      | { image: CanvasImageSource; transform: [number, number, number, number, number, number] }
    >();
    pdfPageImages.set(scene.items[3], { image: pageImg, transform: [0.1, 0, 0, 0.1, 5, 5] });
    const m = mock();
    renderSceneCanvas(asCtx(m), scene, 2, {
      imageCache: new Map([
        [png, img],
        [fb, fbImg],
      ]),
      pdfPageImages,
    });
    const draws = m.calls.filter((c) => c.name === 'drawImage');
    expect(draws.map((d) => (d.args[0] as { tag: string }).tag)).toEqual(['bitmap', 'fallback', 'page']);
    expect(draws[0].args.slice(1)).toEqual([0, 0, 20, 10]);
    expect(draws[0].state.globalAlpha).toBe(0.5);
    expect(draws[1].args.slice(1)).toEqual([0, 0, 50, 40]);
    expect(m.calls.find((c) => c.name === 'transform')!.args).toEqual([0.1, 0, 0, 0.1, 5, 5]);
  });

  it('applies group clips and multiplies group opacity', () => {
    const m = mock();
    const scene = new SceneBuilder(100, 100)
      .group('g', { opacity: 0.5, clip: rectPath(0, 0, 10, 10) }, (b) =>
        b.path(rectPath(1, 1, 2, 2), undefined, { color: '#000000', opacity: 0.5 }),
      )
      .group('hidden', { opacity: 0 }, (b) => b.path(rectPath(1, 1, 2, 2), undefined, { color: '#000000' }))
      .build();
    renderSceneCanvas(asCtx(m), scene, 1);
    expect(m.calls.find((c) => c.name === 'clip')!.args).toEqual(['nonzero']);
    const fills = m.calls.filter((c) => c.name === 'fill');
    expect(fills).toHaveLength(1);
    expect(fills[0].state.globalAlpha).toBe(0.25);
    expect(() => renderSceneCanvas(asCtx(mock()), scene, 0)).toThrow();
  });
});

describe('helpers', () => {
  it('canvasSizeForDpi', () => {
    const s = new SceneBuilder(841, 594).build(); // A1
    expect(canvasSizeForDpi(s, 300)).toMatchObject({ width: 9933, height: 7016 });
  });

  it('decodeSceneImages decodes each distinct PNG once and skips failures', async () => {
    const a = makePng(1, 1, () => [0, 0, 0, 255]);
    const bad = new Uint8Array([0]);
    const scene = new SceneBuilder(10, 10)
      .image(0, 0, 1, 1, a)
      .image(0, 0, 1, 1, a)
      .image(0, 0, 1, 1, bad)
      .pdfPage(new Uint8Array([1]), 0, [1, 0, 0, 1, 0, 0], {
        fallbackPng: { png: a, x: 0, y: 0, w: 1, h: 1 },
      })
      .build();
    let calls = 0;
    const out = await decodeSceneImages(scene, async (png) => {
      calls++;
      if (png === bad) throw new Error('bad');
      return { w: png.length } as unknown as CanvasImageSource;
    });
    expect(calls).toBe(2);
    expect(out.size).toBe(1);
    expect(out.has(a)).toBe(true);
  });
});
