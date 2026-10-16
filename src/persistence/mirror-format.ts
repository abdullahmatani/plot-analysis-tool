import type { DraftRecord, JournalRecord, ProjectMeta, SnapshotRecord } from './db';
import type { JournalMeta } from './journal-write';

/**
 * Backup copy of each project outside IndexedDB (C7, rows 90 and 102). Chromium deletes an origin's
 * whole IndexedDB database when it finds the store damaged on opening, which a crash in the middle of
 * a write can cause. The journal worker therefore keeps, in the Origin Private File System, two
 * files per project that it writes alternately: each starts with a base (the latest valid snapshot)
 * and continues with the journal records written after it. When the database is found empty and the
 * backup is not, projects are rebuilt from it (mirror.ts).
 *
 * File format: a sequence of frames, each `[u32 body length][u32 CRC-32 of body][body]`
 * (little-endian), where body is `[u8 type][UTF-8 JSON]`. Reading stops at the first frame that is
 * incomplete or fails its check, so a write interrupted by a crash only loses that frame.
 */

export const MIRROR_DIR = 'mirror';
export const MIRROR_VERSION = 1;

export type MirrorSlot = 'a' | 'b';

export interface MirrorBlobInfo {
  sha256: string;
  size: number;
  name: string;
  type: string;
}

export interface MirrorBase {
  v: number;
  /** Generation: increases by one at each new base, so the newer of the two files is known. */
  gen: number;
  meta: ProjectMeta;
  snapshot: Omit<SnapshotRecord, 'id' | 'projectId' | 'kind' | 'label' | 'summary'>;
  blobs: MirrorBlobInfo[];
}

export interface MirrorJournal {
  recs: JournalRecord[];
  meta?: JournalMeta;
}

const BASE = 1;
const JOURNAL = 2;
const HEADER = 8;

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function frame(type: number, value: unknown, replacer?: (key: string, v: unknown) => unknown): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(value, replacer));
  const out = new Uint8Array(HEADER + 1 + json.length);
  const body = out.subarray(HEADER);
  body[0] = type;
  body.set(json, 1);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length, true);
  view.setUint32(4, crc32(body), true);
  return out;
}

export const encodeBase = (base: MirrorBase) => frame(BASE, base);
export const encodeJournal = (j: MirrorJournal) => frame(JOURNAL, j);

/**
 * Unfinished-work drafts (row 93) of a project, kept next to its backup in `<projectId>.drafts`: one
 * frame holding every draft, rewritten whenever they change. Draft state can hold file bytes (an open
 * table-import dialog), so byte arrays are written as base64.
 */
const DRAFTS = 3;

export const draftsFileName = (projectId: string) => `${projectId}.drafts`;

export function parseDraftsFileName(name: string): string | null {
  return /^(.+)\.drafts$/.exec(name)?.[1] ?? null;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function encodeDrafts(drafts: DraftRecord[]): Uint8Array {
  return frame(DRAFTS, drafts, (_k, v) => (v instanceof Uint8Array ? { $bytes: bytesToBase64(v) } : v));
}

/** The drafts in a `.drafts` file, or null when it is missing, damaged or incomplete. */
export function decodeDrafts(bytes: Uint8Array | null): DraftRecord[] | null {
  if (!bytes || bytes.length < HEADER + 1) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = view.getUint32(0, true);
  if (len < 1 || HEADER + len > bytes.length) return null;
  const body = bytes.subarray(HEADER, HEADER + len);
  if (body[0] !== DRAFTS || crc32(body) !== view.getUint32(4, true)) return null;
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body.subarray(1)), (_k, v) =>
      v && typeof v === 'object' && typeof (v as { $bytes?: unknown }).$bytes === 'string'
        ? base64ToBytes((v as { $bytes: string }).$bytes)
        : v,
    );
    return Array.isArray(value) ? (value as DraftRecord[]) : null;
  } catch {
    return null;
  }
}

export type MirrorFrame = (
  { type: 'base'; base: MirrorBase } | { type: 'journal'; journal: MirrorJournal }
) & {
  /** Offset just after the frame. */
  end: number;
};

/** Decodes frames up to the first damaged or incomplete one. */
export function decodeFrames(bytes: Uint8Array): { frames: MirrorFrame[]; validBytes: number } {
  const frames: MirrorFrame[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let off = 0;
  while (off + HEADER <= bytes.length) {
    const len = view.getUint32(off, true);
    if (len < 1 || off + HEADER + len > bytes.length) break;
    const body = bytes.subarray(off + HEADER, off + HEADER + len);
    if (crc32(body) !== view.getUint32(off + 4, true)) break;
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(body.subarray(1)));
    } catch {
      break;
    }
    const end = off + HEADER + len;
    if (body[0] === BASE) frames.push({ type: 'base', base: value as MirrorBase, end });
    else if (body[0] === JOURNAL) frames.push({ type: 'journal', journal: value as MirrorJournal, end });
    else break;
    off = end;
  }
  return { frames, validBytes: off };
}

export interface MirrorState {
  slot: MirrorSlot;
  base: MirrorBase;
  /** Records after the base, contiguous from base.snapshot.seq + 1. */
  journal: JournalRecord[];
  /** Latest project-list metadata seen in the file. */
  meta: ProjectMeta;
  lastSeq: number;
  /** Bytes of the file that hold valid frames (appends continue from here). */
  validBytes: number;
  /** Bytes taken by the base frame. */
  baseBytes: number;
}

/** Reads one backup file: a base followed by journal frames. Null when there is no valid base. */
export function readMirrorFile(slot: MirrorSlot, bytes: Uint8Array | null): MirrorState | null {
  if (!bytes || bytes.length === 0) return null;
  const { frames, validBytes } = decodeFrames(bytes);
  const first = frames[0];
  if (first?.type !== 'base' || first.base.v !== MIRROR_VERSION) return null;
  const base = first.base;
  let lastSeq = base.snapshot.seq;
  let meta = base.meta;
  const journal: JournalRecord[] = [];
  outer: for (const f of frames.slice(1)) {
    if (f.type !== 'journal') break;
    for (const r of f.journal.recs) {
      if (r.seq <= lastSeq) continue;
      if (r.seq !== lastSeq + 1) break outer; // a gap: later records cannot be replayed
      journal.push(r);
      lastSeq = r.seq;
    }
    if (f.journal.meta) meta = { ...meta, ...f.journal.meta };
  }
  return {
    slot,
    base,
    journal,
    meta: { ...meta, lastSeq, updatedAt: journal.at(-1)?.at ?? meta.updatedAt },
    lastSeq,
    validBytes,
    baseBytes: first.end,
  };
}

/** The newer of a project's two backup files (highest generation with a valid base). */
export function pickMirror(a: MirrorState | null, b: MirrorState | null): MirrorState | null {
  if (!a) return b;
  if (!b) return a;
  return b.base.gen > a.base.gen ? b : a;
}

export const mirrorFileName = (projectId: string, slot: MirrorSlot) => `${projectId}.${slot}`;

export function parseMirrorFileName(name: string): { projectId: string; slot: MirrorSlot } | null {
  const m = /^(.+)\.(a|b)$/.exec(name);
  return m ? { projectId: m[1], slot: m[2] as MirrorSlot } : null;
}
