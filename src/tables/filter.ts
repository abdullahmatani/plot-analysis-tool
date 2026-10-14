import type { CellValue } from '@/core/types';

import { normaliseKey, parseNumber } from './values';

/**
 * Row filter expressions (row 71), e.g. `category = "Jet fire" AND radius > 20`. A hand-written
 * tokenizer and recursive-descent parser compile the expression into a tree of closures — no
 * eval / Function, so it is safe for untrusted input and fast for live filtering.
 *
 * Grammar (keywords case-insensitive):
 *   expr      := or
 *   or        := and (('OR' | '||') and)*
 *   and       := not (('AND' | '&&') not)*
 *   not       := ('NOT' | '!') not | predicate
 *   predicate := sum [ cmp sum
 *                    | ['NOT'] 'IN' '(' expr (',' expr)* ')'
 *                    | ['NOT'] ('CONTAINS' | 'STARTSWITH' | 'ENDSWITH' | 'LIKE') sum
 *                    | 'IS' ['NOT'] 'NULL' ]
 *   cmp       := '=' | '==' | '!=' | '<>' | '<' | '<=' | '>' | '>='
 *   sum       := product (('+' | '-' | '−') product)*
 *   product   := unary (('*' | '×' | '/' | '÷' | '%') unary)*
 *   unary     := ('-' | '−' | '+') unary | primary
 *   primary   := number | string | TRUE | FALSE | NULL | column | '(' expr ')'
 *   column    := identifier | '[' name ']' | '`' name '`'
 *
 * Semantics: string comparisons are case-insensitive; a number compared with a numeric string
 * compares numerically; `=`/`!=` treat empty cells as NULL (NULL = NULL, NULL != "x"); ordering
 * comparisons and arithmetic with NULL or non-numeric text are false/NULL. LIKE uses `%` (any run)
 * and `_` (one character).
 */

export type FilterValue = string | number | boolean | null;

export interface CompiledFilter {
  test: (row: CellValue[]) => boolean;
  columnsUsed: string[];
}

export type FilterResult = ({ ok: true } & CompiledFilter) | { ok: false; error: string; position: number };

export interface FilterOptions {
  /**
   * Extra names resolving to columns when no column of that name exists, e.g. the dataset's
   * mapping roles: `{ radius: 'Radiation 4 kW/m2 (m)', label: 'Scenario' }`.
   */
  aliases?: Record<string, string | undefined>;
}

// --- tokenizer -------------------------------------------------------------------------------------

type TokType = 'num' | 'str' | 'ident' | 'col' | 'op' | 'kw' | 'eof';

interface Token {
  type: TokType;
  value: string;
  num?: number;
  pos: number;
}

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'contains',
  'startswith',
  'endswith',
  'like',
  'is',
  'null',
  'true',
  'false',
]);

class FilterError extends Error {
  constructor(
    message: string,
    readonly position: number,
  ) {
    super(message);
  }
}

const OPS = [
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '&&',
  '||',
  '=',
  '<',
  '>',
  '!',
  '(',
  ')',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '−',
  '×',
  '÷',
];

function isIdentStart(ch: string): boolean {
  return /[\p{L}_]/u.test(ch);
}

function isIdentPart(ch: string): boolean {
  return /[\p{L}\p{N}\p{M}_.]/u.test(ch);
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === '"' || ch === "'" || ch === '“' || ch === '‘') {
      const close = ch === '“' ? '”' : ch === '‘' ? '’' : ch;
      let s = '';
      i++;
      for (;;) {
        if (i >= n) throw new FilterError('Unterminated string', start);
        const c = src[i];
        if (c === close) {
          if (src[i + 1] === close && close === ch) {
            s += c;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        if (c === '\\' && i + 1 < n && (src[i + 1] === close || src[i + 1] === '\\')) {
          s += src[i + 1];
          i += 2;
          continue;
        }
        s += c;
        i++;
      }
      tokens.push({ type: 'str', value: s, pos: start });
      continue;
    }
    if (ch === '[' || ch === '`') {
      const close = ch === '[' ? ']' : '`';
      const e = src.indexOf(close, i + 1);
      if (e < 0) throw new FilterError(`Missing closing ${close}`, start);
      tokens.push({ type: 'col', value: src.slice(i + 1, e).trim(), pos: start });
      i = e + 1;
      continue;
    }
    const numMatch = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i, i + 64));
    if (numMatch) {
      const text = numMatch[0];
      // "12abc" is an identifier-ish typo: report it at the letter.
      if (i + text.length < n && isIdentStart(src[i + text.length]) && !/[eE]/.test(src[i + text.length])) {
        throw new FilterError(`Unexpected character '${src[i + text.length]}'`, i + text.length);
      }
      tokens.push({ type: 'num', value: text, num: Number(text), pos: start });
      i += text.length;
      continue;
    }
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentPart(src[j])) j++;
      const word = src.slice(i, j);
      const lower = word.toLowerCase();
      tokens.push({
        type: KEYWORDS.has(lower) ? 'kw' : 'ident',
        value: KEYWORDS.has(lower) ? lower : word,
        pos: start,
      });
      i = j;
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) {
      tokens.push({
        type: 'op',
        value: op === '−' ? '-' : op === '×' ? '*' : op === '÷' ? '/' : op,
        pos: start,
      });
      i += op.length;
      continue;
    }
    throw new FilterError(`Unexpected character '${ch}'`, start);
  }
  tokens.push({ type: 'eof', value: '', pos: n });
  return tokens;
}

// --- value semantics ------------------------------------------------------------------------------

type Fn = (row: CellValue[]) => FilterValue;

function asNumber(v: FilterValue): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return parseNumber(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  return null;
}

function asText(v: FilterValue): string {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0']);

function asBool(v: FilterValue): boolean | null {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const k = v.trim().toLowerCase();
    if (TRUE_WORDS.has(k)) return true;
    if (FALSE_WORDS.has(k)) return false;
  }
  return null;
}

function truthy(v: FilterValue): boolean {
  if (v === null) return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0 && !Number.isNaN(v);
  const b = asBool(v);
  return b === null ? v.trim() !== '' : b;
}

const isNull = (v: FilterValue) => v === null || (typeof v === 'string' && v.trim() === '');

/** Three-way compare; null when the values are not comparable. */
function compare(a: FilterValue, b: FilterValue): number | null {
  if (isNull(a) || isNull(b)) return null;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    const x = asBool(a);
    const y = asBool(b);
    if (x === null || y === null) return null;
    return Number(x) - Number(y);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    const x = asNumber(a);
    const y = asNumber(b);
    if (x === null || y === null) return null;
    return x < y ? -1 : x > y ? 1 : 0;
  }
  const x = asNumber(a);
  const y = asNumber(b);
  if (x !== null && y !== null) return x < y ? -1 : x > y ? 1 : 0;
  const s = normaliseKey(a as string);
  const t = normaliseKey(b as string);
  return s < t ? -1 : s > t ? 1 : 0;
}

function equals(a: FilterValue, b: FilterValue): boolean {
  const an = isNull(a);
  const bn = isNull(b);
  if (an || bn) return an && bn;
  const c = compare(a, b);
  if (c !== null) return c === 0;
  return normaliseKey(asText(a)) === normaliseKey(asText(b));
}

function likeToRegExp(pattern: string): RegExp {
  let re = '';
  for (const ch of pattern) {
    if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'iu');
}

// --- parser ----------------------------------------------------------------------------------------

interface Node {
  fn: Fn;
  /** Constant value when the node is a literal (for compile-time LIKE patterns). */
  constant?: FilterValue;
  isConst?: boolean;
}

class Parser {
  private i = 0;
  readonly used = new Set<string>();
  private readonly lookup = new Map<string, number>();
  private readonly loose = new Map<string, number[]>();

  constructor(
    private readonly tokens: Token[],
    private readonly columns: string[],
    private readonly aliases: Record<string, string | undefined>,
  ) {
    columns.forEach((c, idx) => {
      const k = normaliseKey(c);
      if (!this.lookup.has(k)) this.lookup.set(k, idx);
      const l = looseKey(c);
      const arr = this.loose.get(l) ?? [];
      arr.push(idx);
      this.loose.set(l, arr);
    });
  }

  private peek(): Token {
    return this.tokens[this.i];
  }

  private next(): Token {
    return this.tokens[this.i++];
  }

  private isOp(...ops: string[]): boolean {
    const t = this.peek();
    return t.type === 'op' && ops.includes(t.value);
  }

  private isKw(...kws: string[]): boolean {
    const t = this.peek();
    return t.type === 'kw' && kws.includes(t.value);
  }

  private expectOp(op: string): void {
    const t = this.peek();
    if (t.type !== 'op' || t.value !== op) throw new FilterError(`Expected '${op}'`, t.pos);
    this.i++;
  }

  parse(): Node {
    const node = this.or();
    const t = this.peek();
    if (t.type !== 'eof') throw new FilterError(`Unexpected ${describe(t)}`, t.pos);
    return node;
  }

  private or(): Node {
    let left = this.and();
    while (this.isKw('or') || this.isOp('||')) {
      this.i++;
      const a = left.fn;
      const b = this.and().fn;
      left = { fn: (r) => truthy(a(r)) || truthy(b(r)) };
    }
    return left;
  }

  private and(): Node {
    let left = this.not();
    while (this.isKw('and') || this.isOp('&&')) {
      this.i++;
      const a = left.fn;
      const b = this.not().fn;
      left = { fn: (r) => truthy(a(r)) && truthy(b(r)) };
    }
    return left;
  }

  private not(): Node {
    if (this.isKw('not') || this.isOp('!')) {
      this.i++;
      const a = this.not().fn;
      return { fn: (r) => !truthy(a(r)) };
    }
    return this.predicate();
  }

  private predicate(): Node {
    const left = this.sum();
    const t = this.peek();
    if (t.type === 'op' && ['=', '==', '!=', '<>', '<', '<=', '>', '>='].includes(t.value)) {
      this.i++;
      const a = left.fn;
      const b = this.sum().fn;
      switch (t.value) {
        case '=':
        case '==':
          return { fn: (r) => equals(a(r), b(r)) };
        case '!=':
        case '<>':
          return { fn: (r) => !equals(a(r), b(r)) };
        case '<':
          return { fn: (r) => cmpTest(compare(a(r), b(r)), (c) => c < 0) };
        case '<=':
          return { fn: (r) => cmpTest(compare(a(r), b(r)), (c) => c <= 0) };
        case '>':
          return { fn: (r) => cmpTest(compare(a(r), b(r)), (c) => c > 0) };
        default:
          return { fn: (r) => cmpTest(compare(a(r), b(r)), (c) => c >= 0) };
      }
    }
    if (t.type === 'kw' && t.value === 'is') {
      this.i++;
      const negate = this.isKw('not');
      if (negate) this.i++;
      if (!this.isKw('null')) throw new FilterError("Expected 'NULL'", this.peek().pos);
      this.i++;
      const a = left.fn;
      return { fn: negate ? (r) => !isNull(a(r)) : (r) => isNull(a(r)) };
    }
    let negate = false;
    if (t.type === 'kw' && t.value === 'not') {
      const after = this.tokens[this.i + 1];
      if (after.type === 'kw' && ['in', 'contains', 'startswith', 'endswith', 'like'].includes(after.value)) {
        negate = true;
        this.i++;
      }
    }
    const k = this.peek();
    if (k.type === 'kw' && k.value === 'in') {
      this.i++;
      this.expectOp('(');
      const items: Fn[] = [];
      if (!this.isOp(')')) {
        items.push(this.or().fn);
        while (this.isOp(',')) {
          this.i++;
          items.push(this.or().fn);
        }
      }
      this.expectOp(')');
      const a = left.fn;
      const fn: Fn = (r) => {
        const v = a(r);
        for (const item of items) if (equals(v, item(r))) return true;
        return false;
      };
      return { fn: negate ? (r) => !fn(r) : fn };
    }
    if (k.type === 'kw' && ['contains', 'startswith', 'endswith', 'like'].includes(k.value)) {
      this.i++;
      const a = left.fn;
      const rightNode = this.sum();
      const b = rightNode.fn;
      let fn: Fn;
      if (k.value === 'like') {
        if (rightNode.isConst) {
          const re = likeToRegExp(asText(rightNode.constant ?? null));
          fn = (r) => {
            const v = a(r);
            return !isNull(v) && re.test(asText(v));
          };
        } else {
          const cache = new Map<string, RegExp>();
          fn = (r) => {
            const v = a(r);
            const p = asText(b(r));
            let re = cache.get(p);
            if (!re) {
              if (cache.size > 256) cache.clear();
              re = likeToRegExp(p);
              cache.set(p, re);
            }
            return !isNull(v) && re.test(asText(v));
          };
        }
      } else {
        const op = k.value;
        fn = (r) => {
          const v = a(r);
          if (isNull(v)) return false;
          const hay = normaliseKey(asText(v));
          const needle = normaliseKey(asText(b(r)));
          return op === 'contains'
            ? hay.includes(needle)
            : op === 'startswith'
              ? hay.startsWith(needle)
              : hay.endsWith(needle);
        };
      }
      return { fn: negate ? (r) => !fn(r) : fn };
    }
    if (negate) throw new FilterError('Unexpected NOT', t.pos);
    return left;
  }

  private sum(): Node {
    let left = this.product();
    while (this.isOp('+', '-')) {
      const op = this.next().value;
      const a = left.fn;
      const b = this.product().fn;
      left = {
        fn:
          op === '+' ? (r) => arith(a(r), b(r), (x, y) => x + y) : (r) => arith(a(r), b(r), (x, y) => x - y),
      };
    }
    return left;
  }

  private product(): Node {
    let left = this.unary();
    while (this.isOp('*', '/', '%')) {
      const op = this.next().value;
      const a = left.fn;
      const b = this.unary().fn;
      const f =
        op === '*'
          ? (x: number, y: number) => x * y
          : op === '/'
            ? (x: number, y: number) => (y === 0 ? NaN : x / y)
            : (x: number, y: number) => (y === 0 ? NaN : x % y);
      left = { fn: (r) => arith(a(r), b(r), f) };
    }
    return left;
  }

  private unary(): Node {
    if (this.isOp('-', '+')) {
      const op = this.next().value;
      const inner = this.unary();
      if (inner.isConst && typeof inner.constant === 'number') {
        const v = op === '-' ? -inner.constant : inner.constant;
        return { fn: () => v, constant: v, isConst: true };
      }
      const a = inner.fn;
      return {
        fn: (r) => {
          const x = asNumber(a(r));
          return x === null ? null : op === '-' ? -x : x;
        },
      };
    }
    return this.primary();
  }

  private primary(): Node {
    const t = this.next();
    switch (t.type) {
      case 'num': {
        const v = t.num!;
        return { fn: () => v, constant: v, isConst: true };
      }
      case 'str': {
        const v = t.value;
        return { fn: () => v, constant: v, isConst: true };
      }
      case 'kw':
        if (t.value === 'true' || t.value === 'false') {
          const v = t.value === 'true';
          return { fn: () => v, constant: v, isConst: true };
        }
        if (t.value === 'null') return { fn: () => null, constant: null, isConst: true };
        throw new FilterError(`Unexpected keyword '${t.value.toUpperCase()}'`, t.pos);
      case 'ident':
      case 'col': {
        const idx = this.resolve(t);
        this.used.add(this.columns[idx]);
        return { fn: (r) => cellToValue(r[idx]) };
      }
      case 'op':
        if (t.value === '(') {
          const node = this.or();
          this.expectOp(')');
          return node;
        }
        throw new FilterError(`Unexpected '${t.value}'`, t.pos);
      default:
        throw new FilterError('Unexpected end of expression', t.pos);
    }
  }

  private resolve(t: Token): number {
    const key = normaliseKey(t.value);
    const exact = this.lookup.get(key);
    if (exact !== undefined) return exact;
    for (const [alias, column] of Object.entries(this.aliases)) {
      if (column === undefined || normaliseKey(alias) !== key) continue;
      const idx = this.lookup.get(normaliseKey(column));
      if (idx !== undefined) return idx;
    }
    // Loose match: punctuation/spacing and unit suffixes ignored ("radiation_4_kw_m2" → "Radiation 4 kW/m2 (m)").
    const loose = this.loose.get(looseKey(t.value));
    if (loose && loose.length === 1) return loose[0];
    if (loose && loose.length > 1) throw new FilterError(`Ambiguous column '${t.value}'`, t.pos);
    throw new FilterError(`Unknown column '${t.value}'`, t.pos);
  }
}

function looseKey(s: string): string {
  return normaliseKey(s)
    .replace(/\s*[([][^)\]]*[)\]]\s*$/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

function cmpTest(c: number | null, pred: (c: number) => boolean): boolean {
  return c !== null && pred(c);
}

function arith(a: FilterValue, b: FilterValue, f: (x: number, y: number) => number): FilterValue {
  const x = asNumber(a);
  const y = asNumber(b);
  if (x === null || y === null) return null;
  const v = f(x, y);
  return Number.isFinite(v) ? v : null;
}

function cellToValue(v: CellValue | undefined): FilterValue {
  return v === undefined ? null : v;
}

function describe(t: Token): string {
  switch (t.type) {
    case 'eof':
      return 'end of expression';
    case 'str':
      return `string "${t.value}"`;
    case 'kw':
      return `keyword '${t.value.toUpperCase()}'`;
    default:
      return `'${t.value}'`;
  }
}

/**
 * Compiles a filter expression against the given columns. An empty expression accepts every row.
 * Errors carry a 0-based character position for highlighting in the editor.
 */
export function compileFilter(expr: string, columns: string[], opts: FilterOptions = {}): FilterResult {
  if (expr.trim() === '') return { ok: true, test: () => true, columnsUsed: [] };
  try {
    const parser = new Parser(tokenize(expr), columns, opts.aliases ?? {});
    const node = parser.parse();
    const fn = node.fn;
    return { ok: true, test: (row) => truthy(fn(row)), columnsUsed: [...parser.used] };
  } catch (e) {
    if (e instanceof FilterError) return { ok: false, error: e.message, position: e.position };
    throw e;
  }
}
