/**
 * Minimal streaming XML scanner for OOXML parts (no DOMParser, so it runs in workers). Element
 * and attribute names are reported without namespace prefix (`x:row` → `row`); attributes are also
 * stored under their qualified name. DOCTYPE declarations are skipped and custom entities are
 * never expanded (no XXE / entity expansion attacks).
 */

export type XmlAttrs = Record<string, string>;

export interface XmlHandler {
  open?(name: string, attrs: XmlAttrs, selfClosing: boolean): void;
  close?(name: string): void;
  /** Character data between tags, already entity-decoded. */
  text?(text: string): void;
}

const ENTITY_RE = /&(#\d{1,7}|#x[0-9a-fA-F]{1,6}|lt|gt|amp|quot|apos);/g;

function entity(m: string, body: string): string {
  switch (body) {
    case 'lt':
      return '<';
    case 'gt':
      return '>';
    case 'amp':
      return '&';
    case 'quot':
      return '"';
    case 'apos':
      return "'";
  }
  const cp = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
  if (!Number.isFinite(cp) || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return m;
  return String.fromCodePoint(cp);
}

/** Decodes the predefined XML entities and numeric character references. */
export function decodeXmlEntities(s: string): string {
  return s.indexOf('&') < 0 ? s : s.replace(ENTITY_RE, entity);
}

/** Escapes text for element content. */
export function escapeXmlText(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'));
}

/** Escapes text for a double-quoted attribute value. */
export function escapeXmlAttr(s: string): string {
  return s.replace(/[&<>"\t\n\r]/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return `&#${c.charCodeAt(0)};`;
    }
  });
}

function localName(qname: string): string {
  const c = qname.indexOf(':');
  return c < 0 ? qname : qname.slice(c + 1);
}

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13;
}

/** Skips a `<!DOCTYPE …>` (or other `<!…>`) declaration including an internal subset. */
function skipDeclaration(xml: string, lt: number): number {
  let depth = 0;
  for (let i = lt + 2; i < xml.length; i++) {
    const c = xml[i];
    if (c === '[') depth++;
    else if (c === ']') depth--;
    else if (c === '>' && depth <= 0) return i + 1;
  }
  return xml.length;
}

function parseAttrs(xml: string, start: number, end: number): XmlAttrs {
  const attrs: XmlAttrs = {};
  let i = start;
  while (i < end) {
    while (i < end && isSpace(xml.charCodeAt(i))) i++;
    if (i >= end) break;
    const nameStart = i;
    while (i < end) {
      const c = xml.charCodeAt(i);
      if (c === 61 /* = */ || isSpace(c)) break;
      i++;
    }
    const qname = xml.slice(nameStart, i);
    while (i < end && isSpace(xml.charCodeAt(i))) i++;
    if (xml.charCodeAt(i) !== 61) break; // malformed: attribute without value
    i++;
    while (i < end && isSpace(xml.charCodeAt(i))) i++;
    const q = xml[i];
    if (q !== '"' && q !== "'") break;
    const vEnd = xml.indexOf(q, i + 1);
    if (vEnd < 0 || vEnd > end) break;
    const value = decodeXmlEntities(xml.slice(i + 1, vEnd));
    attrs[qname] = value;
    const local = localName(qname);
    if (local !== qname && !(local in attrs)) attrs[local] = value;
    i = vEnd + 1;
  }
  return attrs;
}

/** Finds the `>` ending a start tag, skipping quoted attribute values. */
function findTagEnd(xml: string, from: number): number {
  let quote = 0;
  for (let i = from; i < xml.length; i++) {
    const c = xml.charCodeAt(i);
    if (quote) {
      if (c === quote) quote = 0;
    } else if (c === 34 || c === 39) {
      quote = c;
    } else if (c === 62) {
      return i;
    }
  }
  return -1;
}

/** Scans `xml`, calling the handler for start tags, end tags and character data. */
export function scanXml(xml: string, h: XmlHandler): void {
  const n = xml.length;
  let i = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  const onText = h.text;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      if (onText) onText(decodeXmlEntities(xml.slice(i)));
      break;
    }
    if (lt > i && onText) onText(decodeXmlEntities(xml.slice(i, lt)));
    const c = xml.charCodeAt(lt + 1);
    if (c === 33 /* ! */) {
      if (xml.startsWith('<!--', lt)) {
        const e = xml.indexOf('-->', lt + 4);
        i = e < 0 ? n : e + 3;
      } else if (xml.startsWith('<![CDATA[', lt)) {
        const e = xml.indexOf(']]>', lt + 9);
        if (onText) onText(xml.slice(lt + 9, e < 0 ? n : e));
        i = e < 0 ? n : e + 3;
      } else {
        i = skipDeclaration(xml, lt);
      }
      continue;
    }
    if (c === 63 /* ? */) {
      const e = xml.indexOf('?>', lt + 2);
      i = e < 0 ? n : e + 2;
      continue;
    }
    if (c === 47 /* / */) {
      const e = xml.indexOf('>', lt + 2);
      if (e < 0) break;
      h.close?.(localName(xml.slice(lt + 2, e).trim()));
      i = e + 1;
      continue;
    }
    const e = findTagEnd(xml, lt + 1);
    if (e < 0) break;
    let nameEnd = lt + 1;
    while (nameEnd < e) {
      const k = xml.charCodeAt(nameEnd);
      if (isSpace(k) || k === 47 /* / */) break;
      nameEnd++;
    }
    const selfClosing = xml.charCodeAt(e - 1) === 47;
    const name = localName(xml.slice(lt + 1, nameEnd));
    const attrsEnd = selfClosing ? e - 1 : e;
    const attrs = nameEnd < attrsEnd ? parseAttrs(xml, nameEnd, attrsEnd) : {};
    h.open?.(name, attrs, selfClosing);
    if (selfClosing) h.close?.(name);
    i = e + 1;
  }
}
