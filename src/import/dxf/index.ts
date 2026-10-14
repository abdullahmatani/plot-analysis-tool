import {
  EntityStoreBuilder,
  emptyReport,
  storeExtents,
  type DrawingParseResult,
} from '@/underlay/entity-store';
import { buildDocument, type DxfBlock, type DxfDocument } from './document';
import { detectEncoding, makeDecoder } from './encoding';
import { Emitter } from './emit';
import { DxfAbortError, DxfParseError } from './errors';
import { BINARY_SENTINEL, recNum, recStr, tokenizeAscii, tokenizeBinary, type Rec } from './tokenizer';

export { DxfAbortError, DxfParseError } from './errors';

/** Options for {@link parseDxf}. */
export interface ParseDxfOptions {
  /** Paper-space layout name; default (undefined, "Model") parses model space. */
  layout?: string;
  onProgress?: (fraction: number) => void;
  /** Checked periodically; when set, parsing stops with DxfAbortError. */
  signal?: { aborted: boolean };
}

/** True when the bytes start with the binary DXF sentinel "AutoCAD Binary DXF\r\n\x1a\0". */
export function isBinaryDxf(bytes: Uint8Array): boolean {
  if (bytes.length < BINARY_SENTINEL.length) return false;
  for (let i = 0; i < BINARY_SENTINEL.length; i++)
    if (bytes[i] !== BINARY_SENTINEL.charCodeAt(i)) return false;
  return true;
}

const ASCII_DXF_RE = /^\s*(?:999[ \t]*\r?\n[^\r\n]*\r?\n\s*)*0[ \t]*\r?\n[ \t]*SECTION[ \t]*\r?\n/i;

/** True when the bytes look like an ASCII or binary DXF file (type detection by signature, row 13). */
export function sniffDxf(bytes: Uint8Array): boolean {
  if (isBinaryDxf(bytes)) return true;
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const end = Math.min(bytes.length, start + 4096);
  let head = '';
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    head += String.fromCharCode(b);
  }
  return ASCII_DXF_RE.test(head);
}

/** Share of the progress bar per phase: tokenizing, section structure, entity conversion. */
const PROGRESS_TOKENIZE = 0.65;
const PROGRESS_STRUCTURE = 0.02;
const PROGRESS_EMIT_START = PROGRESS_TOKENIZE + PROGRESS_STRUCTURE;

interface LayoutInfo {
  name: string;
  kind: 'model' | 'active-paper' | 'block';
  block?: DxfBlock;
}

function layoutInfos(doc: DxfDocument): LayoutInfo[] {
  const t = doc.tags;
  const recordName = new Map<string, string>();
  for (const r of doc.tables.get('BLOCK_RECORD') ?? []) {
    recordName.set(recStr(t, r, 5).trim().toUpperCase(), recStr(t, r, 2).trim());
  }
  const out: LayoutInfo[] = [{ name: 'Model', kind: 'model' }];
  const seen = new Set(['MODEL']);
  const papers = doc.layouts
    .filter((l) => l.name && l.name.toUpperCase() !== 'MODEL')
    .sort((a, b) => a.tabOrder - b.tabOrder);
  let haveActive = false;
  for (const l of papers) {
    const key = l.name.toUpperCase();
    if (seen.has(key)) continue;
    const blockName = (recordName.get(l.blockRecord) ?? '').toUpperCase();
    if (blockName === '*PAPER_SPACE' && !haveActive) {
      out.push({ name: l.name, kind: 'active-paper' });
      haveActive = true;
    } else if (blockName && doc.blocks.has(blockName)) {
      out.push({ name: l.name, kind: 'block', block: doc.blocks.get(blockName) });
    } else if (!blockName && !haveActive) {
      out.push({ name: l.name, kind: 'active-paper' });
      haveActive = true;
    } else continue;
    seen.add(key);
  }
  if (!papers.length) {
    // No LAYOUT objects (R12 or minimal writers): the active paper space is "Layout1"; further
    // *Paper_SpaceN blocks with content become "Layout2", "Layout3", …
    const paperBlock = doc.blocks.get('*PAPER_SPACE') ?? doc.blocks.get('$PAPER_SPACE');
    const hasPaper =
      (paperBlock?.ents.length ?? 0) > 0 || doc.entities.some((r) => recNum(t, r, 67, 0) === 1);
    if (hasPaper) out.push({ name: 'Layout1', kind: 'active-paper' });
    const extra = [...doc.blocks.entries()]
      .map(([key, block]) => ({ n: /^\*PAPER_SPACE(\d+)$/.exec(key)?.[1], block }))
      .filter((x) => x.n !== undefined && x.block.ents.length > 0)
      .sort((a, b) => Number(a.n) - Number(b.n));
    for (const x of extra)
      out.push({ name: `Layout${out.length + (hasPaper ? 0 : 1)}`, kind: 'block', block: x.block });
  }
  return out;
}

function layoutEntities(doc: DxfDocument, info: LayoutInfo): Rec[] {
  const t = doc.tags;
  if (info.kind === 'block') return info.block?.ents ?? [];
  const paper = info.kind === 'active-paper';
  const out = doc.entities.filter((r) => (recNum(t, r, 67, 0) === 1) === paper);
  const extra = paper
    ? (doc.blocks.get('*PAPER_SPACE') ?? doc.blocks.get('$PAPER_SPACE'))
    : (doc.blocks.get('*MODEL_SPACE') ?? doc.blocks.get('$MODEL_SPACE'));
  if (extra?.ents.length) out.push(...extra.ents);
  return out;
}

/**
 * DXF import (FDR rows 13, 14, 18, 21): ASCII DXF R12–R2018+ and binary DXF → flattened
 * {@link DrawingParseResult}. Runs inside a Web Worker (no DOM APIs).
 *
 * Output conventions (in addition to those documented in `entity-store.ts`):
 * - All geometry is in drawing units, float64, projected onto the WCS XY plane (top view). Block
 *   references, dimensions and tables are flattened; their entities carry `FLAG.IN_BLOCK` and the
 *   index of the top-level reference in `store.inserts`.
 * - Colours are resolved (BYLAYER / BYBLOCK / layer "0" inheritance / true colour). ACI 7 is stored
 *   as 0xffffff; the renderer adapts it to the background.
 * - GK.TEXT frame: glyph coordinates (gx, gy) in units of the text height map to
 *   `anchor + height · R(rotation) · [[widthFactor, tan(oblique)], [0, 1]] · (gx, gy)`. A negative
 *   width factor means the text is mirrored (backward / mirrored block reference); upside-down text
 *   is expressed as rotation + π with a negative width factor. For TEXT with "aligned"/"fit"
 *   justification, `boxWidth` > 0 is the baseline length the text must be fitted to; for MTEXT it is
 *   the reference column width (0 = no wrapping).
 * - Pattern hatches produce one GK.FILL entity with FLAG.PATTERN (the boundary) plus generated
 *   pattern lines (ET.HATCH, GK.LINE, FLAG.DERIVED).
 * - `report.counts` counts the top-level entities of the parsed layout by DXF type (plus ATTRIBs of
 *   top-level INSERTs); `report.skipped` counts unsupported/invalid entities by type name, once per
 *   definition (entities inside a block are not counted again for every reference).
 *
 * @throws DxfParseError when the data is not DXF or is structurally broken (message includes the
 *   line number for ASCII files); DxfAbortError when `opts.signal.aborted` becomes true.
 */
export function parseDxf(data: ArrayBuffer | Uint8Array, opts: ParseDxfOptions = {}): DrawingParseResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (opts.signal?.aborted) throw new DxfAbortError();
  let last = -1;
  const progress = (f: number) => {
    if (!opts.onProgress) return;
    const v = Math.min(1, Math.max(0, f));
    if (v - last >= 0.01 || (v === 1 && last < 1)) {
      last = v;
      opts.onProgress(v);
    }
  };

  const binary = isBinaryDxf(bytes);
  if (!binary && !sniffDxf(bytes)) {
    if (bytes.length === 0) throw new DxfParseError('The file is empty', { line: 1 });
    throw new DxfParseError('Not a DXF file: it does not start with a "0 / SECTION" group', { line: 1 });
  }
  const warnings: string[] = [];
  const enc = detectEncoding(bytes, binary, warnings);
  const decoder = makeDecoder(enc.label);
  const tokOpts = { onProgress: progress, signal: opts.signal, progressScale: PROGRESS_TOKENIZE };
  const tok = binary
    ? tokenizeBinary(bytes, decoder, tokOpts)
    : tokenizeAscii(decoder.decode(bytes), tokOpts);
  const doc = buildDocument(tok.tags, tok.recs, tok.truncated, {
    binary,
    tick: (f) => progress(PROGRESS_TOKENIZE + PROGRESS_STRUCTURE * f),
  });

  const infos = layoutInfos(doc);
  const wanted = opts.layout && opts.layout.toUpperCase() !== 'MODEL' ? opts.layout : 'Model';
  const info = infos.find((l) => l.name.toUpperCase() === wanted.toUpperCase());
  if (!info) {
    throw new DxfParseError(
      `Layout "${wanted}" not found. Available layouts: ${infos.map((l) => l.name).join(', ')}`,
    );
  }

  const builder = new EntityStoreBuilder();
  const report = emptyReport();
  report.warnings.push(...warnings, ...doc.warnings);
  report.errors.push(...doc.errors);
  const emitter = new Emitter(doc, builder, report, {
    tick: (f) => progress(PROGRESS_EMIT_START + (1 - PROGRESS_EMIT_START) * f),
    signal: opts.signal,
  });
  emitter.run(layoutEntities(doc, info));
  const store = builder.finish();
  const insunits = doc.header.get('$INSUNITS')?.num;
  const version = (doc.header.get('$ACADVER')?.str ?? '').trim() || enc.version || undefined;
  progress(1);
  return {
    store,
    extents: storeExtents(store),
    insunits: insunits !== undefined && Number.isFinite(insunits) ? insunits : 0,
    layouts: infos.map((l) => l.name),
    layout: info.name,
    report,
    version,
  };
}
