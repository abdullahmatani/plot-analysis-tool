/**
 * File type detection by signature, not extension (row 13).
 */

export type DetectedKind = 'dxf' | 'dwg' | 'pdf' | 'patproj' | 'xlsx' | 'csv' | 'unknown';

export interface Detected {
  kind: DetectedKind;
  /** e.g. DWG "AC1032", PDF "1.7", DXF "binary". */
  version?: string;
  /** Human-readable description for messages. */
  label: string;
  /** True when the extension disagrees with the content. */
  misnamed: boolean;
}

const DWG_VERSIONS: Record<string, string> = {
  AC1009: 'R11/R12',
  AC1012: 'R13',
  AC1014: 'R14',
  AC1015: 'AutoCAD 2000',
  AC1018: 'AutoCAD 2004',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
};

export function dwgVersionLabel(code: string): string {
  return DWG_VERSIONS[code] ?? `unknown (${code})`;
}

function ascii(bytes: Uint8Array, start: number, len: number): string {
  let s = '';
  for (let i = start; i < Math.min(bytes.length, start + len); i++) s += String.fromCharCode(bytes[i]);
  return s;
}

function looksLikeAsciiDxf(bytes: Uint8Array): boolean {
  // Skip BOM and whitespace; expect group code 0 SECTION (or 999 comment) near the start.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096)).replace(/^\uFEFF/, '');
  return /^\s*(999\s*\r?\n[^\n]*\r?\n\s*)?0\s*\r?\n\s*SECTION\s*\r?\n/i.test(head);
}

function looksLikeText(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 4096);
  let bin = 0;
  for (let i = 0; i < n; i++) {
    const b = bytes[i];
    if (b === 0) return false;
    if (b < 9 || (b > 13 && b < 32)) bin++;
  }
  return bin < n * 0.01;
}

function zipEntryNames(bytes: Uint8Array): string[] {
  // Scan local file headers (cheap; enough to tell a project from an XLSX).
  const names: string[] = [];
  let i = 0;
  while (i + 30 < bytes.length && names.length < 50) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 3 && bytes[i + 3] === 4) {
      const nameLen = bytes[i + 26] | (bytes[i + 27] << 8);
      const extraLen = bytes[i + 28] | (bytes[i + 29] << 8);
      const compSize = bytes[i + 18] | (bytes[i + 19] << 8) | (bytes[i + 20] << 16) | (bytes[i + 21] << 24);
      names.push(new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nameLen)));
      i += 30 + nameLen + extraLen + (compSize >>> 0);
    } else {
      break;
    }
  }
  return names;
}

export function detectFileType(bytes: Uint8Array, fileName = ''): Detected {
  const ext = (/\.([a-z0-9]+)$/i.exec(fileName)?.[1] ?? '').toLowerCase();
  const result = (kind: DetectedKind, label: string, version?: string): Detected => {
    const expected: Record<DetectedKind, string[]> = {
      dxf: ['dxf'],
      dwg: ['dwg'],
      pdf: ['pdf'],
      patproj: ['patproj', 'zip'],
      xlsx: ['xlsx', 'xlsm'],
      csv: ['csv', 'tsv', 'txt'],
      unknown: [],
    };
    return { kind, label, version, misnamed: !!ext && kind !== 'unknown' && !expected[kind].includes(ext) };
  };
  const head = ascii(bytes, 0, 1024);
  if (head.startsWith('AC10') || head.startsWith('AC1.') || head.startsWith('AC2')) {
    const code = head.slice(0, 6);
    return result('dwg', `DWG (${dwgVersionLabel(code)})`, code);
  }
  const pdfAt = head.indexOf('%PDF-');
  if (pdfAt >= 0 && pdfAt < 1024)
    return result('pdf', `PDF ${head.slice(pdfAt + 5, pdfAt + 8)}`, head.slice(pdfAt + 5, pdfAt + 8));
  if (head.startsWith('AutoCAD Binary DXF')) return result('dxf', 'Binary DXF', 'binary');
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4) {
    const names = zipEntryNames(bytes);
    if (names.includes('project.json')) return result('patproj', 'Plot Analysis project');
    if (names.some((n) => n.startsWith('xl/')) || names.includes('[Content_Types].xml'))
      return result('xlsx', 'Excel workbook');
    return result('unknown', 'ZIP archive');
  }
  if (bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0)
    return result('unknown', 'Legacy Office file (.xls/.doc) — save as .xlsx or .csv');
  if (looksLikeAsciiDxf(bytes)) return result('dxf', 'ASCII DXF', 'ascii');
  if (looksLikeText(bytes)) return result('csv', 'Text table');
  // UTF-16 text with a BOM (Excel "Unicode Text" TSV): NUL bytes are expected, so check the BOM.
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
    return result('csv', 'Text table (UTF-16)');
  return result('unknown', 'Unrecognised file');
}
