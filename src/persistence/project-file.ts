import { migrateProject } from '@/core/migrations';
import { SCHEMA_VERSION } from '@/core/project';
import type { Project } from '@/core/types';

import { getBlobBytes, hashBytes, putBlob } from './blobs';
import { unzipFiles, zipFiles } from './zip-client';

/**
 * Portable project file (row 10): a zip containing project.json and the original source drawings.
 * Extension `.patproj`.
 */

export const PROJECT_FILE_EXT = '.patproj';
export const PROJECT_FILE_FORMAT = 'plot-analysis-tool/project';
export const PROJECT_FILE_MIME = 'application/x-plot-analysis-project';

export interface ProjectFileHeader {
  format: string;
  formatVersion: number;
  schemaVersion: number;
  appVersion: string;
  savedAt: string;
}

export class ProjectFileError extends Error {}

function safeName(name: string): string {
  return name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').slice(0, 120) || 'drawing';
}

export async function buildProjectFile(project: Project, appVersion: string): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const header: ProjectFileHeader = {
    format: PROJECT_FILE_FORMAT,
    formatVersion: 1,
    schemaVersion: SCHEMA_VERSION,
    appVersion,
    savedAt: new Date().toISOString(),
  };
  files['project.json'] = new TextEncoder().encode(JSON.stringify({ ...header, project }));
  const seen = new Set<string>();
  for (const d of project.drawings) {
    if (seen.has(d.source.sha256)) continue;
    seen.add(d.source.sha256);
    const bytes = await getBlobBytes(d.source.sha256);
    if (!bytes)
      throw new ProjectFileError(`Source drawing "${d.source.fileName}" is missing from local storage.`);
    files[`drawings/${d.source.sha256}/${safeName(d.source.fileName)}`] = bytes;
  }
  return zipFiles(files);
}

export interface OpenedProjectFile {
  project: Project;
  header: ProjectFileHeader;
  migratedFrom: number;
  missingDrawings: string[];
}

/** Parses a project file, verifies and stores its drawings (deduplicated) and migrates the schema. */
export async function readProjectFile(bytes: Uint8Array): Promise<OpenedProjectFile> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = await unzipFiles(bytes);
  } catch {
    throw new ProjectFileError('This file is not a Plot Analysis project (not a valid zip archive).');
  }
  const json = entries['project.json'];
  if (!json) throw new ProjectFileError('This file is not a Plot Analysis project (project.json missing).');
  let parsed: ProjectFileHeader & { project: unknown };
  try {
    parsed = JSON.parse(new TextDecoder().decode(json));
  } catch {
    throw new ProjectFileError('The project data is corrupt (project.json is not valid JSON).');
  }
  if (parsed.format !== PROJECT_FILE_FORMAT) throw new ProjectFileError('Unrecognised project file format.');
  const { project, from } = migrateProject(parsed.project);
  const missing: string[] = [];
  const bySha = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(entries)) {
    const m = /^drawings\/([0-9a-f]{64})\//.exec(path);
    if (m) bySha.set(m[1], data);
  }
  for (const d of project.drawings) {
    const data = bySha.get(d.source.sha256);
    if (!data) {
      missing.push(d.source.fileName);
      continue;
    }
    const actual = await hashBytes(data);
    if (actual !== d.source.sha256)
      throw new ProjectFileError(`Drawing "${d.source.fileName}" is corrupt (checksum mismatch).`);
    await putBlob(data, d.source.fileName, mimeFor(d.source.kind), actual);
  }
  const { project: _p, ...header } = parsed;
  void _p;
  return { project, header, migratedFrom: from, missingDrawings: missing };
}

function mimeFor(kind: string): string {
  return kind === 'pdf' ? 'application/pdf' : kind === 'dwg' ? 'application/acad' : 'application/dxf';
}

export function projectFileName(project: Project): string {
  return `${safeName(project.name)}${PROJECT_FILE_EXT}`;
}
