import { decodeMbcs, decodeSpecials } from './encoding';

/**
 * Converts MTEXT content (already concatenated from its code 3 chunks and final code 1) to plain
 * text: formatting codes are removed, paragraphs become '\n', stacked fractions become "a/b",
 * `\U+XXXX` / `\M+nXXXX` escapes and %% specials are decoded.
 */
export function mtextToPlain(src: string): string {
  let out = '';
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src.charCodeAt(i);
    if (ch === 92 /* \ */) {
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
          out += ' ';
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
        case 'f':
        case 'F':
        case 'H':
        case 'h':
        case 'W':
        case 'w':
        case 'Q':
        case 'q':
        case 'T':
        case 't':
        case 'A':
        case 'a':
        case 'C':
        case 'c':
        case 'p': {
          const end = src.indexOf(';', i + 2);
          i = end < 0 ? n : end + 1;
          break;
        }
        case 'S': {
          // Stacked text \Snum^den; / \Snum/den; / \Snum#den;  → "num/den"
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
          // Unknown escape: keep the character literally.
          out += d;
          i += 2;
      }
    } else if (ch === 123 /* { */ || ch === 125 /* } */) {
      i++;
    } else if (ch === 94 /* ^ */ && i + 1 < n) {
      // Caret-encoded control characters (^I tab, ^J line feed, "^ " literal caret).
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
      out += src[i++];
    }
  }
  return decodeSpecials(out);
}
