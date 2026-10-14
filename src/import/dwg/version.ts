/**
 * DWG format detection from the first six bytes of the file (the $ACADVER value).
 *
 * Supported: everything LibreDWG reads up to the AutoCAD 2018 format (AC1032, also written by
 * AutoCAD 2019–2025). Pre-R13 formats are read with LibreDWG's limited support and flagged with a
 * warning; newer or unknown format codes are refused with a clear message (row 22).
 */

export interface DwgVersionInfo {
  /** Header code, e.g. "AC1032". */
  code: string;
  /** Release name, e.g. "AutoCAD 2018". */
  label: string;
  /** 'ok' = supported; 'legacy' = pre-R13 or pre-release format (read, with a warning); 'newer' / 'unknown' = refused. */
  status: 'ok' | 'legacy' | 'newer' | 'unknown';
  /** True for formats before R13, which store no lineweights, layouts or $INSUNITS. */
  preR13: boolean;
  /** True for formats before AutoCAD 2000 (AC1015). */
  preR2000: boolean;
}

/** Newest supported format code. */
export const NEWEST_SUPPORTED_DWG = 'AC1032';

const RELEASES: Record<string, string> = {
  'MC0.0': 'MicroCAD R1.1',
  'AC1.2': 'AutoCAD R1.2',
  'AC1.3': 'AutoCAD R1.3',
  'AC1.40': 'AutoCAD R1.4',
  'AC1.50': 'AutoCAD R2.0',
  'AC2.10': 'AutoCAD R2.10',
  'AC2.21': 'AutoCAD R2.21',
  'AC2.22': 'AutoCAD R2.22',
  AC1001: 'AutoCAD R2.4',
  AC1002: 'AutoCAD R2.5',
  AC1003: 'AutoCAD R2.6',
  AC1004: 'AutoCAD R9',
  AC1005: 'AutoCAD R9',
  AC1006: 'AutoCAD R10',
  AC1007: 'AutoCAD R11 beta',
  AC1008: 'AutoCAD R11 beta',
  AC1009: 'AutoCAD R11/R12',
  AC1010: 'AutoCAD R13 beta',
  AC1011: 'AutoCAD R13 beta',
  AC1012: 'AutoCAD R13',
  AC1013: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1500: 'AutoCAD 2000 beta',
  AC1015: 'AutoCAD 2000',
  AC1016: 'AutoCAD 2000i',
  AC1017: 'AutoCAD 2002',
  AC402a: 'AutoCAD 2004 beta',
  AC402b: 'AutoCAD 2004 beta',
  AC1018: 'AutoCAD 2004',
  AC701a: 'AutoCAD 2007 beta',
  AC1021: 'AutoCAD 2007',
  AC1024: 'AutoCAD 2010',
  AC1027: 'AutoCAD 2013',
  AC1032: 'AutoCAD 2018',
};

const BETA = new Set(['AC1007', 'AC1008', 'AC1010', 'AC1011', 'AC1500', 'AC402a', 'AC402b', 'AC701a']);

/** Order of a format code for pre-R13 / pre-R2000 checks (R1.x/R2.x codes sort first). */
function ordinal(code: string): number {
  const m = /^AC1(\d{3})$/.exec(code);
  if (m) {
    if (code === 'AC1500') return 1014.5; // AutoCAD 2000 beta
    return 1000 + Number(m[1]);
  }
  if (code === 'AC402a' || code === 'AC402b') return 1017.5;
  if (code === 'AC701a') return 1020.5;
  return 0; // MC0.0, AC1.x, AC2.x
}

/** Reads the format code from the file header, or null when the bytes do not start with one. */
export function readDwgVersionCode(bytes: Uint8Array): string | null {
  if (bytes.length < 6) return null;
  let s = '';
  for (let i = 0; i < 6; i++) {
    const b = bytes[i];
    if (b < 0x20 || b > 0x7e) {
      if (b === 0 && i >= 5) break; // "AC1.2\0" style short codes
      return null;
    }
    s += String.fromCharCode(b);
  }
  // "AC103-" is the 6-byte header of the AutoCAD 2022 beta format ("AC103-4").
  if (/^AC[0-9]{4}$/.test(s) || /^AC[0-9]{3}[a-z]$/.test(s) || s === 'AC103-') return s;
  const short = /^(MC0\.0|AC1\.[0-9]{1,2}|AC2\.[0-9]{2})/.exec(s);
  return short ? short[1] : null;
}

/** Classifies a format code. */
export function dwgVersionInfo(code: string): DwgVersionInfo {
  const label = RELEASES[code];
  const ord = ordinal(code);
  if (label) {
    return {
      code,
      label,
      status: BETA.has(code) || ord < 1012 ? 'legacy' : 'ok',
      preR13: ord < 1012,
      preR2000: ord < 1015,
    };
  }
  const m = /^AC10([0-9]{2})$/.exec(code);
  if ((m && Number(m[1]) > 32) || code.startsWith('AC103-')) {
    return {
      code,
      label: 'a release newer than AutoCAD 2018',
      status: 'newer',
      preR13: false,
      preR2000: false,
    };
  }
  return { code, label: `unknown format ${code}`, status: 'unknown', preR13: false, preR2000: false };
}

/** Message for refused formats. */
export function unsupportedVersionMessage(info: DwgVersionInfo): string {
  if (info.status === 'newer') {
    return `DWG format newer than AutoCAD 2018 (${info.code}) is not supported — save as DWG 2018 or export DXF/PDF.`;
  }
  return `Unrecognised DWG format code "${info.code}" — save as DWG 2018 or export DXF/PDF.`;
}
