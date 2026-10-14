import { DxfParseError } from './errors';
import { recNum, recStr, type Rec, type Tags } from './tokenizer';

export interface HeaderValue {
  num: number;
  str: string;
  /** Point variables (10/20/30). */
  pt?: [number, number, number];
}

export interface DxfBlock {
  name: string;
  base: [number, number, number];
  flags: number;
  ents: Rec[];
  line: number;
  xrefPath: string;
  /** Owner block record handle (R2000+), upper case. */
  owner: string;
}

export interface DxfLayout {
  name: string;
  tabOrder: number;
  /** Paper/model space block record handle (upper case). */
  blockRecord: string;
}

export interface DxfDocument {
  tags: Tags;
  /** Binary DXF: record positions (`Rec.line`) are byte offsets instead of line numbers. */
  binary: boolean;
  header: Map<string, HeaderValue>;
  /** Table entries by table name (LAYER, LTYPE, BLOCK_RECORD, …). */
  tables: Map<string, Rec[]>;
  /** Blocks by upper-case name. */
  blocks: Map<string, DxfBlock>;
  /** ENTITIES section, grouped (POLYLINE→VERTEX, INSERT→ATTRIB). */
  entities: Rec[];
  layouts: DxfLayout[];
  errors: string[];
  warnings: string[];
}

/** Groups VERTEX/ATTRIB/SEQEND records under their POLYLINE/INSERT parents. */
export function groupEntities(recs: Rec[], from: number, to: number, out: Rec[], warnings: string[]): void {
  let orphans = 0;
  let untyped = 0;
  let i = from;
  while (i < to) {
    const r = recs[i++];
    const t = r.type;
    if (t === 'POLYLINE' || t === 'INSERT') {
      const child = t === 'POLYLINE' ? 'VERTEX' : 'ATTRIB';
      let sub: Rec[] | null = null;
      while (i < to && recs[i].type === child) (sub ??= []).push(recs[i++]);
      if (i < to && recs[i].type === 'SEQEND') i++;
      r.sub = sub;
      out.push(r);
    } else if (t === 'VERTEX' || t === 'ATTRIB') {
      orphans++;
    } else if (t === '') {
      untyped++;
    } else if (t !== 'SEQEND') {
      out.push(r);
    }
  }
  if (orphans)
    warnings.push(`${orphans} VERTEX/ATTRIB record(s) without a parent POLYLINE/INSERT were ignored.`);
  if (untyped) warnings.push(`${untyped} record(s) with an empty entity type were ignored.`);
}

function parseHeader(tags: Tags, r: Rec, header: Map<string, HeaderValue>) {
  let name = '';
  let cur: HeaderValue | null = null;
  for (let i = r.s; i < r.e; i++) {
    const code = tags.code[i];
    if (code === 9) {
      name = tags.str[i].trim().toUpperCase();
      cur = null;
      continue;
    }
    if (!name) continue;
    if (!cur) {
      cur = { num: tags.num[i], str: tags.str[i] };
      if (!header.has(name)) header.set(name, cur);
    }
    if (code >= 10 && code <= 39) {
      cur.pt ??= [0, 0, 0];
      cur.pt[Math.floor(code / 10) - 1] = tags.num[i];
    }
  }
}

function parseLayouts(tags: Tags, r: Rec): DxfLayout {
  // LAYOUT: AcDbPlotSettings (code 1 = page setup name) precedes AcDbLayout (code 1 = layout name).
  let inLayout = false;
  let name = '';
  let tabOrder = 0;
  let blockRecord = '';
  for (let i = r.s; i < r.e; i++) {
    const code = tags.code[i];
    if (code === 100) inLayout = tags.str[i].trim() === 'AcDbLayout';
    else if (inLayout && code === 1) name = tags.str[i].trim();
    else if (inLayout && code === 71) tabOrder = tags.num[i];
    else if (inLayout && code === 330 && !blockRecord) blockRecord = tags.str[i].trim().toUpperCase();
  }
  if (!name) name = recStr(tags, r, 1).trim();
  return { name, tabOrder, blockRecord };
}

export interface StructureOptions {
  tick?: (fraction: number) => void;
  binary?: boolean;
}

/** Human-readable position of a record: "line N" (ASCII) or "byte N" (binary). */
export function where(doc: { binary: boolean }, r: Rec): string {
  return `${doc.binary ? 'byte' : 'line'} ${r.line}`;
}

/** Walks the records and builds the section-level document model. */
export function buildDocument(
  tags: Tags,
  recs: Rec[],
  truncated: boolean,
  opts: StructureOptions = {},
): DxfDocument {
  const doc: DxfDocument = {
    tags,
    binary: !!opts.binary,
    header: new Map(),
    tables: new Map(),
    blocks: new Map(),
    entities: [],
    layouts: [],
    errors: [],
    warnings: [],
  };
  const n = recs.length;
  if (n === 0) throw new DxfParseError('Not a DXF file: no "0 / SECTION" found', { line: 1 });
  if (recs[0].type !== 'SECTION') {
    throw new DxfParseError(`Not a DXF file: expected "SECTION" but found "${recs[0].type.slice(0, 40)}"`, {
      line: recs[0].line,
    });
  }
  let sawEof = false;
  let i = 0;
  while (i < n) {
    const r = recs[i];
    if (r.type === 'EOF') {
      sawEof = true;
      break;
    }
    if (r.type !== 'SECTION') {
      // Garbage between sections: skip to the next SECTION.
      doc.errors.push(`Unexpected "${r.type.slice(0, 40)}" outside a section at ${where(doc, r)} — ignored.`);
      while (i < n && recs[i].type !== 'SECTION' && recs[i].type !== 'EOF') i++;
      continue;
    }
    const name = recStr(tags, r, 2).trim().toUpperCase();
    i++;
    const start = i;
    while (i < n && recs[i].type !== 'ENDSEC' && recs[i].type !== 'SECTION' && recs[i].type !== 'EOF') i++;
    const end = i;
    if (i >= n || recs[i].type !== 'ENDSEC') {
      doc.errors.push(
        `Section ${name || '?'} starting at ${where(doc, r)} is not terminated — the file may be truncated.`,
      );
    } else i++;
    opts.tick?.(i / n);

    switch (name) {
      case 'HEADER':
        parseHeader(tags, r, doc.header);
        break;
      case 'TABLES': {
        let table = '';
        for (let k = start; k < end; k++) {
          const t = recs[k];
          if (t.type === 'TABLE') table = recStr(tags, t, 2).trim().toUpperCase();
          else if (t.type === 'ENDTAB') table = '';
          else if (table) {
            let list = doc.tables.get(t.type);
            if (!list) doc.tables.set(t.type, (list = []));
            list.push(t);
          }
        }
        break;
      }
      case 'BLOCKS': {
        let k = start;
        while (k < end) {
          const b = recs[k++];
          if (b.type !== 'BLOCK') continue;
          const bStart = k;
          while (k < end && recs[k].type !== 'ENDBLK' && recs[k].type !== 'BLOCK') k++;
          const blk: DxfBlock = {
            name: recStr(tags, b, 2).trim() || recStr(tags, b, 3).trim(),
            base: [recNum(tags, b, 10, 0), recNum(tags, b, 20, 0), recNum(tags, b, 30, 0)],
            flags: recNum(tags, b, 70, 0),
            ents: [],
            line: b.line,
            xrefPath: recStr(tags, b, 1).trim(),
            owner: recStr(tags, b, 330).trim().toUpperCase(),
          };
          groupEntities(recs, bStart, k, blk.ents, doc.warnings);
          if (k < end && recs[k].type === 'ENDBLK') k++;
          const key = blk.name.toUpperCase();
          if (!blk.name) doc.warnings.push(`Block without a name at ${where(doc, b)} ignored.`);
          else if (!doc.blocks.has(key)) doc.blocks.set(key, blk);
        }
        break;
      }
      case 'ENTITIES':
        groupEntities(recs, start, end, doc.entities, doc.warnings);
        break;
      case 'OBJECTS':
        for (let k = start; k < end; k++)
          if (recs[k].type === 'LAYOUT') doc.layouts.push(parseLayouts(tags, recs[k]));
        break;
      default:
        break; // CLASSES, THUMBNAILIMAGE, ACDSDATA
    }
  }
  if (truncated)
    doc.errors.push('The file ends in the middle of a group code/value pair — it may be truncated.');
  else if (!sawEof && doc.errors.length === 0)
    doc.warnings.push('The file has no EOF marker — it may be truncated.');
  return doc;
}
