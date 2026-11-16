/* POSIX/bash-like shell tokenizer and parser. */

export class ShellSyntaxError extends Error {
  constructor(message, pos = 0) {
    super(`syntax error: ${message} (at char ${pos})`);
    this.name = 'ShellSyntaxError';
    this.pos = pos;
  }
}

const REDIR_OPS = new Set(['<', '>', '>>', '<<', '<<-', '<<<', '<>', '>&', '<&', '&>', '&>>', '>|']);
const OPS = ['<<<', '<<-', '&>>', ';;&', '&&', '||', '|&', ';;', ';&', '<<', '>>', '>&', '<&', '&>', '>|', '<', '>', '|', '&', ';', '(', ')'];

const isNameStart = (c) => /[A-Za-z_]/.test(c);
const isNameChar = (c) => /[A-Za-z0-9_]/.test(c);

class Scanner {
  constructor(src) { this.src = src; this.i = 0; }
  eof() { return this.i >= this.src.length; }
  peek(n = 0) { return this.src[this.i + n]; }
  matchOp() {
    for (const op of OPS) if (this.src.startsWith(op, this.i)) return op;
    return null;
  }
  readBalanced(openIdx, open, close) {
    // this.i is just after the opening token
    let depth = 1;
    let quote = null;
    const start = this.i;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (quote) {
        if (c === '\\' && quote === '"') { this.i += 2; continue; }
        if (c === quote) { quote = null; this.i++; continue; }
        this.i++; continue;
      }
      if (c === "'" || c === '"') { quote = c; this.i++; continue; }
      if (c === '\\') { this.i += 2; continue; }
      if (c === open) { depth++; this.i++; continue; }
      if (c === close) {
        depth--;
        if (depth === 0) { const inner = this.src.slice(start, this.i); this.i++; return inner; }
        this.i++; continue;
      }
      this.i++;
    }
    throw new ShellSyntaxError(`unterminated ${open}`, this.i);
  }
  readDollar(quoted) {
    const start = this.i;
    this.i++; // skip $
    const c = this.peek();
    if (c === '(') {
      if (this.peek(1) === '(') {
        this.i += 2;
        let depth = 0;
        const s = this.i;
        while (this.i < this.src.length) {
          const ch = this.src[this.i];
          if (ch === '(') { depth++; this.i++; continue; }
          if (ch === ')') {
            if (depth === 0 && this.src[this.i + 1] === ')') {
              const inner = this.src.slice(s, this.i);
              this.i += 2;
              return { t: 'arith', src: inner, q: quoted };
            }
            depth--; this.i++; continue;
          }
          if (ch === "'" || ch === '"') { this.readQuotedRaw(ch); continue; }
          if (ch === '\\') { this.i += 2; continue; }
          this.i++;
        }
        throw new ShellSyntaxError('unterminated arithmetic expansion', start);
      }
      this.i++;
      const inner = this.readBalanced(1, '(', ')');
      return { t: 'cmdsub', src: inner, q: quoted };
    }
    if (c === '{') {
      this.i++;
      const inner = this.readBalanced(1, '{', '}');
      return { t: 'param', raw: inner, q: quoted };
    }
    if (c === "'") {
      this.i++;
      let out = '';
      while (this.i < this.src.length && this.peek() !== "'") {
        if (this.peek() === '\\') { out += decodeAnsiEscape(this.src.slice(this.i)); this.i += ansiEscapeLength(this.src.slice(this.i)); }
        else { out += this.peek(); this.i++; }
      }
      if (this.peek() === "'") this.i++;
      return { t: 'lit', v: out, q: true };
    }
    if (c === '"') {
      this.i++;
      const parts = this.readDoubleQuoted();
      return { t: 'compound', parts, q: true };
    }
    if (c && isNameStart(c)) {
      let name = '';
      while (!this.eof() && isNameChar(this.peek())) { name += this.peek(); this.i++; }
      return { t: 'param', name, q: quoted };
    }
    if (c && /[0-9]/.test(c)) {
      this.i++;
      return { t: 'param', name: c, q: quoted };
    }
    if (c && '@*#?$!-'.includes(c)) {
      this.i++;
      return { t: 'param', name: c, q: quoted };
    }
    return { t: 'lit', v: '$', q: quoted };
  }
  readQuotedRaw(q) {
    this.i++;
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === '\\') { this.i += 2; continue; }
      if (c === q) { this.i++; return; }
      this.i++;
    }
    throw new ShellSyntaxError('unterminated quote', this.i);
  }
  readBacktick() {
    this.i++; // `
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === '\\') {
        const n = this.src[this.i + 1];
        if (n === '`' || n === '\\' || n === '$') { out += n; this.i += 2; continue; }
        out += c; this.i++; continue;
      }
      if (c === '`') { this.i++; return out; }
      out += c; this.i++;
    }
    throw new ShellSyntaxError('unterminated backquote', this.i);
  }
  readDoubleQuoted() {
    const parts = [];
    let lit = '';
    const flush = () => { if (lit) { parts.push({ t: 'lit', v: lit, q: true }); lit = ''; } };
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === '"') { this.i++; flush(); break; }
      if (c === '\\') {
        const n = this.src[this.i + 1];
        if (n === '$' || n === '`' || n === '"' || n === '\\') { lit += n; this.i += 2; continue; }
        if (n === '\n') { this.i += 2; continue; }
        lit += '\\'; this.i++; continue;
      }
      if (c === '$') { flush(); parts.push(this.readDollar(true)); continue; }
      if (c === '`') { flush(); parts.push({ t: 'cmdsub', src: this.readBacktick(), q: true }); continue; }
      lit += c; this.i++;
    }
    flush();
    return parts;
  }
  readWord() {
    const start = this.i;
    const parts = [];
    let lit = '';
    let anyQuote = false;
    const flush = (q = false) => {
      if (lit) { parts.push({ t: 'lit', v: lit, q }); lit = ''; }
    };
    while (this.i < this.src.length) {
      const c = this.src[this.i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') break;
      if ('<>&|;()'.includes(c)) break;
      if (c === '\\') {
        const n = this.src[this.i + 1];
        if (n === '\n') { this.i += 2; continue; }
        if (n === undefined) { lit += '\\'; this.i++; continue; }
        flush();
        parts.push({ t: 'lit', v: n, q: true });
        anyQuote = true;
        this.i += 2;
        continue;
      }
      if (c === "'") {
        flush(); anyQuote = true; this.i++;
        let s = '';
        while (!this.eof() && this.peek() !== "'") { s += this.peek(); this.i++; }
        if (this.peek() === "'") this.i++;
        parts.push({ t: 'lit', v: s, q: true });
        continue;
      }
      if (c === '"') {
        flush(); anyQuote = true; this.i++;
        parts.push({ t: 'compound', parts: this.readDoubleQuoted(), q: true });
        continue;
      }
      if (c === '$') { flush(); parts.push(this.readDollar(false)); continue; }
      if (c === '`') { flush(); parts.push({ t: 'cmdsub', src: this.readBacktick(), q: false }); continue; }
      if (c === '#' && this.i === start) break;
      lit += c; this.i++;
    }
    flush();
    const raw = this.src.slice(start, this.i);
    return { parts, raw, quoted: anyQuote };
  }
}

function ansiEscapeLength(s) {
  const map = { n: 1, t: 1, r: 1, a: 1, b: 1, f: 1, v: 1, e: 1, E: 1, '\\': 1, "'": 1, '"': 1, '?': 1, 0: 1, x: 3, u: 5, U: 9 };
  const c = s[1];
  if (c === 'x') return 4;
  if (c === 'u') return 6;
  if (c === 'U') return 10;
  if (c === undefined) return 1;
  return 2;
}
export function decodeAnsiEscape(s) {
  const c = s[1];
  const map = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', e: '\x1b', E: '\x1b', '\\': '\\', "'": "'", '"': '"', '?': '?', 0: '\0' };
  if (c === 'x') return String.fromCharCode(parseInt(s.slice(2, 4), 16) || 0);
  if (c === 'u') return String.fromCharCode(parseInt(s.slice(2, 6), 16) || 0);
  if (c === 'U') return String.fromCodePoint(parseInt(s.slice(2, 10), 16) || 0);
  if (c === 'c') return String.fromCharCode((s.charCodeAt(2) || 64) & 31);
  if (s.length <= 2) return '\\';
  return map[c] ?? c;
}

function stripQuotes(raw) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c === "'" || c === '"') {
      quoted = true;
      const q = c;
      i++;
      while (i < raw.length && raw[i] !== q) {
        if (q === '"' && raw[i] === '\\' && i + 1 < raw.length) { out += raw[i + 1]; i += 2; continue; }
        out += raw[i]; i++;
      }
      continue;
    }
    if (c === '\\' && i + 1 < raw.length) { out += raw[i + 1]; quoted = true; i++; continue; }
    out += c;
  }
  return { text: out, quoted };
}

export function tokenize(src) {
  const sc = new Scanner(src);
  const tokens = [];
  let pending = [];
  let expectDelim = null;
  const consumeHeredocs = () => {
    while (pending.length) {
      const { token, delimiter, stripTabs, quoted } = pending.shift();
      let content = '';
      let found = false;
      while (sc.i <= src.length) {
        let end = src.indexOf('\n', sc.i);
        if (end < 0) end = src.length;
        let line = src.slice(sc.i, end);
        sc.i = end + 1;
        const test = stripTabs ? line.replace(/^\t+/, '') : line;
        if (test === delimiter) { found = true; break; }
        if (stripTabs) line = line.replace(/^\t+/, '');
        content += line + '\n';
        if (end >= src.length) break;
      }
      token.heredoc = { content, expand: !quoted, delimiter, found };
    }
  };
  while (!sc.eof()) {
    const c = sc.peek();
    if (c === ' ' || c === '\t' || c === '\r') { sc.i++; continue; }
    if (c === '\\' && sc.peek(1) === '\n') { sc.i += 2; continue; }
    if (c === '\n') {
      tokens.push({ type: 'NEWLINE' });
      sc.i++;
      consumeHeredocs();
      continue;
    }
    if (c === '#') { while (!sc.eof() && sc.peek() !== '\n') sc.i++; continue; }
    const op = sc.matchOp();
    if (op) {
      const token = { type: 'OP', op };
      tokens.push(token);
      sc.i += op.length;
      if (op === '<<' || op === '<<-') expectDelim = { token, stripTabs: op === '<<-' };
      continue;
    }
    const word = sc.readWord();
    if (!word.raw.length) { sc.i++; continue; }
    const token = { type: 'WORD', word, raw: word.raw };
    tokens.push(token);
    if (expectDelim) {
      const { text, quoted } = stripQuotes(word.raw);
      pending.push({ token: expectDelim.token, delimiter: text, stripTabs: expectDelim.stripTabs, quoted: quoted || word.quoted });
      expectDelim = null;
    }
  }
  tokens.push({ type: 'EOF' });
  return tokens;
}

function splitAssignment(word) {
  if (!word || !word.parts.length) return null;
  const first = word.parts[0];
  if (first.t !== 'lit' || first.q) return null;
  const eq = first.v.indexOf('=');
  if (eq < 0) return null;
  let name = first.v.slice(0, eq);
  let append = false;
  if (name.endsWith('+')) { append = true; name = name.slice(0, -1); }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  const rest = first.v.slice(eq + 1);
  const valueParts = [];
  if (rest) valueParts.push({ t: 'lit', v: rest, q: false });
  for (let i = 1; i < word.parts.length; i++) valueParts.push(word.parts[i]);
  return { name, append, value: { parts: valueParts, raw: word.raw.slice(eq + 1), quoted: word.quoted } };
}

export class Parser {
  constructor(tokens, src = '') {
    this.tokens = tokens;
    this.src = src;
    this.i = 0;
  }
  peek(n = 0) { return this.tokens[this.i + n] || this.tokens[this.tokens.length - 1]; }
  next() { return this.tokens[this.i++]; }
  eof() { return this.peek().type === 'EOF'; }
  isOp(op) { const t = this.peek(); return t.type === 'OP' && t.op === op; }
  isWord(w) { const t = this.peek(); return t.type === 'WORD' && t.raw === w; }
  isNewline() { return this.peek().type === 'NEWLINE'; }
  skipNewlines() { while (this.isNewline()) this.next(); }
  skipSeparators() {
    for (;;) {
      if (this.isNewline() || this.isOp(';')) { this.next(); continue; }
      break;
    }
  }
  expectWord(w) {
    if (!this.isWord(w)) throw new ShellSyntaxError(`expected '${w}', got '${this.peek().raw ?? this.peek().op ?? this.peek().type}'`);
    return this.next();
  }
  expectOp(op) {
    if (!this.isOp(op)) throw new ShellSyntaxError(`expected '${op}'`);
    return this.next();
  }

  parseProgram() {
    const list = this.parseList(new Set(), new Set());
    if (!this.eof()) throw new ShellSyntaxError(`unexpected token '${this.peek().raw ?? this.peek().op}'`);
    return list;
  }

  atStop(stopWords, stopOps) {
    const t = this.peek();
    if (t.type === 'WORD' && stopWords.has(t.raw)) return true;
    if (t.type === 'OP' && stopOps.has(t.op)) return true;
    if (t.type === 'EOF') return true;
    return false;
  }

  parseList(stopWords = new Set(), stopOps = new Set()) {
    const items = [];
    for (;;) {
      this.skipNewlines();
      if (this.isOp(';')) { this.next(); continue; }
      if (this.eof() || this.atStop(stopWords, stopOps)) break;
      const node = this.parseAndOr();
      let async = false;
      if (this.isOp('&')) { async = true; this.next(); }
      else if (this.isOp(';')) this.next();
      else if (this.isNewline()) this.skipNewlines();
      else if (!this.eof() && !this.atStop(stopWords, stopOps)) {
        const t = this.peek();
        throw new ShellSyntaxError(`unexpected token '${t.raw ?? t.op}'`);
      }
      items.push({ async, node });
    }
    return { type: 'list', items };
  }

  parseAndOr() {
    const first = this.parsePipeline();
    const rest = [];
    while (this.isOp('&&') || this.isOp('||')) {
      const op = this.next().op;
      this.skipNewlines();
      rest.push({ op, node: this.parsePipeline() });
    }
    return { type: 'andor', first, rest };
  }

  parsePipeline() {
    let negate = false;
    if (this.isWord('!')) { negate = true; this.next(); }
    const cmds = [this.parseCommand()];
    while (this.isOp('|') || this.isOp('|&')) {
      this.next();
      this.skipNewlines();
      cmds.push(this.parseCommand());
    }
    return { type: 'pipeline', negate, cmds };
  }

  parseRedirs() {
    const redirs = [];
    for (;;) {
      let t = this.peek();
      let fd = null;
      if (t.type === 'WORD' && /^\d+$/.test(t.raw)) {
        const nt = this.peek(1);
        if (nt.type === 'OP' && REDIR_OPS.has(nt.op)) { fd = Number(t.raw); this.next(); t = this.peek(); }
      }
      if (t.type !== 'OP' || !REDIR_OPS.has(t.op)) break;
      const opToken = this.next();
      const target = this.peek();
      if (target.type !== 'WORD') throw new ShellSyntaxError(`redirection ${opToken.op} requires a target`);
      this.next();
      const op = opToken.op;
      if (op === '<<' || op === '<<-') {
        redirs.push({ type: 'heredoc', fd: fd ?? 0, body: opToken.heredoc?.content ?? '', expand: opToken.heredoc?.expand ?? true });
        continue;
      }
      if (op === '<<<') { redirs.push({ type: 'herestring', fd: fd ?? 0, word: target.word }); continue; }
      if (op === '>&' || op === '<&') {
        redirs.push({ type: 'dup', fd: fd ?? (op === '>&' ? 1 : 0), target: target.raw, dir: op === '>&' ? 'out' : 'in' });
        continue;
      }
      if (op === '&>' || op === '&>>') {
        redirs.push({ type: 'file', fd: 1, path: target.word, flags: op === '&>>' ? 'append' : 'trunc', both: true });
        continue;
      }
      if (op === '<' || op === '<>') {
        redirs.push({ type: 'file', fd: fd ?? 0, path: target.word, flags: op === '<' ? 'read' : 'rdwr' });
        continue;
      }
      redirs.push({ type: 'file', fd: fd ?? 1, path: target.word, flags: op === '>>' ? 'append' : 'trunc' });
    }
    return redirs;
  }

  parseCommand() {
    const t = this.peek();
    if (t.type === 'WORD') {
      switch (t.raw) {
        case 'if': return this.parseIf();
        case 'for': return this.parseFor();
        case 'while':
        case 'until': return this.parseWhile(t.raw === 'until');
        case 'case': return this.parseCase();
        case '{': {
          this.next();
          const body = this.parseList(new Set(['}']), new Set());
          this.expectWord('}');
          const node = { type: 'group', body, subshell: false, redirs: [] };
          node.redirs = this.parseRedirs();
          return node;
        }
        case 'function': {
          this.next();
          const nameTok = this.peek();
          if (nameTok.type !== 'WORD') throw new ShellSyntaxError('function name expected');
          this.next();
          if (this.isOp('(')) { this.next(); this.expectOp(')'); }
          this.skipNewlines();
          const body = this.parseCommand();
          return { type: 'funcdef', name: nameTok.raw, body, redirs: [] };
        }
        case 'select': throw new ShellSyntaxError('select is not supported');
        case 'time': {
          this.next();
          const cmd = this.parsePipeline();
          return { type: 'time', cmd, redirs: [] };
        }
        default: break;
      }
      // name() { ...; }
      if (this.peek(1).type === 'OP' && this.peek(1).op === '(' && this.peek(2).type === 'OP' && this.peek(2).op === ')') {
        const name = this.next().raw;
        this.next(); this.next();
        this.skipNewlines();
        const body = this.parseCommand();
        return { type: 'funcdef', name, body, redirs: [] };
      }
    }
    if (this.isOp('(')) {
      this.next();
      const body = this.parseList(new Set(), new Set([')']));
      this.expectOp(')');
      const node = { type: 'group', body, subshell: true, redirs: [] };
      node.redirs = this.parseRedirs();
      return node;
    }
    return this.parseSimple();
  }

  parseSimple() {
    const words = [];
    const assigns = [];
    const redirs = [];
    for (;;) {
      const t = this.peek();
      if (t.type === 'WORD') {
        const nt = this.peek(1);
        if (/^\d+$/.test(t.raw) && nt.type === 'OP' && REDIR_OPS.has(nt.op)) {
          redirs.push(...this.parseRedirs());
          continue;
        }
        if (!words.length) {
          const a = splitAssignment(t.word);
          if (a) { assigns.push(a); this.next(); continue; }
        }
        words.push(t.word);
        this.next();
        continue;
      }
      if (t.type === 'OP' && REDIR_OPS.has(t.op)) {
        redirs.push(...this.parseRedirs());
        continue;
      }
      break;
    }
    if (!words.length && !assigns.length && !redirs.length) {
      throw new ShellSyntaxError(`unexpected token '${this.peek().raw ?? this.peek().op ?? this.peek().type}'`);
    }
    return { type: 'simple', words, assigns, redirs };
  }

  parseIf() {
    this.expectWord('if');
    const clauses = [];
    let cond = this.parseList(new Set(['then']), new Set());
    this.expectWord('then');
    let body = this.parseList(new Set(['elif', 'else', 'fi']), new Set());
    clauses.push({ cond, body });
    let elseBody = null;
    while (this.isWord('elif')) {
      this.next();
      cond = this.parseList(new Set(['then']), new Set());
      this.expectWord('then');
      body = this.parseList(new Set(['elif', 'else', 'fi']), new Set());
      clauses.push({ cond, body });
    }
    if (this.isWord('else')) {
      this.next();
      elseBody = this.parseList(new Set(['fi']), new Set());
    }
    this.expectWord('fi');
    const node = { type: 'if', clauses, elseBody, redirs: [] };
    node.redirs = this.parseRedirs();
    return node;
  }

  parseFor() {
    this.expectWord('for');
    if (this.isOp('(')) throw new ShellSyntaxError('C-style for loops are not supported');
    const nameTok = this.peek();
    if (nameTok.type !== 'WORD') throw new ShellSyntaxError('for: variable name expected');
    this.next();
    let words = null;
    this.skipNewlines();
    if (this.isWord('in')) {
      this.next();
      words = [];
      while (this.peek().type === 'WORD') words.push(this.next().word);
    }
    this.skipSeparators();
    this.skipNewlines();
    this.expectWord('do');
    const body = this.parseList(new Set(['done']), new Set());
    this.expectWord('done');
    const node = { type: 'for', name: nameTok.raw, words, body, redirs: [] };
    node.redirs = this.parseRedirs();
    return node;
  }

  parseWhile(until) {
    this.next();
    const cond = this.parseList(new Set(['do']), new Set());
    this.expectWord('do');
    const body = this.parseList(new Set(['done']), new Set());
    this.expectWord('done');
    const node = { type: 'while', until, cond, body, redirs: [] };
    node.redirs = this.parseRedirs();
    return node;
  }

  parseCase() {
    this.expectWord('case');
    const w = this.peek();
    if (w.type !== 'WORD') throw new ShellSyntaxError('case: word expected');
    this.next();
    this.skipNewlines();
    this.expectWord('in');
    this.skipNewlines();
    const cases = [];
    while (!this.isWord('esac')) {
      this.skipNewlines();
      if (this.isOp(';')) { this.next(); continue; }
      if (this.isOp('(')) this.next();
      const patterns = [];
      while (this.peek().type === 'WORD') {
        patterns.push(this.next().word);
        if (this.isOp('|')) this.next(); else break;
      }
      this.expectOp(')');
      const body = this.parseList(new Set(['esac']), new Set([';;', ';&', ';;&']));
      let term = ';;';
      if (this.peek().type === 'OP' && [';;', ';&', ';;&'].includes(this.peek().op)) term = this.next().op;
      cases.push({ patterns, body, terminator: term });
    }
    this.expectWord('esac');
    const node = { type: 'case', word: w.word, cases, redirs: [] };
    node.redirs = this.parseRedirs();
    return node;
  }
}

export function parse(src) {
  return new Parser(tokenize(src), src).parseProgram();
}

export function parseWordOnly(str) {
  const sc = new Scanner(str);
  while (!sc.eof() && /\s/.test(sc.peek())) sc.i++;
  if (sc.eof()) return { parts: [], raw: '', quoted: false };
  const w = sc.readWord();
  return w;
}

/** Parse text as the body of a double-quoted string (used for heredocs). */
export function parseQuotedBody(str) {
  const sc = new Scanner(str);
  return sc.readDoubleQuoted();
}
