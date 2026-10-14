import Dexie, { type Table } from 'dexie';

import type { JournalOp } from '@/core/history';

/**
 * Local persistence (rows 9, 90–101). Everything lives in this origin's IndexedDB (and OPFS for large
 * source drawings); nothing ever leaves the device (C2).
 */

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: string;
  /** Time of the last committed edit. */
  updatedAt: string;
  lastOpenedAt: string;
  /** Highest journal sequence number written. */
  lastSeq: number;
  drawingCount: number;
  objectCount: number;
  /** sha256 keys of source drawings referenced by the project (for storage accounting / GC). */
  blobKeys: string[];
}

export interface JournalRecord {
  projectId: string;
  seq: number;
  at: string;
  op: JournalOp;
  /** Integrity hash of JSON(op) (cyrb53). */
  hash: string;
}

export type SnapshotKind = 'checkpoint' | 'auto-restore-point' | 'named';

export interface SnapshotRecord {
  id: string;
  projectId: string;
  seq: number;
  at: string;
  kind: SnapshotKind;
  label?: string;
  /** Short change summary since the previous restore point. */
  summary?: string;
  /** SHA-256 of `data`. */
  sha256: string;
  /** SHA-256 of the canonical project JSON (used to verify exact restores). */
  projectHash: string;
  /** JSON of { project, undo, redo }. */
  data: string;
  size: number;
}

export interface DraftRecord {
  projectId: string;
  key: string;
  tool: string;
  label: string;
  at: string;
  state: unknown;
}

export interface BlobRecord {
  sha256: string;
  size: number;
  name: string;
  type: string;
  /** Stored inline (IndexedDB) or in the Origin Private File System. */
  where: 'idb' | 'opfs';
  data?: Blob;
  createdAt: string;
}

export interface RecoveryBinRecord {
  id: string;
  projectId: string;
  projectName: string;
  at: string;
  reason: string;
  journal: JournalRecord[];
  drafts: DraftRecord[];
}

export interface FileLinkRecord {
  projectId: string;
  handle: FileSystemFileHandle;
  name: string;
  autosave: boolean;
  lastWrittenSeq: number;
  lastWrittenAt?: string;
}

export interface SettingRecord {
  key: string;
  value: unknown;
}

export interface TemplateRecord {
  id: string;
  name: string;
  headers: string[];
  data: unknown;
  createdAt: string;
}

export class PatDb extends Dexie {
  projects!: Table<ProjectMeta, string>;
  journal!: Table<JournalRecord, [string, number]>;
  snapshots!: Table<SnapshotRecord, string>;
  drafts!: Table<DraftRecord, [string, string]>;
  blobs!: Table<BlobRecord, string>;
  settings!: Table<SettingRecord, string>;
  recoveryBin!: Table<RecoveryBinRecord, string>;
  fileLinks!: Table<FileLinkRecord, string>;
  templates!: Table<TemplateRecord, string>;

  constructor(name = 'plot-analysis-tool') {
    // Strict durability: committed transactions are flushed to disk before success is reported,
    // where the browser supports it (NFR-9, row 90).
    super(name, { chromeTransactionDurability: 'strict', cache: 'disabled' });
    this.version(1).stores({
      projects: 'id, updatedAt, lastOpenedAt',
      journal: '[projectId+seq], projectId',
      snapshots: 'id, projectId, [projectId+seq], [projectId+kind]',
      drafts: '[projectId+key], projectId',
      blobs: 'sha256',
      settings: 'key',
      recoveryBin: 'id, projectId, at',
      fileLinks: 'projectId',
      templates: 'id, name',
    });
  }
}

let instance: PatDb | null = null;

export function getDb(): PatDb {
  if (!instance) instance = new PatDb();
  return instance;
}

/** For tests: use an isolated database. */
export function setDb(db: PatDb | null) {
  instance = db;
}

export function isQuotaError(e: unknown): boolean {
  const err = e as { name?: string; inner?: { name?: string }; message?: string } | null;
  if (!err) return false;
  const names = [err.name, err.inner?.name];
  return (
    names.includes('QuotaExceededError') ||
    names.includes('QuotaExceeded') ||
    /quota/i.test(err.message ?? '')
  );
}
