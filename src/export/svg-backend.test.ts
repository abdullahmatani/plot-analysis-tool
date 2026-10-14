import { describe, expect, it } from 'vitest';

import { INKSCAPE_NS, SVG_NS, XLINK_NS, renderSceneSvg, svgPathData } from './svg-backend';
import { SceneBuilder, rectPath } from './scene';
import { testFontSet } from './test-fonts';
import { makePng } from './test-png';

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
  text: string;
}

/**
 * Tiny XML well-formedness checker/parser: balanced tags, quoted unique attributes, valid entity
 * references, a single root element, no stray '<' or '&'. Throws on the first problem.
 */
function parseXml(src: string): XmlElement {
  let i = 0;
  const fail = (msg: string): never => {
    throw new Error(`${msg} at offset ${i}: ${JSON.stringify(src.slice(i, i + 40))}`);
  };
  const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;
  const checkText = (t: string) => {
    if (t.includes('<')) fail('raw < in text');
    const amp = /&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.exec(t);
    if (amp) fail('bad entity reference');
    return t
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
      .replace(/&amp;/g, '&');
  };
  const skipMisc = () => {
    for (;;) {
      while (/\s/.test(src[i] ?? '')) i++;
      if (src.startsWith('<?', i)) {
        const e = src.indexOf('?>', i);
        if (e < 0) fail('unterminated PI');
        i = e + 2;
      } else if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i);
        if (e < 0) fail('unterminated comment');
        if (src.slice(i + 4, e).includes('--')) fail('-- inside comment');
        i = e + 3;
      } else return;
    }
  };
  const parseElement = (): XmlElement => {
    if (src[i] !== '<') fail('expected <');
    i++;
    const m = NAME.exec(src.slice(i));
    if (!m) fail('bad element name');
    const el: XmlElement = { name: m![0], attrs: {}, children: [], text: '' };
    i += m![0].length;
    for (;;) {
      while (/\s/.test(src[i])) i++;
      if (src.startsWith('/>', i)) {
        i += 2;
        return el;
      }
      if (src[i] === '>') {
        i++;
        break;
      }
      const am = NAME.exec(src.slice(i));
      if (!am) fail('bad attribute name');
      i += am![0].length;
      if (src[i] !== '=') fail('expected =');
      i++;
      const q = src[i];
      if (q !== '"' && q !== "'") fail('unquoted attribute');
      const end = src.indexOf(q, i + 1);
      if (end < 0) fail('unterminated attribute');
      if (am![0] in el.attrs) fail('duplicate attribute');
      el.attrs[am![0]] = checkText(src.slice(i + 1, end));
      i = end + 1;
    }
    for (;;) {
      const lt = src.indexOf('<', i);
      if (lt < 0) fail('unterminated element ' + el.name);
      el.text += checkText(src.slice(i, lt));
      i = lt;
      if (src.startsWith('</', i)) {
        const close = `</${el.name}>`;
        if (!src.startsWith(close, i)) fail(`mismatched close tag for ${el.name}`);
        i += close.length;
        return el;
      }
      if (src.startsWith('<!--', i)) {
        const e = src.indexOf('-->', i);
        if (e < 0) fail('unterminated comment');
        i = e + 3;
        continue;
      }
      el.children.push(parseElement());
    }
  };
  skipMisc();
  const root = parseElement();
  skipMisc();
  if (i !== src.length) fail('content after root element');
  return root;
}

function findAll(el: XmlElement, pred: (e: XmlElement) => boolean, out: XmlElement[] = []): XmlElement[] {
  if (pred(el)) out.push(el);
  for (const c of el.children) findAll(c, pred, out);
  return out;
}

const black = { color: '#000000', width: 0.25 };

function demoScene() {
  const png = makePng(3, 3, (x, y) => [x * 80, y * 80, 0, 255]);
  return new SceneBuilder(420, 297, {
    background: '#ffffff',
    meta: { title: 'Plot <A> & "B"', author: 'Q&A', subject: 'Test' },
  })
    .layer('Underlay', (b) =>
      b
        .pdfPage(new Uint8Array([1]), 0, [1, 0, 0, 1, 0, 0], {
          fallbackPng: { png, x: 0, y: 0, w: 100, h: 50 },
        })
        .pdfPage(new Uint8Array([2]), 1, [1, 0, 0, 1, 0, 0]),
    )
    .layer('Analysis & "zones" <1>', (b) => {
      b.path(
        rectPath(10, 10, 50, 50),
        { color: '#ff0000', width: 0.5, dash: [2, 1], opacity: 0.5, cap: 'round', join: 'bevel' },
        { color: '#ff0000', opacity: 0.2, rule: 'evenodd' },
      );
      b.path(rectPath(70, 10, 50, 50), black, {
        color: '#00ff00',
        opacity: 0,
        hatch: { pattern: 'diagonal', spacing: 2, lineWidth: 0.1 },
      });
      b.path(rectPath(130, 10, 50, 50), black, {
        color: '#0000ff',
        opacity: 0.1,
        hatch: { pattern: 'dots', spacing: 2, lineWidth: 0.2, color: '#000000' },
      });
      b.path(rectPath(190, 10, 50, 50), black, {
        color: '#00ff00',
        opacity: 0,
        hatch: { pattern: 'diagonal', spacing: 2, lineWidth: 0.1 },
      }); // reuses pattern
      b.layer('Sub layer', (s) => s.circle(100, 100, 10, black));
    })
    .group('clipped', { clip: rectPath(0, 0, 100, 100), opacity: 0.5 }, (b) =>
      b.image(5, 5, 20, 20, png, { rotation: Math.PI / 4, opacity: 0.7 }),
    )
    .layer('Labels', (b) => {
      b.text('منطقة الخطر 15 م', 100, 150, {
        size: 5,
        anchor: 'start',
        baseline: 'middle',
        halo: { color: '#ffffff', width: 0.8 },
      });
      b.text('Line 1 <&>\nLine 2', 50, 200, {
        size: 3,
        anchor: 'end',
        bold: true,
        rotation: Math.PI / 6,
        opacity: 0.9,
      });
      b.text('  spaced  ', 10, 280, { size: 2, font: 'mono' });
    })
    .build();
}

describe('renderSceneSvg', () => {
  it('produces well-formed XML with mm sizing and Inkscape layers', () => {
    const svg = renderSceneSvg(demoScene());
    const root = parseXml(svg);
    expect(root.name).toBe('svg');
    expect(root.attrs.xmlns).toBe(SVG_NS);
    expect(root.attrs['xmlns:inkscape']).toBe(INKSCAPE_NS);
    expect(root.attrs['xmlns:xlink']).toBe(XLINK_NS);
    expect(root.attrs.width).toBe('420mm');
    expect(root.attrs.height).toBe('297mm');
    expect(root.attrs.viewBox).toBe('0 0 420 297');
    const layers = findAll(root, (e) => e.name === 'g' && e.attrs['inkscape:groupmode'] === 'layer');
    expect(layers.map((l) => l.attrs['inkscape:label'])).toEqual([
      'Underlay',
      'Analysis & "zones" <1>',
      'Sub layer',
      'Labels',
    ]);
    const ids = findAll(root, (e) => 'id' in e.attrs).map((e) => e.attrs.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z_][A-Za-z0-9_.-]*$/);
    expect(findAll(root, (e) => e.name === 'title')[0].text).toBe('Plot <A> & "B"');
  });

  it('contains no http(s) URLs other than the namespace URIs', () => {
    const svg = renderSceneSvg(demoScene(), { fonts: testFontSet() });
    const urls = svg.match(/https?:\/\/[^\s"'<>]+/g) ?? [];
    expect(new Set(urls)).toEqual(new Set([SVG_NS, XLINK_NS, INKSCAPE_NS]));
    // every url(#…) reference resolves to a local id
    const root = parseXml(svg);
    const ids = new Set(findAll(root, (e) => 'id' in e.attrs).map((e) => e.attrs.id));
    for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) expect(ids.has(m[1])).toBe(true);
  });

  it('writes paths, dashes, opacity, even-odd and hatch patterns', () => {
    const root = parseXml(renderSceneSvg(demoScene()));
    const paths = findAll(root, (e) => e.name === 'path');
    const dashed = paths.find((p) => p.attrs['stroke-dasharray'])!;
    expect(dashed.attrs['stroke-dasharray']).toBe('2 1');
    expect(dashed.attrs['fill-rule']).toBe('evenodd');
    expect(dashed.attrs['fill-opacity']).toBe('0.2');
    expect(dashed.attrs['stroke-opacity']).toBe('0.5');
    expect(dashed.attrs['stroke-linecap']).toBe('round');
    expect(dashed.attrs['stroke-miterlimit']).toBe('10');
    const patterns = findAll(root, (e) => e.name === 'pattern');
    expect(patterns).toHaveLength(2); // diagonal reused, dots
    expect(patterns[0].attrs.patternTransform).toBe('rotate(45)');
    expect(patterns[0].attrs.patternUnits).toBe('userSpaceOnUse');
    expect(findAll(patterns[1], (e) => e.name === 'circle')).toHaveLength(4);
    const hatchFills = paths.filter((p) => p.attrs.fill?.startsWith('url(#'));
    expect(hatchFills).toHaveLength(3);
    expect(findAll(root, (e) => e.name === 'clipPath')).toHaveLength(1);
  });

  it('embeds images as data URIs and uses PDF fallbacks', () => {
    const svg = renderSceneSvg(demoScene());
    const root = parseXml(svg);
    const images = findAll(root, (e) => e.name === 'image');
    expect(images).toHaveLength(2);
    for (const im of images)
      expect(im.attrs['xlink:href']).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/);
    expect(images[1].attrs.transform).toBe('rotate(-45 5 5)');
    expect(svg).toContain('PDF page 2 omitted');
    // base64 decodes back to the PNG signature
    const b64 = images[0].attrs['xlink:href'].split(',')[1];
    expect(Buffer.from(b64, 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('writes text with direction, physical anchors, halo and escaping', () => {
    const root = parseXml(renderSceneSvg(demoScene()));
    const texts = findAll(root, (e) => e.name === 'text');
    const arabic = texts.filter((t) => t.text.includes('منطقة'));
    expect(arabic).toHaveLength(2); // halo + fill
    expect(arabic[0].attrs.stroke).toBe('#ffffff');
    expect(arabic[1].attrs.direction).toBe('rtl');
    expect(arabic[1].attrs['text-anchor']).toBe('end'); // physical left end of RTL text
    const latin = texts.filter((t) => t.text.startsWith('Line'));
    expect(latin.map((t) => t.text)).toEqual(['Line 1 <&>', 'Line 2']);
    expect(latin[0].attrs['text-anchor']).toBe('end');
    expect(Number(latin[1].attrs.y) - Number(latin[0].attrs.y)).toBeCloseTo(3.6, 9);
    const groups = findAll(root, (e) => e.name === 'g' && (e.attrs.transform ?? '').includes('rotate(-30)'));
    expect(groups).toHaveLength(1);
    expect(groups[0].attrs['font-family']).toContain('Noto Sans Arabic');
    expect(groups[0].attrs['font-weight']).toBe('bold');
    expect(texts.find((t) => t.text === '  spaced  ')).toBeDefined();
  });

  it('centres RTL lines on their measured middle when fonts are available', () => {
    const fonts = testFontSet();
    const scene = new SceneBuilder(100, 100)
      .text('نص عربي', 50, 50, { size: 4, anchor: 'start' })
      .text('نص', 50, 60, { size: 4, anchor: 'middle' })
      .build();
    const texts = findAll(parseXml(renderSceneSvg(scene, { fonts })), (e) => e.name === 'text');
    expect(texts[0].attrs['text-anchor']).toBe('middle');
    expect(Number(texts[0].attrs.x)).toBeGreaterThan(5); // half the measured width, right of the anchor
    expect(texts[1].attrs['text-anchor']).toBe('middle');
    expect(texts[1].attrs.x).toBe('0');
  });

  it('can draw hatches as clipped lines instead of patterns', () => {
    const scene = new SceneBuilder(100, 100)
      .path(rectPath(10, 10, 30, 30), black, {
        color: '#ff0000',
        opacity: 0,
        rule: 'evenodd',
        hatch: { pattern: 'back-diagonal', spacing: 2, lineWidth: 0.2 },
      })
      .path(rectPath(50, 10, 30, 30), undefined, {
        color: '#ff0000',
        opacity: 0.2,
        hatch: { pattern: 'dots', spacing: 3, lineWidth: 0.2, opacity: 0.5 },
      })
      .build();
    const root = parseXml(renderSceneSvg(scene, { hatch: 'lines' }));
    expect(findAll(root, (e) => e.name === 'pattern')).toHaveLength(0);
    const clips = findAll(root, (e) => e.name === 'clipPath');
    expect(clips).toHaveLength(2);
    expect(clips[0].children[0].attrs['clip-rule']).toBe('evenodd');
    const clipped = findAll(root, (e) => e.name === 'g' && !!e.attrs['clip-path']);
    expect(clipped).toHaveLength(2);
    expect(clipped[0].children[0].attrs.d.split('M').length - 1).toBeGreaterThan(20);
    expect(clipped[1].attrs.opacity).toBe('0.5');
  });

  it('can draw text as glyph outlines', () => {
    const svg = renderSceneSvg(demoScene(), { fonts: testFontSet(), textAsPaths: true });
    const root = parseXml(svg);
    expect(findAll(root, (e) => e.name === 'text')).toHaveLength(0);
    const labelled = findAll(root, (e) => e.name === 'g' && e.attrs['aria-label'] !== undefined);
    expect(labelled.map((g) => g.attrs['aria-label'])).toContain('منطقة الخطر 15 م');
    const glyphPaths = findAll(labelled[0], (e) => e.name === 'path');
    expect(glyphPaths).toHaveLength(2); // halo + fill
    expect(glyphPaths[1].attrs.d.length).toBeGreaterThan(200);
  });

  it('formats path data compactly without exponents', () => {
    expect(
      svgPathData([
        { op: 'M', x: 1e-9, y: 123456789.123456 },
        { op: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: -0.00001 },
        { op: 'Z' },
      ]),
    ).toBe('M0 123456789.1235C1 2 3 4 5 0Z');
  });
});
