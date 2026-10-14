/**
 * Text encoding for DXF: version/codepage detection, buffer decoding, and the DXF string escapes
 * shared by TEXT, ATTRIB and MTEXT (`\U+XXXX`, `\M+nXXXX`, `%%c`, `%%d`, `%%p`, `%%%`, `%%nnn`).
 */

/** $DWGCODEPAGE values → WHATWG TextDecoder labels. */
const CODEPAGES: Record<string, string> = {
  '874': 'windows-874',
  '932': 'shift_jis',
  '936': 'gbk',
  '949': 'euc-kr',
  '950': 'big5',
  '1250': 'windows-1250',
  '1251': 'windows-1251',
  '1252': 'windows-1252',
  '1253': 'windows-1253',
  '1254': 'windows-1254',
  '1255': 'windows-1255',
  '1256': 'windows-1256',
  '1257': 'windows-1257',
  '1258': 'windows-1258',
};

const NAMED_CODEPAGES: Record<string, string> = {
  ASCII: 'windows-1252',
  ISO8859_1: 'iso-8859-1',
  ISO8859_2: 'iso-8859-2',
  ISO8859_5: 'iso-8859-5',
  ISO8859_6: 'iso-8859-6',
  ISO8859_7: 'iso-8859-7',
  ISO8859_8: 'iso-8859-8',
  ISO8859_9: 'windows-1254',
  DOS866: 'ibm866',
  KOI8_R: 'koi8-r',
  MACINTOSH: 'macintosh',
  GB2312: 'gbk',
  BIG5: 'big5',
  JOHAB: 'euc-kr',
  KSC5601: 'euc-kr',
  SJIS: 'shift_jis',
  UTF8: 'utf-8',
};

/** Maps a $DWGCODEPAGE value (e.g. "ANSI_1256") to a TextDecoder label, or null when unknown. */
export function codepageToLabel(codepage: string): string | null {
  const cp = codepage.trim().toUpperCase().replace(/-/g, '_');
  const m = /^(?:ANSI|DOS|CP|MS|WINDOWS)_?(\d{3,4})$/.exec(cp);
  if (m && CODEPAGES[m[1]]) return CODEPAGES[m[1]];
  if (NAMED_CODEPAGES[cp]) return NAMED_CODEPAGES[cp];
  return null;
}

/** Creates a TextDecoder for the label, falling back to windows-1252 when the label is unsupported. */
export function makeDecoder(label: string, fatal = false): TextDecoder {
  try {
    return new TextDecoder(label, { fatal });
  } catch {
    return new TextDecoder('windows-1252', { fatal });
  }
}

export interface EncodingInfo {
  /** $ACADVER, e.g. "AC1015" ("" when absent). */
  version: string;
  /** $DWGCODEPAGE as written ("" when absent). */
  codepage: string;
  /** TextDecoder label used for strings. */
  label: string;
}

const PRESCAN_BYTES = 1 << 20;

let latin1Decoder: TextDecoder | null = null;

function latin1(bytes: Uint8Array, start: number, end: number): string {
  // windows-1252 maps every ASCII byte (incl. NUL) to the same code point, which is all the prescan needs.
  latin1Decoder ??= new TextDecoder('windows-1252');
  return latin1Decoder.decode(bytes.subarray(start, end));
}

/**
 * Finds $ACADVER and $DWGCODEPAGE without decoding the whole file. Works for ASCII and binary DXF
 * (both store these header values as ASCII strings near the start of the file).
 */
export function prescanHeader(bytes: Uint8Array, binary: boolean): { version: string; codepage: string } {
  const head = latin1(bytes, 0, Math.min(bytes.length, PRESCAN_BYTES));
  let version = '';
  let codepage = '';
  if (binary) {
    // Binary: NUL-terminated name, a 1- or 2-byte group code (1 or 3), NUL-terminated value.
    // eslint-disable-next-line no-control-regex
    const v = /\$ACADVER\x00[\x00-\x02]{1,2}(AC\d{4})\x00/.exec(head);
    if (v) version = v[1];
    // eslint-disable-next-line no-control-regex
    const c = /\$DWGCODEPAGE\x00[\x00-\x03]{1,2}([^\x00]{1,32})\x00/.exec(head);
    if (c) codepage = c[1];
  } else {
    const v = /\$ACADVER[ \t]*\r?\n[ \t]*1[ \t]*\r?\n[ \t]*(AC\d{4})/.exec(head);
    if (v) version = v[1];
    const c = /\$DWGCODEPAGE[ \t]*\r?\n[ \t]*3[ \t]*\r?\n[ \t]*([^\r\n]*)/.exec(head);
    if (c) codepage = c[1].trim();
  }
  return { version, codepage };
}

function hasHighBytes(bytes: Uint8Array): boolean {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] >= 0x80) return true;
  return false;
}

function isValidUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/**
 * Chooses the string encoding: AC1021 (R2007) and later are always UTF-8; earlier versions use
 * $DWGCODEPAGE (default windows-1252). Files that declare ANSI_1252 (or nothing) but are valid
 * UTF-8 with non-ASCII content are decoded as UTF-8 — a common exporter bug.
 */
export function detectEncoding(bytes: Uint8Array, binary: boolean, warnings: string[]): EncodingInfo {
  const { version, codepage } = prescanHeader(bytes, binary);
  if (version >= 'AC1021') return { version, codepage, label: 'utf-8' };
  let label = codepage ? codepageToLabel(codepage) : null;
  if (codepage && !label) warnings.push(`Unknown code page "${codepage}" — text decoded as Windows-1252.`);
  label ??= 'windows-1252';
  if (label !== 'utf-8') {
    try {
      new TextDecoder(label);
    } catch {
      warnings.push(
        `Code page "${codepage}" is not supported by this browser — text decoded as Windows-1252.`,
      );
      label = 'windows-1252';
    }
  }
  if (label === 'windows-1252' && !binary && hasHighBytes(bytes) && isValidUtf8(bytes)) label = 'utf-8';
  return { version, codepage, label };
}

/** \M+nXXXX code page numbers → decoder labels. */
const MBCS: Record<string, string> = {
  '1': 'shift_jis',
  '2': 'big5',
  '3': 'euc-kr',
  '4': 'euc-kr',
  '5': 'gbk',
};
const mbcsDecoders = new Map<string, TextDecoder | null>();

/** Decodes one `\\M+nXXXX` double-byte character (n = AutoCAD MBCS code page index 1–5). */
export function decodeMbcs(n: string, hex: string): string {
  const label = MBCS[n];
  if (!label) return '';
  let dec = mbcsDecoders.get(label);
  if (dec === undefined) {
    try {
      dec = new TextDecoder(label);
    } catch {
      dec = null;
    }
    mbcsDecoders.set(label, dec);
  }
  if (!dec) return '';
  const v = parseInt(hex, 16);
  return dec.decode(new Uint8Array([v >> 8, v & 0xff]));
}

const ESCAPE_RE = /\\U\+([0-9A-Fa-f]{4})|\\M\+([1-5])([0-9A-Fa-f]{4})/g;

/** Decodes `\U+XXXX` and `\M+nXXXX` escapes. */
export function decodeUnicodeEscapes(s: string): string {
  if (s.indexOf('\\') < 0) return s;
  return s.replace(ESCAPE_RE, (_m, u: string | undefined, n: string | undefined, hex: string | undefined) => {
    if (u !== undefined) return String.fromCharCode(parseInt(u, 16));
    return decodeMbcs(n as string, hex as string);
  });
}

const SPECIAL_RE = /%%(\d{3}|[cCdDpPuUoOkK%])/g;

/** Decodes AutoCAD %% control codes: %%c Ø, %%d °, %%p ±, %%% %, %%nnn character code; %%u/%%o/%%k toggles are removed. */
export function decodeSpecials(s: string): string {
  if (s.indexOf('%%') < 0) return s;
  return s.replace(SPECIAL_RE, (_m, c: string) => {
    switch (c) {
      case 'c':
      case 'C':
        return 'Ø';
      case 'd':
      case 'D':
        return '°';
      case 'p':
      case 'P':
        return '±';
      case '%':
        return '%';
      case 'u':
      case 'U':
      case 'o':
      case 'O':
      case 'k':
      case 'K':
        return '';
      default: {
        const code = parseInt(c, 10);
        return code > 0 && code < 0xffff ? String.fromCharCode(code) : '';
      }
    }
  });
}

/** Decodes a single-line TEXT/ATTRIB value. */
export function decodeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return decodeSpecials(decodeUnicodeEscapes(s)).replace(/[\x00-\x08\x0b-\x1f]/g, '');
}
