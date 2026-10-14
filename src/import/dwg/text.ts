/**
 * Text decoding for DWG TEXT / MTEXT / ATTRIB values. LibreDWG already converts the drawing's code
 * page and `\U+XXXX` escapes; what remains are AutoCAD control codes.
 */

const MBCS_ENCODINGS: Record<string, string> = {
  '1': 'shift_jis',
  '2': 'big5',
  '3': 'euc-kr',
  '5': 'gbk',
};
const mbcsDecoders = new Map<string, TextDecoder | null>();

/** Decodes an AutoCAD `\M+nXXXX` double-byte escape; '?' when the code page is unavailable. */
export function decodeMbcs(n: string, hex: string): string {
  let dec = mbcsDecoders.get(n);
  if (dec === undefined) {
    const label = MBCS_ENCODINGS[n];
    try {
      dec = label ? new TextDecoder(label) : null;
    } catch {
      dec = null;
    }
    mbcsDecoders.set(n, dec);
  }
  if (!dec) return '?';
  const v = parseInt(hex, 16);
  const bytes = v > 0xff ? Uint8Array.of(v >> 8, v & 0xff) : Uint8Array.of(v);
  return dec.decode(bytes) || '?';
}

/**
 * Replaces TEXT control codes: %%c Ø, %%d °, %%p ±, %%% %, %%nnn character code; %%u / %%o
 * (underline / overline toggles) and %%k are dropped. Also decodes `\U+XXXX` and `\M+nXXXX`.
 */
export function decodeTextCodes(src: string): string {
  if (!src) return '';
  let s = src;
  if (s.includes('\\')) {
    s = s
      .replace(/\\U\+([0-9A-Fa-f]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\M\+([1-5])([0-9A-Fa-f]{4})/g, (_, n: string, h: string) => decodeMbcs(n, h));
  }
  if (!s.includes('%%')) return s;
  return s.replace(/%%(\d{1,3}|[cCdDpPuUoOkK%])/g, (_, c: string) => {
    if (/^\d/.test(c)) return String.fromCharCode(Number(c));
    switch (c.toLowerCase()) {
      case 'c':
        return 'Ø';
      case 'd':
        return '°';
      case 'p':
        return '±';
      case '%':
        return '%';
      default:
        return '';
    }
  });
}

/**
 * Converts MTEXT content to plain text: formatting codes are removed, paragraphs (\P) and column
 * breaks (\N) become '\n', stacked fractions (\S1^2;) become "1/2", escapes are decoded.
 */
export function mtextToPlain(src: string): string {
  if (!src) return '';
  let out = '';
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];
    if (ch === '\\') {
      const d = src[i + 1];
      if (d === undefined) {
        i++;
        continue;
      }
      switch (d) {
        case 'P':
        case 'N':
        case 'X':
          out += '\n';
          i += 2;
          break;
        case '~':
          out += ' ';
          i += 2;
          break;
        case '\\':
        case '{':
        case '}':
          out += d;
          i += 2;
          break;
        case 'L':
        case 'l':
        case 'O':
        case 'o':
        case 'K':
        case 'k':
          i += 2;
          break;
        case 'A':
        case 'a':
        case 'C':
        case 'c':
        case 'F':
        case 'f':
        case 'H':
        case 'h':
        case 'Q':
        case 'q':
        case 'T':
        case 't':
        case 'W':
        case 'w':
        case 'p': {
          const end = src.indexOf(';', i + 2);
          i = end < 0 ? n : end + 1;
          break;
        }
        case 'S': {
          let j = i + 2;
          let body = '';
          while (j < n && src[j] !== ';') {
            if (src[j] === '\\' && j + 1 < n) {
              body += src[j + 1];
              j += 2;
            } else body += src[j++];
          }
          i = j + 1;
          const k = body.search(/[\^/#]/);
          if (k < 0) out += body;
          else {
            const a = body.slice(0, k).trim();
            const b = body.slice(k + 1).trim();
            out += b ? (a ? `${a}/${b}` : b) : a;
          }
          break;
        }
        case 'U': {
          const m = /^\\U\+([0-9A-Fa-f]{4})/.exec(src.slice(i, i + 7));
          if (m) {
            out += String.fromCharCode(parseInt(m[1], 16));
            i += 7;
          } else {
            out += 'U';
            i += 2;
          }
          break;
        }
        case 'M': {
          const m = /^\\M\+([1-5])([0-9A-Fa-f]{4})/.exec(src.slice(i, i + 8));
          if (m) {
            out += decodeMbcs(m[1], m[2]);
            i += 8;
          } else {
            out += 'M';
            i += 2;
          }
          break;
        }
        default:
          out += d;
          i += 2;
      }
    } else if (ch === '{' || ch === '}') {
      i++;
    } else if (ch === '^' && i + 1 < n) {
      const c2 = src.charCodeAt(i + 1);
      if (c2 === 32) {
        out += '^';
        i += 2;
      } else if (c2 >= 64 && c2 <= 95) {
        if (c2 === 73) out += '\t';
        else if (c2 === 74) out += '\n';
        i += 2;
      } else {
        out += '^';
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return decodeTextCodes(out);
}
