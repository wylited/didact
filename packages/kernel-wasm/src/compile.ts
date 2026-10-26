// compile.ts — the teaching-WAT front end. Three stages, all line-mapped:
//   1. scan the (module …) items — imports (didact print/print_char only),
//      (memory n), (global …) and function signatures — so forward calls
//      work in any order;
//   2. flatten each function body: folded expressions like
//      (i32.add (i32.const 1) (i32.const 2)) become the flat instruction
//      sequence the stack panel shows, each instruction keeping the line
//      of the `(` that opened it;
//   3. validate every flattened body by simulating stack heights over a
//      control stack — nothing executes until this passes.
// i32 is the only value type: i64/f32/f64 and every opcode outside the
// subset are refused with clean "not in the teaching subset" errors.

import type { Atom, Lst, Node } from './reader';
import { WatError, isAtom, isList, isStr, parseModule } from './reader';

export const MAX_PAGES = 64;
export const PAGE_SIZE = 65536;
export const BUDGET = 1_000_000;

/** One flat instruction. `op` is the canonical mnemonic or a structural
 *  marker (block/loop/if/else/end); `opcode` is the real WebAssembly
 *  binary opcode — the bytes column of the listing panel, and exactly the
 *  format the C lesson's compiled binary uses. */
export interface Instr {
  op: string;
  line: number;             // 1-based line of the `(` this came from
  text: string;             // listing rendering, e.g. 'br 0 → loop $again'
  opcode: number;
  imm?: number;             // const value · br depth · var/func index · mem offset · if: pc of its else marker
  label?: string | null;    // the $label written on block/loop/if, if any
  match?: number;           // block/loop/if → its end · else → the end · end → its opener
  arity?: number;           // result arity of block/loop/if/else/end
  funcKind?: 'func';        // the implicit end that returns from the function
}

export interface FuncDef {
  name: string;             // '$fact' · imports: '$print'/'$print_char' · unnamed: '#index'
  index: number;            // function index — imports occupy the first slots
  exportName: string | null; // inline (export "…"), if written
  paramCount: number;
  localCount: number;       // declared (local …)s, after the params
  localNames: (string | null)[]; // parallel to local indices
  resultArity: number;      // 0 or 1
  line: number;             // func header line
  import: boolean;
  code: Instr[];            // flat instruction sequence (imports: empty)
}

export interface GlobalDef {
  name: string | null;
  index: number;
  mutable: boolean;
  init: number;
  line: number;
}

export interface Module {
  funcs: FuncDef[];         // imports first, then defined functions, in index order
  globals: GlobalDef[];
  memoryPages: number;      // -1 when no (memory …) was declared
  mainIndex: number;
  instrCount: number;
}

// Simple stack instructions: a static table of arity signatures carrying
// the real binary opcodes. Control flow is translated structurally instead.
interface SimpleOp { opcode: number; pops: number; pushes: number; bytes?: number }
const OPS: Record<string, SimpleOp> = {
  nop: { opcode: 0x01, pops: 0, pushes: 0 },
  drop: { opcode: 0x1a, pops: 1, pushes: 0 },
  select: { opcode: 0x1b, pops: 3, pushes: 1 },
  'i32.load': { opcode: 0x28, pops: 1, pushes: 1, bytes: 4 },
  'i32.load8_s': { opcode: 0x2c, pops: 1, pushes: 1, bytes: 1 },
  'i32.load8_u': { opcode: 0x2d, pops: 1, pushes: 1, bytes: 1 },
  'i32.load16_s': { opcode: 0x2e, pops: 1, pushes: 1, bytes: 2 },
  'i32.load16_u': { opcode: 0x2f, pops: 1, pushes: 1, bytes: 2 },
  'i32.store': { opcode: 0x36, pops: 2, pushes: 0, bytes: 4 },
  'i32.store8': { opcode: 0x3a, pops: 2, pushes: 0, bytes: 1 },
  'i32.store16': { opcode: 0x3b, pops: 2, pushes: 0, bytes: 2 },
  'memory.size': { opcode: 0x3f, pops: 0, pushes: 1 },
  'memory.grow': { opcode: 0x40, pops: 1, pushes: 1 },
  'i32.const': { opcode: 0x41, pops: 0, pushes: 1 },
  'i32.eqz': { opcode: 0x45, pops: 1, pushes: 1 },
  'i32.eq': { opcode: 0x46, pops: 2, pushes: 1 },
  'i32.ne': { opcode: 0x47, pops: 2, pushes: 1 },
  'i32.lt_s': { opcode: 0x48, pops: 2, pushes: 1 },
  'i32.lt_u': { opcode: 0x49, pops: 2, pushes: 1 },
  'i32.gt_s': { opcode: 0x4a, pops: 2, pushes: 1 },
  'i32.gt_u': { opcode: 0x4b, pops: 2, pushes: 1 },
  'i32.le_s': { opcode: 0x4c, pops: 2, pushes: 1 },
  'i32.le_u': { opcode: 0x4d, pops: 2, pushes: 1 },
  'i32.ge_s': { opcode: 0x4e, pops: 2, pushes: 1 },
  'i32.ge_u': { opcode: 0x4f, pops: 2, pushes: 1 },
  'i32.add': { opcode: 0x6a, pops: 2, pushes: 1 },
  'i32.sub': { opcode: 0x6b, pops: 2, pushes: 1 },
  'i32.mul': { opcode: 0x6c, pops: 2, pushes: 1 },
  'i32.div_s': { opcode: 0x6d, pops: 2, pushes: 1 },
  'i32.div_u': { opcode: 0x6e, pops: 2, pushes: 1 },
  'i32.rem_s': { opcode: 0x6f, pops: 2, pushes: 1 },
  'i32.rem_u': { opcode: 0x70, pops: 2, pushes: 1 },
  'i32.and': { opcode: 0x71, pops: 2, pushes: 1 },
  'i32.or': { opcode: 0x72, pops: 2, pushes: 1 },
  'i32.xor': { opcode: 0x73, pops: 2, pushes: 1 },
  'i32.shl': { opcode: 0x74, pops: 2, pushes: 1 },
  'i32.shr_s': { opcode: 0x75, pops: 2, pushes: 1 },
  'i32.shr_u': { opcode: 0x76, pops: 2, pushes: 1 },
};

const INT_LITERAL = /^[+-]?(0x[0-9a-f]+|\d+)$/i;

/** Parse an i32 literal (decimal or 0x hex) into its int32 value. The
 *  subset takes the full wasm literal range -2³1 … 2³²-1, so 0xFFFFFFFF
 *  and -1 are the same bit pattern. */
export function parseInt32(text: string, line: number): number {
  if (!INT_LITERAL.test(text)) {
    throw new WatError(`'${text}' is not an integer literal — write decimal or 0x hex`, line);
  }
  const v = Number(text);
  if (!Number.isSafeInteger(v) || v < -2147483648 || v > 4294967295) {
    throw new WatError(`'${text}' does not fit in 32 bits — i32 literals run from -2147483648 to 4294967295`, line);
  }
  return v | 0;
}

/** The atom head of a list node, or null for anything else. */
function headOf(n: Node): string | null {
  return isList(n) && n.items.length > 0 && isAtom(n.items[0]) ? n.items[0].text : null;
}

// ── stage 1: module items ─────────────────────────────────────────────────

function parseImport(item: Lst): { def: FuncDef; field: string } {
  const parts = item.items;
  if (parts.length !== 4 || !isStr(parts[1]) || !isStr(parts[2]) || !isList(parts[3])) {
    throw new WatError('imports must be (import "didact" "print" (func $print (param i32)))', item.line);
  }
  const module = parts[1].text;
  const field = parts[2].text;
  if (module !== 'didact') {
    throw new WatError(`import module "${module}" is not in the teaching subset — only "didact" provides host functions`, item.line);
  }
  if (field !== 'print' && field !== 'print_char') {
    throw new WatError(`didact "${field}" is not in the teaching subset — only "print" and "print_char" exist`, item.line);
  }
  const func = parts[3];
  if (headOf(func) !== 'func' || func.items.length !== 3) {
    throw new WatError(`the import body is one clause: (func $${field} (param i32))`, func.line);
  }
  const nameNode = func.items[1]!;
  const clause = func.items[2]!;
  if (!isAtom(nameNode) || !nameNode.text.startsWith('$')) {
    throw new WatError(`name the imported function: (func $${field} (param i32))`, func.line);
  }
  if (!isList(clause) || clause.items.length !== 2 || !isAtom(clause.items[1]) || clause.items[1].text !== 'i32') {
    throw new WatError(`didact "${field}" takes exactly one i32 and returns nothing — (param i32), no (result …)`, clause.line);
  }
  if (headOf(clause) !== 'param') {
    throw new WatError(`the import signature is (param i32) only`, clause.line);
  }
  return {
    field,
    def: {
      name: nameNode.text, index: -1, exportName: null, paramCount: 1, localCount: 0,
      localNames: [null], resultArity: 0, line: item.line, import: true, code: [],
    },
  };
}

function parseMemory(item: Lst): number {
  const parts = item.items;
  if (parts.length !== 2 || !isAtom(parts[1])) {
    throw new WatError('(memory …) takes one initial page count, e.g. (memory 1) — one page is 65536 bytes', item.line);
  }
  const n = parseInt32(parts[1].text, parts[1].line);
  if (n < 0 || n > MAX_PAGES) {
    throw new WatError(`(memory ${parts[1].text}) is out of range — 0 to ${MAX_PAGES} pages`, parts[1].line);
  }
  return n;
}

function parseGlobal(item: Lst): GlobalDef {
  const parts = item.items;
  if (parts.length < 3 || parts.length > 4) {
    throw new WatError('globals must be (global $g (mut i32) (i32.const 0)) or (global $g i32 (i32.const 0))', item.line);
  }
  let i = 1;
  let name: string | null = null;
  const maybeName = parts[i];
  if (isAtom(maybeName) && maybeName.text.startsWith('$')) {
    name = maybeName.text;
    i++;
  }
  let mutable = false;
  const typeNode = parts[i];
  if (isList(typeNode)) {
    if (typeNode.items.length !== 2 || headOf(typeNode) !== 'mut') {
      throw new WatError('the only type-parenthesis in the subset is (mut i32)', typeNode.line);
    }
    mutable = true;
    checkI32(typeNode.items[1]!, 'global');
    i++;
  } else {
    checkI32(typeNode!, 'global');
    i++;
  }
  const init = parts[i];
  if (!isList(init) || headOf(init) !== 'i32.const' || init.items.length !== 2) {
    throw new WatError('a global initializer must be (i32.const N) — computed initializers are not in the teaching subset', item.line);
  }
  const initVal = init.items[1]!;
  if (!isAtom(initVal)) throw new WatError('i32.const expects an integer literal', initVal.line);
  return {
    name, index: -1, mutable,
    init: parseInt32(initVal.text, initVal.line),
    line: item.line,
  };
}

function checkI32(node: Node, where: string): void {
  if (!isAtom(node)) throw new WatError(`${where} types are plain atoms, e.g. i32`, node.line);
  if (node.text === 'i32') return;
  if (node.text === 'i64' || node.text === 'f32' || node.text === 'f64') {
    throw new WatError(`'${node.text}' is not in the teaching subset — this kernel interprets the 32-bit integer core only`, node.line);
  }
  throw new WatError(`'${node.text}' is not a value type in the teaching subset (only i32)`, node.line);
}

interface FuncHeader {
  name: string | null;
  exportName: string | null;
  resultArity: number;
  localNames: (string | null)[]; // params then locals, parallel to indices
  paramCount: number;
  body: Lst[];                   // instruction nodes
}

/** Parse (func $name? (export "…")? (param…)* (result i32)? (local…)* body…). */
function parseFuncHeader(item: Lst): FuncHeader {
  const parts = item.items;
  let i = 1;
  let name: string | null = null;
  let exportName: string | null = null;
  let resultArity = 0;
  const localNames: (string | null)[] = [];
  let paramCount = 0;
  const nameNode = parts[i];
  if (isAtom(nameNode) && nameNode.text.startsWith('$')) {
    name = nameNode.text;
    i++;
  }
  for (; i < parts.length && isList(parts[i]); i++) {
    const p = parts[i] as Lst; // the loop guard narrows this to a list
    const clause = headOf(p);
    if (clause === 'export') {
      if (p.items.length !== 2 || !isStr(p.items[1])) throw new WatError('(export "name") takes one quoted name', p.line);
      exportName = p.items[1].text;
    } else if (clause === 'param' || clause === 'local') {
      const isParam = clause === 'param';
      if (isParam && localNames.length > paramCount) {
        throw new WatError('(param …) clauses must come before (local …) clauses', p.line);
      }
      const nameNode = p.items[1];
      const typeNode = p.items[2];
      if (p.items.length === 3 && isAtom(nameNode) && nameNode.text.startsWith('$') && typeNode !== undefined) {
        checkI32(typeNode, clause);
        localNames.push(nameNode.text);
      } else if (p.items.length === 2 && isAtom(nameNode) && !nameNode.text.startsWith('$')) {
        checkI32(nameNode, clause);
        localNames.push(null);
      } else {
        throw new WatError(`${clause} clauses are (${clause} i32) or (${clause} $n i32) — one variable each`, p.line);
      }
      if (isParam) paramCount++;
    } else if (clause === 'result') {
      if (p.items.length !== 2) throw new WatError('(result) must be (result i32) — or omit it for no result', p.line);
      checkI32(p.items[1]!, 'result');
      resultArity = 1;
    } else {
      break; // first body instruction
    }
  }
  const body = parts.slice(i).map((p): Lst => {
    if (isList(p)) return p;
    throw new WatError('flat unparenthesized instructions are not in the teaching subset — write every instruction as a list, e.g. (drop)', p.line);
  });
  return { name, exportName, resultArity, localNames, paramCount, body };
}

// ── the whole front end ───────────────────────────────────────────────────

export function compile(src: string): Module {
  const mod = parseModule(src);
  const funcs: FuncDef[] = [];
  const funcByName = new Map<string, FuncDef>();
  const importedFields = new Set<string>();
  const globals: GlobalDef[] = [];
  const globalByName = new Map<string, GlobalDef>();
  const bodies: { header: FuncHeader; line: number }[] = [];
  let memoryPages = -1;

  const register = (def: FuncDef, line: number): void => {
    if (funcByName.has(def.name)) throw new WatError(`duplicate function name ${def.name}`, line);
    def.index = funcs.length;
    funcByName.set(def.name, def);
    funcs.push(def);
  };

  for (const rawItem of mod.items.slice(1)) {
    if (!isList(rawItem) || headOf(rawItem) === null) {
      throw new WatError('module items must be lists like (func …), (memory …), …', rawItem.line);
    }
    const item = rawItem;
    const head = headOf(item);
    if (head === 'import') {
      const { def, field } = parseImport(item);
      if (importedFields.has(field)) throw new WatError(`didact "${field}" is imported twice`, item.line);
      importedFields.add(field);
      register(def, item.line);
    } else if (head === 'memory') {
      if (memoryPages >= 0) throw new WatError('a module may declare at most one memory', item.line);
      memoryPages = parseMemory(item);
    } else if (head === 'global') {
      const def = parseGlobal(item);
      if (def.name !== null && globalByName.has(def.name)) throw new WatError(`duplicate global name ${def.name}`, def.line);
      def.index = globals.length;
      globals.push(def);
      if (def.name !== null) globalByName.set(def.name, def);
    } else if (head === 'func') {
      const header = parseFuncHeader(item);
      if (header.exportName !== null && header.exportName !== 'main') {
        throw new WatError(`(export "${header.exportName}") is not in the teaching subset — only (export "main") marks the entry point`, item.line);
      }
      register({
        name: header.name ?? `#${funcs.length}`,
        index: -1,
        exportName: header.exportName,
        paramCount: header.paramCount,
        localCount: header.localNames.length - header.paramCount,
        localNames: header.localNames,
        resultArity: header.resultArity,
        line: item.line,
        import: false,
        code: [],
      }, item.line);
      bodies.push({ header, line: item.line });
    } else {
      throw new WatError(`'(${head ?? '…'} …)' is not in the teaching subset — module items are import, memory, global and func`, item.line);
    }
  }

  const mainIndex = funcs.findIndex((f) => f.exportName === 'main');
  if (mainIndex < 0) {
    throw new WatError('no function exports "main" — add (export "main") to the entry (func …)', mod.line);
  }
  if (funcs[mainIndex]!.paramCount > 0) {
    throw new WatError('the (export "main") function must take no parameters — it is where execution starts', funcs[mainIndex]!.line);
  }

  // ── stages 2+3: flatten and validate every defined body ───────────────
  const ctx: Ctx = { funcs, funcByName, globals, globalByName, hasMemory: memoryPages >= 0 };
  const defined = funcs.filter((f) => !f.import);
  let instrCount = 0;
  for (let k = 0; k < defined.length; k++) {
    const def = defined[k]!;
    const { header } = bodies[k]!;
    flattenFunc(def, header, ctx);
    validateFunc(def, funcs);
    instrCount += def.code.length;
  }
  return { funcs, globals, memoryPages, mainIndex, instrCount };
}

// ── stage 2: folded → flat ────────────────────────────────────────────────

interface Ctx {
  funcs: FuncDef[];
  funcByName: Map<string, FuncDef>;
  globals: GlobalDef[];
  globalByName: Map<string, GlobalDef>;
  hasMemory: boolean;
}

interface LabelEntry { name: string | null; kind: 'block' | 'loop' | 'if' | 'func'; labelArity: number }

function flattenFunc(def: FuncDef, header: FuncHeader, ctx: Ctx): void {
  // Local names must be unique; params and locals share one index space.
  const seen = new Set<string>();
  for (const n of header.localNames) {
    if (n === null) continue;
    if (seen.has(n)) throw new WatError(`duplicate local name ${n} in ${displayFuncName(def)}`, def.line);
    seen.add(n);
  }
  const labels: LabelEntry[] = [{ name: null, kind: 'func', labelArity: def.resultArity }];
  for (const instr of header.body) flattenInstr(instr, def, ctx, labels);
  def.code.push({
    op: 'end', line: def.line, text: `end ${displayFuncName(def)}`, opcode: 0x0b,
    arity: def.resultArity, funcKind: 'func', match: -1,
  });
}

/** Flatten operands then the operator — the folded→flat rule. Arity
 * errors point at `line`: the line of the `(` that opened the operator
 * form, per the line-mapping contract. */
function flattenOperands(op: string, operands: Node[], count: number, line: number, def: FuncDef, ctx: Ctx, labels: LabelEntry[]): void {
  if (operands.length !== count) {
    throw new WatError(`${op} takes exactly ${count} folded operand${count === 1 ? '' : 's'}, got ${operands.length}`, line);
  }
  for (const node of operands) {
    if (!isList(node)) {
      throw new WatError(`an operand of ${op} must be an instruction list like (i32.const 1)`, node.line);
    }
    flattenInstr(node, def, ctx, labels);
  }
}

function resolveLabel(op: string, target: Atom, labels: LabelEntry[]): { depth: number; entry: LabelEntry } {
  if (/^\d+$/.test(target.text)) {
    const depth = Number(target.text);
    if (depth >= labels.length) {
      throw new WatError(`${op} ${depth}: label depth out of range — ${labels.length} label${labels.length === 1 ? ' encloses' : 's enclose'} this point`, target.line);
    }
    return { depth, entry: labels[labels.length - 1 - depth]! };
  }
  if (target.text.startsWith('$')) {
    for (let d = 0; d < labels.length; d++) {
      const entry = labels[labels.length - 1 - d]!;
      if (entry.name === target.text) return { depth: d, entry };
    }
    throw new WatError(`${op} ${target.text}: no enclosing block, loop or if carries that label`, target.line);
  }
  throw new WatError(`${op} expects a label depth (0, 1, …) or a $name`, target.line);
}

/** How a function is named in errors and listings — the export name
 *  ('main') when it has one, else the written $name or #index. */
function displayFuncName(def: FuncDef): string {
  return def.exportName === 'main' ? 'main' : def.name;
}

function resolveVar(kind: string, what: string, target: Atom, def: FuncDef, ctx: Ctx): { index: number; name: string | null } {
  if (/^\d+$/.test(target.text)) {
    const index = Number(target.text);
    const table = kind === 'local' ? def.localNames.length : ctx.globals.length;
    if (index >= table) {
      throw new WatError(`${what} ${index}: out of range — there ${table === 1 ? 'is 1' : `are ${table}`} ${kind}${table === 1 ? '' : 's'}`, target.line);
    }
    const names = kind === 'local' ? def.localNames : ctx.globals.map((g) => g.name);
    return { index, name: names[index] ?? null };
  }
  if (target.text.startsWith('$')) {
    if (kind === 'local') {
      const index = def.localNames.indexOf(target.text);
      if (index < 0) throw new WatError(`unknown local ${target.text} in ${displayFuncName(def)}`, target.line);
      return { index, name: target.text };
    }
    const g = ctx.globalByName.get(target.text);
    if (g === undefined) throw new WatError(`unknown global ${target.text}`, target.line);
    return { index: g.index, name: g.name };
  }
  throw new WatError(`${what} expects a $name or an index`, target.line);
}

function resolveFunc(target: Atom, ctx: Ctx): FuncDef {
  if (/^\d+$/.test(target.text)) {
    const index = Number(target.text);
    if (index >= ctx.funcs.length) {
      throw new WatError(`call ${index}: out of range — the module has ${ctx.funcs.length} function${ctx.funcs.length === 1 ? '' : 's'}`, target.line);
    }
    return ctx.funcs[index]!;
  }
  if (target.text.startsWith('$')) {
    const f = ctx.funcByName.get(target.text);
    if (f === undefined) throw new WatError(`unknown function ${target.text}`, target.line);
    return f;
  }
  throw new WatError('call expects a function $name or an index', target.line);
}

/** Pull an optional offset=N immediate off the front of a memory op. */
function memOffset(op: string, parts: Node[]): { offset: number; rest: Node[] } {
  let i = 1;
  let offset = 0;
  while (i < parts.length) {
    const imm = parts[i]!;
    if (!isAtom(imm) || !imm.text.includes('=')) break;
    const eq = imm;
    if (eq.text.startsWith('offset=')) {
      offset = parseInt32(eq.text.slice('offset='.length), eq.line);
      if (offset < 0) throw new WatError('offset= must be 0 or more', eq.line);
    } else if (eq.text.startsWith('align=')) {
      throw new WatError('align= is not in the teaching subset — accesses are naturally aligned', eq.line);
    } else {
      throw new WatError(`'${eq.text}' is not a memory immediate in the teaching subset (offset= only)`, eq.line);
    }
    i++;
  }
  return { offset, rest: parts.slice(i) };
}

function flattenInstr(n: Lst, def: FuncDef, ctx: Ctx, labels: LabelEntry[]): void {
  const parts = n.items;
  const headNode = parts[0]!;
  if (!isAtom(headNode)) {
    throw new WatError('an instruction must start with its opcode atom, e.g. (i32.add …)', n.line);
  }
  const op = headNode.text;

  // — plain stack instructions, folded operands then the operator —
  if (OPS[op] !== undefined && OPS[op].bytes === undefined && op !== 'i32.const' && op !== 'memory.size' && op !== 'memory.grow') {
    const info = OPS[op]!;
    flattenOperands(op, parts.slice(1), info.pops, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: op, opcode: info.opcode });
    return;
  }
  if (op === 'i32.const') {
    if (parts.length !== 2 || !isAtom(parts[1])) throw new WatError('i32.const takes exactly one integer literal', n.line);
    const raw = parts[1] as Atom;
    def.code.push({ op, line: n.line, text: `i32.const ${raw.text}`, opcode: 0x41, imm: parseInt32(raw.text, raw.line) });
    return;
  }
  if (op === 'memory.size' || op === 'memory.grow') {
    if (!ctx.hasMemory) throw new WatError(`${op} needs a (memory 1) declaration in the module`, n.line);
    flattenOperands(op, parts.slice(1), OPS[op]!.pops, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: op, opcode: OPS[op]!.opcode });
    return;
  }
  if (OPS[op] !== undefined && OPS[op].bytes !== undefined) {
    if (!ctx.hasMemory) throw new WatError(`${op} needs a (memory 1) declaration in the module`, n.line);
    const info = OPS[op]!;
    const { offset, rest } = memOffset(op, parts);
    flattenOperands(op, rest, info.pops, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: offset > 0 ? `${op} offset=${offset}` : op, opcode: info.opcode, imm: offset });
    return;
  }

  // — variables —
  if (op === 'local.get' || op === 'local.set' || op === 'local.tee') {
    if (parts.length < 2 || !isAtom(parts[1])) throw new WatError(`${op} takes a local $name or index`, n.line);
    const { index, name } = resolveVar('local', op, parts[1] as Atom, def, ctx);
    const display = name ?? String(index);
    if (op === 'local.get') {
      if (parts.length !== 2) throw new WatError('local.get takes only the local reference — no folded operand', n.line);
      def.code.push({ op, line: n.line, text: `local.get ${display}`, opcode: 0x20, imm: index });
      return;
    }
    flattenOperands(op, parts.slice(2), 1, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: `${op} ${display}`, opcode: op === 'local.set' ? 0x21 : 0x22, imm: index });
    return;
  }
  if (op === 'global.get' || op === 'global.set') {
    if (parts.length < 2 || !isAtom(parts[1])) throw new WatError(`${op} takes a global $name or index`, n.line);
    const { index, name } = resolveVar('global', op, parts[1] as Atom, def, ctx);
    const display = name ?? String(index);
    if (op === 'global.get') {
      if (parts.length !== 2) throw new WatError('global.get takes only the global reference — no folded operand', n.line);
      def.code.push({ op, line: n.line, text: `global.get ${display}`, opcode: 0x23, imm: index });
      return;
    }
    const g = ctx.globals[index]!;
    if (!g.mutable) throw new WatError(`${display} is immutable — global.set needs a (mut i32) global`, n.line);
    flattenOperands(op, parts.slice(2), 1, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: `global.set ${display}`, opcode: 0x24, imm: index });
    return;
  }

  // — calls and branches —
  if (op === 'call') {
    if (parts.length < 2 || !isAtom(parts[1])) throw new WatError('call takes a function $name or index', n.line);
    const callee = resolveFunc(parts[1] as Atom, ctx);
    flattenOperands(op, parts.slice(2), callee.paramCount, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: `call ${callee.name}`, opcode: 0x10, imm: callee.index });
    return;
  }
  if (op === 'br' || op === 'br_if') {
    if (parts.length < 2 || !isAtom(parts[1])) throw new WatError(`${op} takes a label depth or $name`, n.line);
    const { depth, entry } = resolveLabel(op, parts[1] as Atom, labels);
    const target = entry.kind === 'func' ? 'return' : `${entry.kind}${entry.name ? ` ${entry.name}` : ''}`;
    if (op === 'br') {
      flattenOperands(op, parts.slice(2), entry.labelArity, n.line, def, ctx, labels);
      def.code.push({ op, line: n.line, text: `br ${depth} → ${target}`, opcode: 0x0c, imm: depth });
      return;
    }
    flattenOperands(op, parts.slice(2), 1, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: `br_if ${depth} → ${target}`, opcode: 0x0d, imm: depth });
    return;
  }
  if (op === 'return') {
    flattenOperands(op, parts.slice(1), def.resultArity, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: 'return', opcode: 0x0f });
    return;
  }
  if (op === 'unreachable') {
    flattenOperands(op, parts.slice(1), 0, n.line, def, ctx, labels);
    def.code.push({ op, line: n.line, text: 'unreachable', opcode: 0x00 });
    return;
  }

  // — structured control —
  if (op === 'block' || op === 'loop') {
    const { label, arity, body } = parseStructured(op, n);
    const blockPc = def.code.length;
    def.code.push({
      op, line: n.line,
      text: `${op}${label ? ` ${label}` : ''}${arity ? ' (result i32)' : ''}`,
      opcode: op === 'block' ? 0x02 : 0x03,
      label, arity,
    });
    labels.push({ name: label, kind: op, labelArity: op === 'block' ? arity : 0 });
    for (const instr of body) flattenInstr(instr, def, ctx, labels);
    labels.pop();
    const endPc = def.code.length;
    def.code.push({ op: 'end', line: n.line, text: `end${label ? ` ${label}` : ''}`, opcode: 0x0b, arity, match: blockPc });
    def.code[blockPc]!.match = endPc;
    return;
  }
  if (op === 'if') {
    const { label, arity, cond, thenBody, elseBody } = parseIf(n);
    flattenInstr(cond, def, ctx, labels);
    const ifPc = def.code.length;
    def.code.push({
      op: 'if', line: n.line,
      text: `if${label ? ` ${label}` : ''}${arity ? ' (result i32)' : ''}`,
      opcode: 0x04, label, arity,
    });
    labels.push({ name: label, kind: 'if', labelArity: arity });
    for (const instr of thenBody) flattenInstr(instr, def, ctx, labels);
    const elsePc = def.code.length;
    def.code.push({ op: 'else', line: n.line, text: 'else', opcode: 0x05, arity });
    for (const instr of elseBody) flattenInstr(instr, def, ctx, labels);
    labels.pop();
    const endPc = def.code.length;
    def.code.push({ op: 'end', line: n.line, text: `end${label ? ` ${label}` : ''}`, opcode: 0x0b, arity, match: ifPc });
    def.code[ifPc]!.imm = elsePc;
    def.code[ifPc]!.match = endPc;
    def.code[elsePc]!.match = endPc;
    return;
  }

  if (op === 'then' || op === 'else' || op === 'end') {
    throw new WatError(`'${op}' has no meaning of its own here — the subset writes block, loop and if as parenthesized forms with no trailing end`, n.line);
  }
  if (op === 'i64' || op === 'f32' || op === 'f64' || op.startsWith('i64.') || op.startsWith('f32.') || op.startsWith('f64.')) {
    throw new WatError(`'${op}' is not in the teaching subset — this kernel interprets the 32-bit integer core only`, n.line);
  }
  if (op.startsWith('i32.') || op === 'memory.copy' || op === 'memory.fill' || op === 'memory.init') {
    throw new WatError(`'${op}' is not in the teaching subset`, n.line);
  }
  throw new WatError(`'${op}' is not an instruction in the teaching subset`, n.line);
}

/** Shared clause scan for (block $l? (result i32)? body…). */
function parseStructured(op: string, n: Lst): { label: string | null; arity: number; body: Lst[] } {
  let i = 1;
  let label: string | null = null;
  let arity = 0;
  const labelNode = n.items[i];
  if (isAtom(labelNode) && labelNode.text.startsWith('$')) {
    label = labelNode.text;
    i++;
  }
  const resultClause = n.items[i];
  if (isList(resultClause) && headOf(resultClause) === 'result') {
    if (resultClause.items.length !== 2) throw new WatError('(result) must be (result i32)', resultClause.line);
    checkI32(resultClause.items[1]!, `${op} result`);
    arity = 1;
    i++;
  }
  return { label, arity, body: n.items.slice(i).map((p): Lst => {
    if (isList(p)) return p;
    throw new WatError(`instructions inside (${op} …) must be lists — e.g. (br 0)`, p.line);
  }) };
}

/** (if $l? (result i32)? cond (then …) (else …)?) — folded WAT shape. */
function parseIf(n: Lst): { label: string | null; arity: number; cond: Lst; thenBody: Lst[]; elseBody: Lst[] } {
  let i = 1;
  let label: string | null = null;
  let arity = 0;
  const labelNode = n.items[i];
  if (isAtom(labelNode) && labelNode.text.startsWith('$')) {
    label = labelNode.text;
    i++;
  }
  const resultClause = n.items[i];
  if (isList(resultClause) && headOf(resultClause) === 'result') {
    if (resultClause.items.length !== 2) throw new WatError('(result) must be (result i32)', resultClause.line);
    checkI32(resultClause.items[1]!, 'if result');
    arity = 1;
    i++;
  }
  const rest = n.items.slice(i);
  if (rest.length < 2 || rest.length > 3) {
    throw new WatError('if takes a condition, a (then …) branch and optionally an (else …) branch', n.line);
  }
  const cond = rest[0]!;
  if (!isList(cond)) throw new WatError('the if condition must be an instruction list like (i32.eq …)', cond.line);
  const thenNode = rest[1]!;
  if (headOf(thenNode) !== 'then') throw new WatError('expected (then …) after the if condition', thenNode.line);
  const thenBody = (thenNode as Lst).items.slice(1).map((p): Lst => {
    if (isList(p)) return p;
    throw new WatError('instructions inside (then …) must be lists', p.line);
  });
  let elseBody: Lst[] = [];
  if (rest.length === 3) {
    const elseNode = rest[2]!;
    if (headOf(elseNode) !== 'else') throw new WatError('the third part of an if must be (else …)', elseNode.line);
    elseBody = (elseNode as Lst).items.slice(1).map((p): Lst => {
      if (isList(p)) return p;
      throw new WatError('instructions inside (else …) must be lists', p.line);
    });
  }
  return { label, arity, cond, thenBody, elseBody };
}

// ── stage 3: validation — stack-height simulation, nothing runs yet ───────

export function validateFunc(def: FuncDef, funcs: FuncDef[]): void {
  let vals = 0; // i32 values above the current control frame's height
  const ctrl: { height: number; labelArity: number; unreachable: boolean }[] = [
    { height: 0, labelArity: def.resultArity, unreachable: false },
  ];

  const popN = (op: string, n: number, line: number): void => {
    const frame = ctrl[ctrl.length - 1]!;
    const avail = vals - frame.height;
    if (avail < n) {
      if (frame.unreachable) {
        vals = frame.height; // phantom values: dead code after br/return
        return;
      }
      throw new WatError(`${op} needs ${n} value${n === 1 ? '' : 's'} on the stack — only ${Math.max(avail, 0)} available`, line);
    }
    vals -= n;
  };

  for (const ins of def.code) {
    const info = OPS[ins.op];
    if (ins.op === 'block' || ins.op === 'loop') {
      ctrl.push({ height: vals, labelArity: ins.op === 'block' ? ins.arity! : 0, unreachable: false });
    } else if (ins.op === 'if') {
      popN('if', 1, ins.line);
      ctrl.push({ height: vals, labelArity: ins.arity!, unreachable: false });
    } else if (ins.op === 'else') {
      const frame = ctrl[ctrl.length - 1]!;
      if (!frame.unreachable && vals !== frame.height + frame.labelArity) {
        throw new WatError(`the (then …) branch of this if must end with ${frame.labelArity} value${frame.labelArity === 1 ? '' : 's'} — found ${vals - frame.height}`, ins.line);
      }
      vals = frame.height;
      frame.unreachable = false;
    } else if (ins.op === 'end') {
      const frame = ctrl[ctrl.length - 1]!;
      if (!frame.unreachable && vals !== frame.height + ins.arity!) {
        const wants = ins.arity! === 1 ? 'exactly 1 value (result i32)' : 'no values';
        throw new WatError(`this ${ins.funcKind === 'func' ? 'function' : 'block'} must end with ${wants} — found ${vals - frame.height}`, ins.line);
      }
      vals = frame.height + ins.arity!;
      if (ctrl.length === 1) return; // the function's own end; value stays
      ctrl.pop();
    } else if (ins.op === 'br' || ins.op === 'br_if') {
      if (ins.op === 'br_if') popN('br_if', 1, ins.line);
      const target = ctrl[ctrl.length - 1 - ins.imm!]!;
      const frame = ctrl[ctrl.length - 1]!;
      if (!frame.unreachable && vals - target.height < target.labelArity) {
        throw new WatError(`${ins.op} must carry ${target.labelArity} value${target.labelArity === 1 ? '' : 's'} out of its target label — the stack has ${Math.max(vals - target.height, 0)}`, ins.line);
      }
      if (ins.op === 'br') {
        frame.unreachable = true;
        vals = frame.height;
      }
    } else if (ins.op === 'return') {
      const funcFrame = ctrl[0]!;
      if (!ctrl[ctrl.length - 1]!.unreachable && vals < funcFrame.labelArity) {
        throw new WatError(`return needs ${def.resultArity} value${def.resultArity === 1 ? '' : 's'} on the stack`, ins.line);
      }
      const frame = ctrl[ctrl.length - 1]!;
      frame.unreachable = true;
      vals = frame.height;
    } else if (ins.op === 'call') {
      const callee = funcs[ins.imm!]!;
      popN(`call ${callee.name}`, callee.paramCount, ins.line);
      vals += callee.resultArity;
    } else if (ins.op === 'unreachable') {
      const frame = ctrl[ctrl.length - 1]!;
      frame.unreachable = true;
      vals = frame.height;
    } else if (ins.op === 'local.tee') {
      popN('local.tee', 1, ins.line);
      vals++;
    } else if (ins.op === 'local.get') {
      vals++;
    } else if (ins.op === 'local.set') {
      popN('local.set', 1, ins.line);
    } else if (ins.op === 'global.get') {
      vals++;
    } else if (ins.op === 'global.set') {
      popN('global.set', 1, ins.line);
    } else if (info !== undefined) {
      popN(ins.op, info.pops, ins.line);
      vals += info.pushes;
    } else {
      throw new WatError(`internal: unvalidated op ${ins.op}`, ins.line);
    }
  }
}
