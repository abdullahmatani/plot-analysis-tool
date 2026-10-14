import fontkit from '@pdf-lib/fontkit';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFObjectCopier,
  PDFPageEmbedder,
  PDFRef,
  PDFStream,
  PDFString,
} from 'pdf-lib';
import type { PDFContext, PDFFont, PDFObject } from 'pdf-lib';

import { multiply, translate } from '@/core/affine';
import type { Affine2D } from '@/core/types';

import { layoutText } from './fonts';
import type { FontSet, LoadedFont, ShapedGlyph } from './fonts';
import { fmt, opacityOf, parseColor } from './format';
import { hatchGeometry } from './hatch';
import { PT_PER_MM, circlePath, paperRotation, pathBounds, walkScene } from './scene';
import type {
  FillStyle,
  GroupItem,
  ImageItem,
  PathCmd,
  PathItem,
  PdfPageItem,
  Scene,
  SceneItem,
  StrokeStyle,
  TextItem,
} from './scene';

/**
 * Vector PDF backend (row 77) built on pdf-lib.
 *
 * - The page content runs in paper millimetres (y-down) under a single base transform
 *   `q 72/25.4 0 0 −72/25.4 0 H cm`, so scene coordinates are written verbatim: a 100 mm line in
 *   the scene is exactly 100 units long in the content stream and exactly 100 mm on paper.
 * - Paths, dashes, opacity (ExtGState CA/ca), even-odd fills and hatches (clip + pattern lines).
 * - Text is drawn as vector glyph outlines from fontkit shaping (Arabic joining, bidi). Each unique
 *   glyph is a Form XObject reused for every occurrence; halos stroke the same outline underneath.
 *   An invisible (Tr 3) text layer with subset-embedded fonts keeps labels searchable.
 * - Source PDF pages are embedded as vector Form XObjects and drawn with the full affine transform;
 *   their own layers are listed under the enclosing layer (`hiddenLayers` export switched off).
 * - Groups with `layer: true` become optional-content groups (OCGs) listed in /OCProperties.
 * - Output is deterministic (no timestamps or random font tags unless `creationDate` is given).
 */

export interface PdfRenderOptions {
  fonts: FontSet;
  /** /Producer entry. */
  producer?: string;
  /** Invisible text layer for search/copy (default true). */
  searchableText?: boolean;
  /** Sets /CreationDate and /ModDate (omitted by default for reproducible output). */
  creationDate?: Date;
  /** Receives non-fatal problems (unreadable source PDF, bad PNG …). */
  onWarning?: (message: string) => void;
  /** Use PDF object streams (smaller files, PDF 1.5+). Default true. */
  useObjectStreams?: boolean;
}

const COORD_DECIMALS = 5;
const MATRIX_DECIMALS = 9;

const c = (n: number) => fmt(n, COORD_DECIMALS);
const mat = (m: Affine2D) => m.map((v) => fmt(v, MATRIX_DECIMALS)).join(' ');

function colorOps(hex: string): string {
  const { r, g, b } = parseColor(hex);
  return `${fmt(r / 255, 4)} ${fmt(g / 255, 4)} ${fmt(b / 255, 4)}`;
}

/** Path construction operators for a scene path. */
export function pdfPathOps(d: readonly PathCmd[]): string {
  const out: string[] = [];
  for (const cmd of d) {
    switch (cmd.op) {
      case 'M':
        out.push(`${c(cmd.x)} ${c(cmd.y)} m`);
        break;
      case 'L':
        out.push(`${c(cmd.x)} ${c(cmd.y)} l`);
        break;
      case 'C':
        out.push(`${c(cmd.x1)} ${c(cmd.y1)} ${c(cmd.x2)} ${c(cmd.y2)} ${c(cmd.x)} ${c(cmd.y)} c`);
        break;
      case 'Z':
        out.push('h');
        break;
    }
  }
  return out.join('\n');
}

interface GState {
  fill?: string;
  stroke?: string;
  lw?: number;
  dash?: string;
  cap?: number;
  join?: number;
  alpha?: string;
}

/** Content-stream builder that tracks graphics state to avoid redundant operators. */
class ContentWriter {
  readonly parts: string[] = [];
  private st: GState;
  private readonly stack: GState[] = [];

  constructor(initial: GState = {}) {
    this.st = { ...initial };
  }

  op(s: string): void {
    this.parts.push(s);
  }

  save(): void {
    this.parts.push('q');
    this.stack.push({ ...this.st });
  }

  restore(): void {
    this.parts.push('Q');
    this.st = this.stack.pop() ?? {};
  }

  fillColor(hex: string): void {
    const ops = colorOps(hex);
    if (this.st.fill !== ops) {
      this.parts.push(`${ops} rg`);
      this.st.fill = ops;
    }
  }

  strokeColor(hex: string): void {
    const ops = colorOps(hex);
    if (this.st.stroke !== ops) {
      this.parts.push(`${ops} RG`);
      this.st.stroke = ops;
    }
  }

  lineWidth(w: number): void {
    if (this.st.lw !== w) {
      this.parts.push(`${c(w)} w`);
      this.st.lw = w;
    }
  }

  dash(dash: readonly number[] | undefined): void {
    const valid =
      dash && dash.length > 0 && dash.every((v) => v >= 0 && Number.isFinite(v)) && dash.some((v) => v > 0);
    const s = valid ? `[${dash.map(c).join(' ')}] 0 d` : '[] 0 d';
    if (this.st.dash !== s) {
      this.parts.push(s);
      this.st.dash = s;
    }
  }

  cap(n: number): void {
    if (this.st.cap !== n) {
      this.parts.push(`${n} J`);
      this.st.cap = n;
    }
  }

  join(n: number): void {
    if (this.st.join !== n) {
      this.parts.push(`${n} j`);
      this.st.join = n;
    }
  }

  alpha(key: string, gsName: () => string): void {
    if (this.st.alpha !== key) {
      this.parts.push(`/${gsName()} gs`);
      this.st.alpha = key;
    }
  }

  toString(): string {
    return this.parts.join('\n');
  }
}

const PDF_DEFAULT_STATE: GState = {
  fill: '0 0 0',
  stroke: '0 0 0',
  lw: 1,
  dash: '[] 0 d',
  cap: 0,
  join: 0,
  alpha: '1|1',
};

/**
 * Disables every substitution/positioning feature so the invisible text layer uses nominal glyphs
 * whose ToUnicode entries map 1:1 to characters (shaped forms such as decomposed Arabic dots have
 * no code points).
 */
const NOMINAL_GLYPHS: Record<string, boolean> = Object.fromEntries(
  [
    'ccmp',
    'locl',
    'rvrn',
    'isol',
    'fina',
    'fin2',
    'fin3',
    'medi',
    'med2',
    'init',
    'rlig',
    'calt',
    'liga',
    'clig',
    'dlig',
    'hlig',
    'mset',
    'rclt',
    'kern',
    'mark',
    'mkmk',
    'curs',
    'dist',
    'abvm',
    'blwm',
    'ltra',
    'ltrm',
    'rtla',
    'rtlm',
    'frac',
    'numr',
    'dnom',
    'stch',
    'cswh',
    'salt',
  ].map((f) => [f, false]),
);

const CAP = { butt: 0, round: 1, square: 2 } as const;
const JOIN = { miter: 0, round: 1, bevel: 2 } as const;

interface TextFontEntry {
  font: PDFFont;
  name: string;
  loaded: LoadedFont;
  /** Per-character hex glyph code and advance at size 1. */
  chars: Map<string, { hex: string; width: number } | null>;
}

interface OcgNode {
  ref: PDFRef;
  res: string;
  children: Map<string, OcgNode>;
  /** Optional-content groups of embedded source pages drawn inside this layer. */
  sourceRefs: PDFRef[];
}

interface SourceOcg {
  ref: PDFRef;
  name: string;
  /** Off by default in the source document. */
  off: boolean;
}

interface PageEmbed {
  name: string;
  ocgs: SourceOcg[];
}

const textOf = (o: PDFObject | undefined): string =>
  o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : '';

/** Names of the OCGs listed in a document's default /OFF array. */
function defaultOffNames(doc: PDFDocument): Set<string> {
  const out = new Set<string>();
  const ctx = doc.context;
  const ocp = ctx.lookup(doc.catalog.get(PDFName.of('OCProperties')));
  const d = ocp instanceof PDFDict ? ctx.lookup(ocp.get(PDFName.of('D'))) : undefined;
  const off = d instanceof PDFDict ? ctx.lookup(d.get(PDFName.of('OFF'))) : undefined;
  if (off instanceof PDFArray) {
    for (const r of off.asArray()) {
      const g = ctx.lookup(r);
      if (g instanceof PDFDict) out.add(textOf(g.get(PDFName.of('Name'))));
    }
  }
  return out;
}

/**
 * Optional-content groups referenced by a (copied) page: /Properties entries (OCGs and OCMD
 * memberships) and /OC entries of XObjects, recursively through nested resources.
 */
function collectOcgs(ctx: PDFContext, page: PDFDict, offNames: Set<string>): SourceOcg[] {
  const out = new Map<string, SourceOcg>();
  const seen = new Set<PDFObject>();
  const addOcg = (obj: PDFObject | undefined): void => {
    if (!(obj instanceof PDFRef)) {
      if (obj instanceof PDFArray) obj.asArray().forEach(addOcg);
      return;
    }
    const d = ctx.lookup(obj);
    if (!(d instanceof PDFDict)) return;
    const type = d.get(PDFName.of('Type'));
    if (type === PDFName.of('OCG')) {
      const name = textOf(d.get(PDFName.of('Name')));
      out.set(obj.toString(), { ref: obj, name, off: offNames.has(name) });
    } else if (type === PDFName.of('OCMD')) addOcg(d.get(PDFName.of('OCGs')));
  };
  const walk = (resources: PDFObject | undefined): void => {
    const r = ctx.lookup(resources);
    if (!(r instanceof PDFDict) || seen.has(r)) return;
    seen.add(r);
    const props = ctx.lookup(r.get(PDFName.of('Properties')));
    if (props instanceof PDFDict) for (const [, v] of props.entries()) addOcg(v);
    const xobjects = ctx.lookup(r.get(PDFName.of('XObject')));
    if (xobjects instanceof PDFDict) {
      for (const [, v] of xobjects.entries()) {
        const x = ctx.lookup(v);
        if (!(x instanceof PDFStream)) continue;
        addOcg(x.dict.get(PDFName.of('OC')));
        walk(x.dict.get(PDFName.of('Resources')));
      }
    }
  };
  walk(page.get(PDFName.of('Resources')));
  return [...out.values()];
}

class PdfSceneRenderer {
  private readonly context: PDFContext;
  private readonly resRef: PDFRef;
  private readonly xobjects: PDFDict;
  private readonly extgstates: PDFDict;
  private readonly fontsDict: PDFDict;
  private readonly properties: PDFDict;
  private readonly gsNames = new Map<string, string>();
  private readonly glyphForms = new Map<string, string>();
  private readonly images = new Map<Uint8Array, string | null>();
  private readonly pageEmbeds = new Map<string, PageEmbed | null>();
  private readonly sourceDocs = new Map<
    Uint8Array,
    Promise<{ doc: PDFDocument; copier: PDFObjectCopier; offNames: Set<string> } | null>
  >();
  private readonly textFonts = new Map<string, TextFontEntry | null>();
  private readonly ocgRoots = new Map<string, OcgNode>();
  private readonly ocgAll: PDFRef[] = [];
  private readonly ocgOff = new Set<PDFRef>();
  private readonly sourceOcgsSeen = new Set<PDFRef>();
  private readonly rootSourceRefs: PDFRef[] = [];
  private bytesIds = new Map<Uint8Array, number>();
  private counter = 0;
  private scene!: Scene;

  constructor(
    private readonly doc: PDFDocument,
    private readonly opts: PdfRenderOptions,
  ) {
    this.context = doc.context;
    this.xobjects = this.context.obj({});
    this.extgstates = this.context.obj({});
    this.fontsDict = this.context.obj({});
    this.properties = this.context.obj({});
    const res = this.context.obj({});
    res.set(PDFName.of('XObject'), this.xobjects);
    res.set(PDFName.of('ExtGState'), this.extgstates);
    res.set(PDFName.of('Font'), this.fontsDict);
    res.set(PDFName.of('Properties'), this.properties);
    this.resRef = this.context.register(res);
  }

  private warn(msg: string): void {
    this.opts.onWarning?.(msg);
  }

  private nextName(prefix: string): string {
    return `${prefix}${this.counter++}`;
  }

  async addPage(scene: Scene): Promise<void> {
    this.scene = scene;
    const wPt = scene.widthMm * PT_PER_MM;
    const hPt = scene.heightMm * PT_PER_MM;
    await this.prepare(scene.items);
    const w = new ContentWriter(PDF_DEFAULT_STATE);
    w.op(`q ${fmt(PT_PER_MM, 12)} 0 0 ${fmt(-PT_PER_MM, 12)} 0 ${fmt(hPt, 9)} cm`);
    if (scene.background) {
      w.fillColor(scene.background);
      w.op(`0 0 ${c(scene.widthMm)} ${c(scene.heightMm)} re f`);
    }
    for (const item of scene.items) this.emit(w, item, null);
    w.op('Q');
    const page = this.doc.addPage([wPt, hPt]);
    page.node.set(PDFName.of('Resources'), this.resRef);
    const content = this.context.register(this.context.flateStream(w.toString()));
    page.node.set(PDFName.of('Contents'), content);
  }

  // ----- asynchronous pre-pass: images and source PDF pages ---------------------------------

  private async prepare(items: readonly SceneItem[]): Promise<void> {
    const tasks: Promise<void>[] = [];
    walkScene(items, (it) => {
      if (it.kind === 'image') tasks.push(this.prepareImage(it.png));
      else if (it.kind === 'pdfPage') {
        tasks.push(
          this.preparePdfPage(it).then(async () => {
            if (!this.pageEmbeds.get(this.pageKey(it)) && it.fallbackPng)
              await this.prepareImage(it.fallbackPng.png);
          }),
        );
      }
    });
    await Promise.all(tasks);
  }

  private async prepareImage(png: Uint8Array): Promise<void> {
    if (this.images.has(png)) return;
    this.images.set(png, null);
    try {
      const img = await this.doc.embedPng(png);
      const name = this.nextName('Im');
      this.xobjects.set(PDFName.of(name), img.ref);
      this.images.set(png, name);
    } catch (e) {
      this.warn(`PNG image could not be embedded: ${(e as Error).message}`);
    }
  }

  private pageKey(it: PdfPageItem): string {
    let id = this.bytesIds.get(it.bytes);
    if (id === undefined) {
      id = this.bytesIds.size;
      this.bytesIds.set(it.bytes, id);
    }
    return `${id}:${it.pageIndex}`;
  }

  private loadSource(bytes: Uint8Array) {
    let p = this.sourceDocs.get(bytes);
    if (!p) {
      p = (async () => {
        try {
          const doc = await PDFDocument.load(bytes, {
            ignoreEncryption: true,
            updateMetadata: false,
            throwOnInvalidObject: false,
          });
          if (doc.isEncrypted) {
            this.warn('Source PDF is encrypted; its pages cannot be embedded as vectors');
            return null;
          }
          return {
            doc,
            copier: PDFObjectCopier.for(doc.context, this.context),
            offNames: defaultOffNames(doc),
          };
        } catch (e) {
          this.warn(`Source PDF could not be parsed: ${(e as Error).message}`);
          return null;
        }
      })();
      this.sourceDocs.set(bytes, p);
    }
    return p;
  }

  private async preparePdfPage(it: PdfPageItem): Promise<void> {
    const key = this.pageKey(it);
    if (this.pageEmbeds.has(key)) return;
    this.pageEmbeds.set(key, null);
    const src = await this.loadSource(it.bytes);
    if (!src) return;
    try {
      const page = src.doc.getPage(it.pageIndex);
      const crop = page.getCropBox();
      // Drop annotations so form fields / links don't drag unrelated objects into the copy.
      const leaf = page.node.clone();
      leaf.delete(PDFName.of('Annots'));
      const copied = src.copier.copy(leaf);
      const box = { left: crop.x, bottom: crop.y, right: crop.x + crop.width, top: crop.y + crop.height };
      // Identity matrix: the form space is the source page's user space, as the scene transform expects.
      const embedder = await PDFPageEmbedder.for(copied, box, [1, 0, 0, 1, 0, 0]);
      const ref = this.context.nextRef();
      await embedder.embedIntoContext(this.context, ref);
      const name = this.nextName('Pg');
      this.xobjects.set(PDFName.of(name), ref);
      this.pageEmbeds.set(key, { name, ocgs: collectOcgs(this.context, copied, src.offNames) });
    } catch (e) {
      this.warn(`PDF page ${it.pageIndex + 1} could not be embedded: ${(e as Error).message}`);
    }
  }

  // ----- resources -----------------------------------------------------------------------------

  private gs(strokeAlpha: number, fillAlpha: number): [string, () => string] {
    const key = `${fmt(strokeAlpha, 4)}|${fmt(fillAlpha, 4)}`;
    return [
      key,
      () => {
        let name = this.gsNames.get(key);
        if (!name) {
          name = this.nextName('GS');
          const ref = this.context.register(
            this.context.obj({
              Type: 'ExtGState',
              CA: Number(fmt(strokeAlpha, 4)),
              ca: Number(fmt(fillAlpha, 4)),
            }),
          );
          this.extgstates.set(PDFName.of(name), ref);
          this.gsNames.set(key, name);
        }
        return name;
      },
    ];
  }

  private setAlpha(w: ContentWriter, strokeAlpha: number, fillAlpha: number): void {
    const [key, name] = this.gs(strokeAlpha, fillAlpha);
    w.alpha(key, name);
  }

  /** Registers a form XObject and returns its resource name. */
  private formXObject(content: string, bbox: [number, number, number, number], group = false): string {
    const dict: Record<string, unknown> = {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: bbox,
      Resources: this.resRef,
    };
    if (group) dict.Group = { Type: 'Group', S: 'Transparency', CS: 'DeviceRGB' };
    const ref = this.context.register(this.context.flateStream(content, dict as never));
    const name = this.nextName('Fx');
    this.xobjects.set(PDFName.of(name), ref);
    return name;
  }

  private glyphForm(font: LoadedFont, glyphId: number, mode: 'fill' | 'stroke'): string | null {
    const key = `${font.key}/${glyphId}/${mode}`;
    const hit = this.glyphForms.get(key);
    if (hit !== undefined) return hit;
    const outline = font.outline(glyphId);
    if (!outline.length) {
      this.glyphForms.set(key, '');
      return null;
    }
    const pad = mode === 'stroke' ? font.unitsPerEm * 4 : font.unitsPerEm * 0.1;
    const fb = font.font.bbox;
    const bbox: [number, number, number, number] = [
      fb.minX - pad,
      fb.minY - pad,
      fb.maxX + pad,
      fb.maxY + pad,
    ];
    const content = `${pdfPathOps(outline)}\n${mode === 'fill' ? 'f' : 'S'}`;
    const ref = this.context.register(
      this.context.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: bbox } as never),
    );
    const name = `G${mode === 'fill' ? 'f' : 's'}${this.counter++}`;
    this.xobjects.set(PDFName.of(name), ref);
    this.glyphForms.set(key, name);
    return name;
  }

  private async textFont(key: string): Promise<TextFontEntry | null> {
    if (this.textFonts.has(key)) return this.textFonts.get(key)!;
    this.textFonts.set(key, null);
    try {
      const loaded = this.opts.fonts.get(key);
      const tag = subsetTag(key);
      const font = await this.doc.embedFont(loaded.bytes, {
        subset: true,
        customName: `${tag}+${loaded.postscriptName}`,
        features: NOMINAL_GLYPHS,
      });
      const name = this.nextName('F');
      this.fontsDict.set(PDFName.of(name), font.ref);
      const entry: TextFontEntry = { font, name, loaded, chars: new Map() };
      this.textFonts.set(key, entry);
      return entry;
    } catch (e) {
      this.warn(`Font ${key} could not be embedded for the text layer: ${(e as Error).message}`);
      return null;
    }
  }

  /**
   * Hex glyph string for the invisible text layer. Each character is encoded on its own with its
   * nominal glyph so the embedded ToUnicode map is exact (shaped ligatures and detached marks have
   * no code points); RTL runs are written in visual order, as viewers expect for extraction.
   */
  private invisibleRun(
    fontKey: string,
    text: string,
    rtl: boolean,
  ): { name: string; hex: string; width: number } | null {
    const entry = this.textFonts.get(fontKey);
    if (!entry || !text.trim()) return null;
    const chars = [...text];
    if (rtl) chars.reverse();
    let hex = '';
    let width = 0;
    for (const ch of chars) {
      let enc = entry.chars.get(ch);
      if (enc === undefined) {
        enc = null;
        const cp = ch.codePointAt(0)!;
        if (cp >= 0x20 && entry.loaded.hasGlyph(cp)) {
          try {
            enc = { hex: entry.font.encodeText(ch).asString(), width: entry.font.widthOfTextAtSize(ch, 1) };
          } catch {
            enc = null;
          }
        }
        entry.chars.set(ch, enc);
      }
      if (!enc) continue;
      hex += enc.hex;
      width += enc.width;
    }
    return hex && width > 0 ? { name: entry.name, hex, width } : null;
  }

  private ocg(name: string, parent: OcgNode | null): OcgNode {
    const siblings = parent ? parent.children : this.ocgRoots;
    let node = siblings.get(name);
    if (!node) {
      const ref = this.context.register(this.context.obj({ Type: 'OCG', Name: PDFHexString.fromText(name) }));
      const res = this.nextName('oc');
      this.properties.set(PDFName.of(res), ref);
      node = { ref, res, children: new Map(), sourceRefs: [] };
      siblings.set(name, node);
      this.ocgAll.push(ref);
    }
    return node;
  }

  /** Lists an embedded page's own layers in /OCProperties, nested under the enclosing layer. */
  private registerSourceOcgs(
    embed: PageEmbed,
    parent: OcgNode | null,
    hidden: readonly string[] | undefined,
  ): void {
    for (const g of embed.ocgs) {
      if (hidden?.includes(g.name) || g.off) this.ocgOff.add(g.ref);
      if (this.sourceOcgsSeen.has(g.ref)) continue;
      this.sourceOcgsSeen.add(g.ref);
      this.ocgAll.push(g.ref);
      (parent ? parent.sourceRefs : this.rootSourceRefs).push(g.ref);
    }
  }

  finish(): void {
    if (!this.ocgAll.length) return;
    const order = (nodes: Map<string, OcgNode>, extra: PDFRef[] = []): unknown[] => {
      const out: unknown[] = [];
      for (const n of nodes.values()) {
        out.push(n.ref);
        if (n.children.size || n.sourceRefs.length) out.push(order(n.children, n.sourceRefs));
      }
      out.push(...extra);
      return out;
    };
    const on = this.ocgAll.filter((r) => !this.ocgOff.has(r));
    const ocProps = this.context.obj({
      OCGs: this.ocgAll,
      D: {
        Name: PDFHexString.fromText('Layers'),
        Order: order(this.ocgRoots, this.rootSourceRefs),
        ON: on,
        OFF: [...this.ocgOff],
        BaseState: 'ON',
        ListMode: 'AllPages',
      },
    } as never);
    this.doc.catalog.set(PDFName.of('OCProperties'), ocProps);
  }

  // ----- emission ----------------------------------------------------------------------------

  private emit(w: ContentWriter, item: SceneItem, ocg: OcgNode | null): void {
    switch (item.kind) {
      case 'path':
        this.emitPath(w, item);
        break;
      case 'text':
        this.emitText(w, item);
        break;
      case 'image':
        this.emitImage(w, item);
        break;
      case 'pdfPage':
        this.emitPdfPage(w, item, ocg);
        break;
      case 'group':
        this.emitGroup(w, item, ocg);
        break;
    }
  }

  private applyStroke(w: ContentWriter, s: StrokeStyle): void {
    w.strokeColor(s.color);
    w.lineWidth(s.width);
    w.dash(s.dash);
    w.cap(CAP[s.cap ?? 'butt']);
    w.join(JOIN[s.join ?? 'miter']);
  }

  private emitPath(w: ContentWriter, it: PathItem): void {
    if (!it.d.length) return;
    const stroke = it.stroke && it.stroke.width > 0 ? it.stroke : undefined;
    const fill = it.fill;
    const fillAlpha = fill ? opacityOf(fill.opacity) : 0;
    const strokeAlpha = stroke ? opacityOf(stroke.opacity) : 1;
    const evenOdd = fill?.rule === 'evenodd';
    const hatch = fill?.hatch && fill.hatch.spacing > 0 ? fill.hatch : undefined;
    const ops = pdfPathOps(it.d);
    if (!hatch && fill && fillAlpha > 0 && stroke) {
      w.fillColor(fill.color);
      this.applyStroke(w, stroke);
      this.setAlpha(w, strokeAlpha, fillAlpha);
      w.op(`${ops}\n${evenOdd ? 'B*' : 'B'}`);
      return;
    }
    if (fill && fillAlpha > 0) {
      w.fillColor(fill.color);
      this.setAlpha(w, strokeAlpha, fillAlpha);
      w.op(`${ops}\n${evenOdd ? 'f*' : 'f'}`);
    }
    if (hatch && fill) this.emitHatch(w, it.d, ops, fill, evenOdd);
    if (stroke) {
      this.applyStroke(w, stroke);
      this.setAlpha(w, strokeAlpha, fillAlpha > 0 ? fillAlpha : 1);
      w.op(`${ops}\nS`);
    }
  }

  private emitHatch(
    w: ContentWriter,
    d: readonly PathCmd[],
    ops: string,
    fill: FillStyle,
    evenOdd: boolean,
  ): void {
    const hatch = fill.hatch!;
    const bounds = pathBounds(d);
    if (!bounds) return;
    const geo = hatchGeometry(hatch.pattern, bounds, hatch.spacing);
    const color = hatch.color ?? fill.color;
    const alpha = opacityOf(hatch.opacity);
    w.save();
    w.op(`${ops}\n${evenOdd ? 'W*' : 'W'} n`);
    this.setAlpha(w, alpha, alpha);
    if (geo.lines.length) {
      w.strokeColor(color);
      w.lineWidth(hatch.lineWidth);
      w.dash(undefined);
      w.cap(0);
      w.op(geo.lines.map(([x1, y1, x2, y2]) => `${c(x1)} ${c(y1)} m ${c(x2)} ${c(y2)} l`).join('\n') + '\nS');
    }
    if (geo.dots.length) {
      w.fillColor(color);
      const r = Math.max(hatch.lineWidth, 0.01);
      w.op(geo.dots.map(([x, y]) => pdfPathOps(circlePath(x, y, r))).join('\n') + '\nf');
    }
    w.restore();
  }

  private emitText(w: ContentWriter, it: TextItem): void {
    if (!it.text || !(it.size > 0)) return;
    const fonts = this.opts.fonts;
    const layout = layoutText(fonts, it.text, {
      size: it.size,
      font: it.font,
      bold: it.bold,
      anchor: it.anchor,
      baseline: it.baseline,
    });
    const glyphs = layout.glyphs.filter((g) => !g.blank);
    const T = multiply(translate(it.x, it.y), paperRotation(it.rotation ?? 0));
    const alpha = opacityOf(it.opacity);
    if (alpha <= 0) return;
    const place = (g: ShapedGlyph): Affine2D => multiply(T, [g.scale, 0, 0, -g.scale, g.x, g.y]);
    w.save();
    this.setAlpha(w, alpha, alpha);
    if (it.halo && it.halo.width > 0 && glyphs.length) {
      w.strokeColor(it.halo.color);
      w.dash(undefined);
      w.join(1);
      w.cap(1);
      for (const g of glyphs) {
        const name = this.glyphForm(fonts.get(g.fontKey), g.glyphId, 'stroke');
        if (name) w.op(`q ${mat(place(g))} cm ${fmt(it.halo.width / g.scale, 4)} w /${name} Do Q`);
      }
    }
    w.fillColor(it.color);
    for (const g of glyphs) {
      const name = this.glyphForm(fonts.get(g.fontKey), g.glyphId, 'fill');
      if (name) w.op(`q ${mat(place(g))} cm /${name} Do Q`);
    }
    if (this.opts.searchableText !== false) {
      for (const run of layout.runs) {
        const enc = this.invisibleRun(run.fontKey, run.text, run.rtl);
        if (!enc) continue;
        const tm = multiply(T, [1, 0, 0, -1, run.x, run.y]);
        const tz = (100 * run.width) / (enc.width * run.size);
        w.op(`BT 3 Tr /${enc.name} ${c(run.size)} Tf ${fmt(tz, 3)} Tz ${mat(tm)} Tm <${enc.hex}> Tj ET`);
      }
    }
    w.restore(); // also restores Tr/Tz (text state is part of the graphics state)
  }

  private emitImage(w: ContentWriter, it: ImageItem): void {
    const name = this.images.get(it.png);
    if (!name || !(it.w !== 0 && it.h !== 0)) return;
    const m = multiply(multiply(translate(it.x, it.y), paperRotation(it.rotation ?? 0)), [
      it.w,
      0,
      0,
      -it.h,
      0,
      it.h,
    ]);
    const alpha = opacityOf(it.opacity);
    if (alpha <= 0) return;
    w.save();
    this.setAlpha(w, alpha, alpha);
    w.op(`${mat(m)} cm /${name} Do`);
    w.restore();
  }

  private emitPdfPage(w: ContentWriter, it: PdfPageItem, ocg: OcgNode | null): void {
    const embed = this.pageEmbeds.get(this.pageKey(it));
    const alpha = opacityOf(it.opacity);
    if (alpha <= 0) return;
    if (!embed) {
      if (it.fallbackPng) {
        const f = it.fallbackPng;
        this.emitImage(w, { kind: 'image', x: f.x, y: f.y, w: f.w, h: f.h, png: f.png, opacity: it.opacity });
      }
      return;
    }
    this.registerSourceOcgs(embed, ocg, it.hiddenLayers);
    const draw = `q ${mat(it.transform)} cm /${embed.name} Do Q`;
    w.save();
    if (alpha < 1) {
      // Wrap in a transparency group so the page's own ExtGStates cannot override the opacity.
      const form = this.formXObject(draw, [0, 0, this.scene.widthMm, this.scene.heightMm], true);
      this.setAlpha(w, alpha, alpha);
      w.op(`/${form} Do`);
    } else {
      w.op(draw);
    }
    w.restore();
  }

  private emitGroup(w: ContentWriter, g: GroupItem, parentOcg: OcgNode | null): void {
    const alpha = opacityOf(g.opacity);
    if (alpha <= 0) return;
    const ocg = g.layer ? this.ocg(g.name, parentOcg) : null;
    const childOcg = ocg ?? parentOcg;
    if (ocg) w.op(`/OC /${ocg.res} BDC`);
    w.save();
    if (g.clip && g.clip.length) w.op(`${pdfPathOps(g.clip)}\nW n`);
    if (alpha < 1) {
      const sub = new ContentWriter();
      for (const child of g.children) this.emit(sub, child, childOcg);
      const form = this.formXObject(sub.toString(), [0, 0, this.scene.widthMm, this.scene.heightMm], true);
      this.setAlpha(w, alpha, alpha);
      w.op(`/${form} Do`);
    } else {
      for (const child of g.children) this.emit(w, child, childOcg);
    }
    w.restore();
    if (ocg) w.op('EMC');
  }

  /** Embeds the fonts needed by the invisible text layer (before emission). */
  async prepareTextFonts(scene: Scene): Promise<void> {
    if (this.opts.searchableText === false) return;
    const keys = new Set<string>();
    walkScene(scene.items, (it) => {
      if (it.kind !== 'text' || !it.text.trim()) return;
      const l = layoutText(this.opts.fonts, it.text, { size: 1, font: it.font, bold: it.bold });
      for (const r of l.runs) if (r.text.trim()) keys.add(r.fontKey);
    });
    for (const k of [...keys].sort()) await this.textFont(k);
  }
}

/** Deterministic 6-letter subset tag derived from the font key. */
function subsetTag(key: string): string {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619) >>> 0;
  let tag = '';
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (h % 26));
    h = Math.floor(h / 26) + i * 7;
  }
  return tag;
}

/** Renders several scenes as consecutive pages of one PDF (layers are shared by name). */
export async function renderScenesPdf(scenes: readonly Scene[], opts: PdfRenderOptions): Promise<Uint8Array> {
  if (!scenes.length) throw new Error('renderScenesPdf: no scenes');
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  const meta = scenes[0].meta ?? {};
  if (meta.title) doc.setTitle(meta.title);
  if (meta.author) doc.setAuthor(meta.author);
  if (meta.subject) doc.setSubject(meta.subject);
  doc.setCreator(meta.creator ?? 'Plot Analysis Tool');
  doc.setProducer(opts.producer ?? 'Plot Analysis Tool');
  if (opts.creationDate) {
    doc.setCreationDate(opts.creationDate);
    doc.setModificationDate(opts.creationDate);
  }
  const r = new PdfSceneRenderer(doc, opts);
  for (const scene of scenes) {
    if (!(scene.widthMm > 0 && scene.heightMm > 0)) throw new Error('Scene size must be positive');
    await r.prepareTextFonts(scene);
    await r.addPage(scene);
  }
  r.finish();
  return doc.save({ useObjectStreams: opts.useObjectStreams ?? true });
}

/** Renders a scene to a single-page vector PDF. */
export function renderScenePdf(scene: Scene, opts: PdfRenderOptions): Promise<Uint8Array> {
  return renderScenesPdf([scene], opts);
}
