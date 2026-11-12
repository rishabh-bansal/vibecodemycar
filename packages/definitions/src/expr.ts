// Safe formula language for obd.json. No eval: formulas are parsed into a small AST.
// Bytes are A..Z (A = first data byte after the PID). Integer bitwise operators work
// on unsigned values up to 32 bits (and beyond, via BigInt), so (A<<24) never goes negative.

export type Node =
  | { t: 'num'; v: number; text: string }
  | { t: 'byte'; name: string; index: number }
  | { t: 'un'; op: '-' | '~' | '!'; a: Node }
  | { t: 'bin'; op: string; a: Node; b: Node }
  | { t: 'cond'; c: Node; a: Node; b: Node }
  | { t: 'call'; fn: string; args: Node[] };

/** Allowed argument counts per function: [min, max]. */
const ARITY: Record<string, readonly [number, number]> = {
  s8: [1, 1], s16: [1, 1], s32: [1, 1], abs: [1, 1], bit: [2, 2], min: [1, 8], max: [1, 8],
};

const FUNCS: Record<string, (...x: number[]) => number> = {
  s8: (x) => (x & 0x80 ? x - 0x100 : x),
  s16: (x) => (x & 0x8000 ? x - 0x10000 : x),
  s32: (x) => (x >= 0x80000000 ? x - 0x100000000 : x),
  min: (...x) => Math.min(...x),
  max: (...x) => Math.max(...x),
  abs: (x) => Math.abs(x),
  bit: (x, n) => Math.floor(x / 2 ** n) % 2,
};

// binding power: higher binds tighter
const BIN: Record<string, number> = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5,
  '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7,
  '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

type Tok = { k: 'num' | 'id' | 'op' | 'end'; v: string };

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t') { i++; continue; }
    const rest = src.slice(i);
    const num = /^(0x[0-9a-fA-F]+|\d+(\.\d+)?([eE][-+]?\d+)?)/.exec(rest);
    if (num) { out.push({ k: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (id) { out.push({ k: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%&|^~!()<>?:,])/.exec(rest);
    if (op) { out.push({ k: 'op', v: op[0] }); i += op[0].length; continue; }
    throw new Error(`formula: unexpected '${c}' in ${src}`);
  }
  out.push({ k: 'end', v: '' });
  return out;
}

export function parse(src: string): Node {
  const toks = tokenize(src);
  let p = 0;
  // Nesting is bounded so a malformed definition fails with a message, not a stack overflow.
  let depth = 0;
  const peek = () => toks[p]!;
  const next = () => toks[p++]!;
  const expect = (v: string) => {
    const t = next();
    if (t.v !== v) throw new Error(`formula: expected '${v}' in ${src}`);
  };

  function primary(): Node {
    const t = next();
    if (t.k === 'num') return { t: 'num', v: Number(t.v), text: t.v };
    if (t.k === 'id') {
      if (peek().v === '(') {
        next();
        // Own properties only: `in` would also accept Object.prototype names (constructor, toString…).
        if (!Object.hasOwn(FUNCS, t.v)) throw new Error(`formula: unknown function ${t.v}`);
        const args: Node[] = [];
        if (peek().v !== ')') {
          args.push(expr(0));
          while (peek().v === ',') { next(); args.push(expr(0)); }
        }
        expect(')');
        const [lo, hi] = ARITY[t.v]!;
        if (args.length < lo || args.length > hi)
          throw new Error(`formula: ${t.v} takes ${lo === hi ? lo : `${lo}–${hi}`} argument${hi === 1 ? '' : 's'}, got ${args.length}`);
        return { t: 'call', fn: t.v, args };
      }
      if (/^[A-Z]$/.test(t.v)) return { t: 'byte', name: t.v, index: t.v.charCodeAt(0) - 65 };
      throw new Error(`formula: unknown name ${t.v}`);
    }
    if (t.v === '(') { const e = expr(0); expect(')'); return e; }
    if (t.v === '-' || t.v === '~' || t.v === '!') return { t: 'un', op: t.v, a: expr(11) };
    throw new Error(`formula: unexpected '${t.v}' in ${src}`);
  }

  function expr(minBp: number): Node {
    if (++depth > 200) throw new Error('formula: nested too deeply');
    try {
      return exprAt(minBp);
    } finally {
      depth--;
    }
  }
  function exprAt(minBp: number): Node {
    let left = primary();
    for (;;) {
      const t = peek();
      if (t.k !== 'op') break;
      if (t.v === '?') {
        if (minBp > 0) break;
        next();
        const a = expr(0);
        expect(':');
        const b = expr(0);
        left = { t: 'cond', c: left, a, b };
        continue;
      }
      const bp = BIN[t.v];
      if (bp === undefined || bp <= minBp) break;
      next();
      left = { t: 'bin', op: t.v, a: left, b: expr(bp) };
    }
    return left;
  }

  const e = expr(0);
  if (peek().k !== 'end') throw new Error(`formula: trailing input in ${src}`);
  return e;
}

const big = (x: number) => BigInt(Math.trunc(x));

function binop(op: string, a: number, b: number): number {
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '*': return a * b;
    case '/': return a / b;
    case '%': return a % b;
    case '<<': return a * 2 ** b;
    case '>>': return Math.floor(a / 2 ** b);
    case '&': return Number(big(a) & big(b));
    case '|': return Number(big(a) | big(b));
    case '^': return Number(big(a) ^ big(b));
    case '==': return a === b ? 1 : 0;
    case '!=': return a !== b ? 1 : 0;
    case '<': return a < b ? 1 : 0;
    case '<=': return a <= b ? 1 : 0;
    case '>': return a > b ? 1 : 0;
    case '>=': return a >= b ? 1 : 0;
    case '&&': return a && b ? 1 : 0;
    case '||': return a || b ? 1 : 0;
  }
  throw new Error(`formula: bad operator ${op}`);
}

export function evaluate(n: Node, bytes: ArrayLike<number>): number {
  switch (n.t) {
    case 'num': return n.v;
    case 'byte': {
      const v = bytes[n.index];
      if (v === undefined) throw new RangeError(`byte ${n.name} missing`);
      return v;
    }
    case 'un': {
      const a = evaluate(n.a, bytes);
      if (n.op === '-') return -a;
      if (n.op === '!') return a ? 0 : 1;
      return Number(~big(a) & 0xffffffffn);
    }
    case 'bin': return binop(n.op, evaluate(n.a, bytes), evaluate(n.b, bytes));
    case 'cond': return evaluate(n.c, bytes) ? evaluate(n.a, bytes) : evaluate(n.b, bytes);
    case 'call': return FUNCS[n.fn]!(...n.args.map((a) => evaluate(a, bytes)));
  }
}

/** Highest byte index the formula reads (-1 when it reads none). */
export function maxByteIndex(n: Node): number {
  switch (n.t) {
    case 'num': return -1;
    case 'byte': return n.index;
    case 'un': return maxByteIndex(n.a);
    case 'bin': return Math.max(maxByteIndex(n.a), maxByteIndex(n.b));
    case 'cond': return Math.max(maxByteIndex(n.c), maxByteIndex(n.a), maxByteIndex(n.b));
    case 'call': return Math.max(-1, ...n.args.map(maxByteIndex));
  }
}

export function bytesUsed(n: Node, acc = new Set<number>()): Set<number> {
  switch (n.t) {
    case 'byte': acc.add(n.index); break;
    case 'un': bytesUsed(n.a, acc); break;
    case 'bin': bytesUsed(n.a, acc); bytesUsed(n.b, acc); break;
    case 'cond': bytesUsed(n.c, acc); bytesUsed(n.a, acc); bytesUsed(n.b, acc); break;
    case 'call': n.args.forEach((a) => bytesUsed(a, acc)); break;
    default: break;
  }
  return acc;
}

/** Re-prints the formula with byte letters replaced by their decimal values. */
export function substitute(n: Node, bytes: ArrayLike<number>, parentBp = 0): string {
  switch (n.t) {
    case 'num': return n.text;
    case 'byte': return String(bytes[n.index] ?? '?');
    case 'un': return `${n.op}${substitute(n.a, bytes, 11)}`;
    case 'call': return `${n.fn}(${n.args.map((a) => substitute(a, bytes)).join(', ')})`;
    case 'cond': {
      const s = `${substitute(n.c, bytes)} ? ${substitute(n.a, bytes)} : ${substitute(n.b, bytes)}`;
      return parentBp > 0 ? `(${s})` : s;
    }
    case 'bin': {
      const bp = BIN[n.op]!;
      const s = `${substitute(n.a, bytes, bp - 0.5)}${spaced(n.op)}${substitute(n.b, bytes, bp)}`;
      return bp <= parentBp ? `(${s})` : s;
    }
  }
}

function spaced(op: string): string {
  return op === '*' || op === '/' ? op : ` ${op} `;
}

export interface Compiled {
  source: string;
  ast: Node;
  maxByte: number;
  bytes: number[];
  run(bytes: ArrayLike<number>): number;
}

const cache = new Map<string, Compiled>();

export function compile(source: string): Compiled {
  const hit = cache.get(source);
  if (hit) return hit;
  const ast = parse(source);
  const c: Compiled = {
    source,
    ast,
    maxByte: maxByteIndex(ast),
    bytes: [...bytesUsed(ast)].sort((a, b) => a - b),
    run: (bytes) => evaluate(ast, bytes),
  };
  cache.set(source, c);
  return c;
}
