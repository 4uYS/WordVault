/* Unix text-processing commands: grep, sed, awk, sort, diff, find and friends. */

import {
  parseOpts, resolvePath, statOf, tryStat, readTextFile, errnoText, splitOutput, escapeRegExp,
} from './util.js';

const ctxPath = (c, p) => resolvePath(c, p);
const cred = (c) => c.cred();
const joinPath = (a, b) => (a === '/' ? '/' + b : a.replace(/\/+$/, '') + '/' + b);
const dirName = (p) => { const s = p.replace(/\/+$/, ''); const i = s.lastIndexOf('/'); return i <= 0 ? '/' : s.slice(0, i); };
const baseName = (p) => { const s = p.replace(/\/+$/, ''); return s === '' ? '/' : s.slice(s.lastIndexOf('/') + 1); };
const toNum = (v) => { if (typeof v === 'number') return v; const n = Number(String(v).trim()); return Number.isNaN(n) ? 0 : n; };
const isNumericStr = (s) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(s);

function reg(ctx, name, summary, run) { ctx.kernel.registerCommand(name, { summary, run }); }
function reportErr(c, msg, code = 1) { c.err(msg + '\n'); return code; }

function readInputFile(c, name) {
  if (name === '-') return null;
  try { return readTextFile(c, name); }
  catch (e) { const err = Object.assign(new Error(errnoText(e)), { code: e.code }); throw err; }
}

async function readTextOperand(c, name) {
  if (name === '-' || name == null) return c.readText();
  return readInputFile(c, name);
}

/** Read all listed files (or stdin) into [{name,text}]; errors collected. */
async function readAllFiles(c, files, { keepGoing = true } = {}) {
  if (!files.length) return [{ name: '(standard input)', stdin: true, text: await c.readText() }];
  const out = [];
  for (const f of files) {
    if (f === '-') { out.push({ name: '(standard input)', stdin: true, text: await c.readText() }); continue; }
    try { out.push({ name: f, text: readTextFile(c, f) }); }
    catch (e) {
      c.err(`${c.name}: ${f}: ${errnoText(e)}\n`);
      if (!keepGoing) break;
    }
  }
  return out;
}

function textBytes(s) { return new TextEncoder().encode(s); }
function bytesText(b) { return new TextDecoder().decode(b); }
function concatBytes(list) {
  let n = 0; for (const b of list) n += b.length;
  const out = new Uint8Array(n); let off = 0;
  for (const b of list) { out.set(b, off); off += b.length; }
  return out;
}
function writeOut(c, s) { c.out(s); }
function joinLines(lines, trailing = true) {
  if (!lines.length) return '';
  return lines.join('\n') + (trailing ? '\n' : '');
}
function quoteShell(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function splitWords(text) {
  const words = [];
  let cur = '', quote = null, started = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) { quote = null; started = true; continue; }
      if (ch === '\\' && quote === '"' && i + 1 < text.length) { cur += text[++i]; started = true; continue; }
      cur += ch; started = true; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; started = true; continue; }
    if (ch === '\\' && i + 1 < text.length) { cur += text[++i]; started = true; continue; }
    if (/\s/.test(ch)) { if (started) { words.push(cur); cur = ''; started = false; } continue; }
    cur += ch; started = true;
  }
  if (started) words.push(cur);
  return words;
}

const POSIX_CLASSES = {
  alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', space: '\\s', blank: ' \\t',
  upper: 'A-Z', lower: 'a-z', punct: '!-/:-@\\[-`{-~', print: ' -~', graph: '!-~',
  cntrl: '\\x00-\\x1f\\x7f', xdigit: '0-9A-Fa-f', word: 'A-Za-z0-9_',
};

function translatePosixClasses(re) {
  return re.replace(/\[:(\w+):\]/g, (m, name) => POSIX_CLASSES[name] ?? m);
}

/** Convert a POSIX basic regular expression (BRE) into a JavaScript regex source. */
function breToJs(re) {
  let out = '';
  for (let i = 0; i < re.length; i++) {
    const ch = re[i];
    if (ch === '\\') {
      const n = re[i + 1];
      if (n === undefined) { out += '\\\\'; continue; }
      if ('(){}?+|'.includes(n)) { out += n; i++; continue; }
      if (n === '<' || n === '>') { out += '\\b'; i++; continue; }
      out += '\\' + n; i++; continue;
    }
    if ('(){}?+|'.includes(ch)) { out += '\\' + ch; continue; }
    out += ch;
  }
  return translatePosixClasses(out);
}

function ereToJs(re) {
  let out = '';
  for (let i = 0; i < re.length; i++) {
    const ch = re[i];
    if (ch === '\\') {
      const n = re[i + 1];
      if (n === '<' || n === '>') { out += '\\b'; i++; continue; }
      out += ch + (n ?? '');
      if (n !== undefined) i++;
      continue;
    }
    out += ch;
  }
  return translatePosixClasses(out);
}

function makeRegex(source, { extended = false, basic = false, icase = false, multi = false } = {}) {
  let src = source;
  src = basic ? breToJs(src) : extended ? ereToJs(src) : ereToJs(src);
  const flags = (icase ? 'i' : '') + (multi ? 'm' : '');
  try { return new RegExp(src, flags); }
  catch { return new RegExp(escapeRegExp(source), flags); }
}

function globToRegExp(glob, { pathMode = false } = {}) {
  let out = '^';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') { out += pathMode ? '.*' : '[^/]*'; continue; }
    if (ch === '?') { out += pathMode ? '.' : '[^/]'; continue; }
    if (ch === '[') {
      let j = i + 1, neg = false;
      if (glob[j] === '!' || glob[j] === '^') { neg = true; j++; }
      let body = '', closed = false;
      let first = true;
      for (; j < glob.length; j++) {
        const cj = glob[j];
        if (cj === ']' && !first) { closed = true; break; }
        first = false;
        if (cj === '\\' && j + 1 < glob.length) { body += '\\' + glob[++j]; continue; }
        if (cj === '[') { const m = glob.slice(j).match(/^\[:(\w+):\]/); if (m && POSIX_CLASSES[m[1]]) { body += POSIX_CLASSES[m[1]]; j += m[0].length - 1; continue; } }
        body += cj;
      }
      if (closed) { out += '[' + (neg ? '^' : '') + body + ']'; i = j; continue; }
      out += '\\['; continue;
    }
    if (ch === '\\' && i + 1 < glob.length) { out += escapeRegExp(glob[++i]); continue; }
    out += escapeRegExp(ch);
  }
  return new RegExp(out + '$');
}

/* ============================== grep ============================== */

function parseGrepArgs(args) {
  const o = {
    i: false, v: false, n: false, c: false, l: false, L: false, o: false, q: false,
    E: false, F: false, w: false, x: false, r: false, R: false, h: false, H: false,
    s: false, patterns: [], files: [], after: 0, before: 0, color: 'never', withFilename: false,
  };
  let endOpts = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (endOpts || a === '-' || !a.startsWith('-')) { o.files.push(a); continue; }
    if (a === '--') { endOpts = true; continue; }
    if (a.startsWith('--')) {
      let name = a.slice(2), val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (name === 'color' || name === 'colour') { o.color = val || 'auto'; continue; }
      if (name === 'include' || name === 'exclude' || name === 'exclude-dir') continue;
      if (name === 'after-context') { o.after = Number(val ?? args[++i]) || 0; continue; }
      if (name === 'before-context') { o.before = Number(val ?? args[++i]) || 0; continue; }
      const longs = {
        ignoreCase: 'i', invertMatch: 'v', lineNumber: 'n', count: 'c', filesWithMatches: 'l',
        filesWithoutMatch: 'L', onlyMatching: 'o', quiet: 'q', silent: 'q', extendedRegexp: 'E',
        fixedStrings: 'F', wordRegexp: 'w', lineRegexp: 'x', recursive: 'r', dereferenceRecursive: 'R',
        noFilename: 'h', withFilename: 'H', noMessages: 's',
      };
      if (longs[name]) { o[longs[name]] = true; continue; }
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      if (ch === 'e') { o.patterns.push(a.slice(k + 1) || args[++i] || ''); k = a.length; continue; }
      if (ch === 'f') { o.patternFiles = o.patternFiles || []; o.patternFiles.push(a.slice(k + 1) || args[++i]); k = a.length; continue; }
      if (ch === 'A' || ch === 'B' || ch === 'C') {
        const v = a.slice(k + 1) || args[++i];
        const n = Number(v) || 0;
        if (ch === 'A') o.after = n; else if (ch === 'B') o.before = n; else { o.after = n; o.before = n; }
        k = a.length; continue;
      }
      if (ch === 'm') { const v = a.slice(k + 1) || args[++i]; o.maxCount = Number(v) || 0; k = a.length; continue; }
      if ('ivnclLoqEFwrxhHsf'.includes(ch)) { o[ch] = true; continue; }
    }
  }
  return o;
}

function grepPrepare(c, o) {
  const patterns = o.patterns.slice();
  if (o.patternFiles) {
    for (const f of o.patternFiles) {
      try {
        const st = splitOutput(readTextFile(c, f));
        patterns.push(...st.lines);
      } catch (e) { c.err(`grep: ${f}: ${errnoText(e)}\n`); }
    }
  }
  if (!patterns.length) {
    if (!o.files.length) return null;
    patterns.push(o.files.shift());
  }
  const converted = patterns.map((p) => {
    if (o.F) return escapeRegExp(p);
    return o.E ? ereToJs(p) : breToJs(p);
  });
  let source = converted.length === 1 ? converted[0] : converted.map((p) => `(?:${p})`).join('|');
  if (o.w) source = `(?<![A-Za-z0-9_])(?:${source})(?![A-Za-z0-9_])`;
  if (o.x) source = `^(?:${source})$`;
  try { return new RegExp(source, o.i ? 'i' : ''); }
  catch { return new RegExp(escapeRegExp(patterns.join('|')), o.i ? 'i' : ''); }
}

function grepFile(c, re, name, text, o, showName, counts) {
  const { lines } = splitOutput(text);
  const matches = [];
  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];
    let ok = re.test(line);
    if (o.v) ok = !ok;
    if (ok) matches.push(idx);
  }
  const count = matches.length;
  counts.total += count;
  if (o.q) { if (count) counts.found = true; return; }
  if (o.l) { if (count) writeOut(c, name + '\n'); return; }
  if (o.L) { if (!count) writeOut(c, name + '\n'); return; }
  if (o.c) {
    writeOut(c, (showName ? name + ':' : '') + count + '\n');
    return;
  }
  if (!count) return;
  if (o.o) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const idx of matches) {
      if (o.v) continue;
      let m; g.lastIndex = 0;
      const hay = lines[idx];
      while ((m = g.exec(hay)) !== null) {
        if (m[0] === '') { g.lastIndex++; continue; }
        writeOut(c, (showName ? name + ':' : '') + (o.n ? (idx + 1) + ':' : '') + m[0] + '\n');
        if (o.maxCount && --o.maxCount <= 0) break;
      }
    }
    return;
  }
  const printed = new Set();
  const limit = o.maxCount || Infinity;
  let emitted = 0;
  for (let mi = 0; mi < matches.length && emitted < limit; mi++) {
    const idx = matches[mi];
    const start = Math.max(0, idx - o.before);
    const end = Math.min(lines.length - 1, idx + o.after);
    if (printed.size && start > Math.max(...printed) + 1) writeOut(c, '--\n');
    for (let j = start; j <= end; j++) {
      if (printed.has(j)) continue;
      printed.add(j);
      const isMatch = matches.includes(j);
      const sep = o.n ? (isMatch ? ':' : '-') : (isMatch ? ':' : '-');
      const prefix = (showName ? name + sep : '') + (o.n ? (j + 1) + sep : '');
      writeOut(c, prefix + lines[j] + '\n');
    }
    emitted++;
  }
}

function resolveGrepOperands(c, o, base) {
  const out = [];
  const walk = (p, shown) => {
    let st;
    try { st = statOf(c, p, { follow: true }); }
    catch (e) { if (!o.s) c.err(`grep: ${shown}: ${errnoText(e)}\n`); o.error = true; return; }
    if (st.isDirectory()) {
      if (!(o.r || o.R)) { if (!o.s) c.err(`grep: ${shown}: Is a directory\n`); o.error = true; return; }
      let entries;
      try { entries = [...c.vfs.readdirNodes(ctxPath(c, p), cred(c))]; }
      catch (e) { if (!o.s) c.err(`grep: ${shown}: ${errnoText(e)}\n`); o.error = true; return; }
      for (const [nm] of entries) {
        if (nm === '.' || nm === '..') continue;
        const child = joinPath(p, nm);
        if (o.r && !o.R && !o.follow) { /* -r does not follow symlinks */ }
        walk(child, joinPath(shown, nm));
      }
    } else out.push({ name: shown, path: p });
  };
  for (const f of base) walk(ctxPath(c, f), f);
  return out;
}

async function grepRun(c, argv) {
  const o = parseGrepArgs(argv);
  if (c.name === 'egrep') o.E = true;
  if (c.name === 'fgrep') o.F = true;
  if (!o.R) o.R = false;
  if (o.R) o.r = true;
  const re = grepPrepare(c, o);
  if (!re) { c.err(`${c.name}: no pattern given\n`); return 2; }
  const operands = o.files;
  const counts = { total: 0, found: false };
  let hadError = false;
  if (!operands.length || operands.every((f) => f === '-')) {
    const text = await c.readText();
    grepFile(c, re, '(standard input)', text, o, false, counts);
    if (o.error) hadError = true;
    return o.q && counts.found ? 0 : counts.total ? 0 : (hadError ? 2 : 1);
  }
  const list = resolveGrepOperands(c, o, operands);
  if (o.error) hadError = true;
  const showName = o.H || (list.length > 1 && !o.h);
  for (const item of list) {
    let text;
    try { text = readTextFile(c, item.path); }
    catch (e) { if (!o.s) c.err(`${c.name}: ${item.name}: ${errnoText(e)}\n`); hadError = true; continue; }
    grepFile(c, re, item.name, text, o, showName, counts);
  }
  if (o.q) return counts.found ? 0 : 1;
  if (counts.total) return 0;
  return hadError ? 2 : 1;
}

/* ============================== sed ============================== */

class SedNext extends Error {}
class SedRestart extends Error {}
class SedQuit extends Error { constructor(code) { super('quit'); this.code = code; } }
class SedJump extends Error { constructor(label) { super('jump'); this.label = label; } }

function parseSedAddress(sc) {
  const ch = sc.peek();
  if (ch === '$') { sc.i++; return { type: 'last' }; }
  if (/\d/.test(ch)) {
    let num = sc.readWhile(/\d/);
    if (sc.peek() === '~') { sc.i++; const step = Number(sc.readWhile(/\d/) || '0'); return { type: 'step', first: Number(num), step }; }
    return { type: 'line', line: Number(num) };
  }
  if (ch === '/' || ch === '\\') {
    let delim = '/';
    if (ch === '\\') { sc.i++; delim = sc.next(); } else sc.i++;
    let re = '';
    for (;;) {
      const cch = sc.next();
      if (cch === null) break;
      if (cch === '\\') { const n = sc.next(); if (n === delim) re += delim; else re += '\\' + (n ?? ''); continue; }
      if (cch === delim) {
        let flags = '';
        while (sc.peek() !== null && /[IMim]/.test(sc.peek())) flags += sc.next();
        return { type: 'regex', source: re, flags };
      }
      re += cch;
    }
    return { type: 'regex', source: re, flags: '' };
  }
  return null;
}

class SedScanner {
  constructor(text) { this.text = text; this.i = 0; }
  peek() { return this.i < this.text.length ? this.text[this.i] : null; }
  next() { return this.i < this.text.length ? this.text[this.i++] : null; }
  readWhile(re) { const s = this.i; while (this.i < this.text.length && re.test(this.text[this.i])) this.i++; return this.text.slice(s, this.i); }
  skipSpace() { while (this.i < this.text.length && /[ \t\r]/.test(this.text[this.i])) this.i++; }
  skipSeparators() {
    for (;;) {
      this.skipSpace();
      const ch = this.peek();
      if (ch === ';' || ch === '\n') { this.i++; continue; }
      if (ch === '#') { while (this.i < this.text.length && this.text[this.i] !== '\n') this.i++; continue; }
      break;
    }
  }
  readDelimited(delim) {
    let out = '';
    for (;;) {
      const ch = this.next();
      if (ch === null) break;
      if (ch === '\\') { const n = this.next(); if (n === delim) out += delim; else out += '\\' + (n ?? ''); continue; }
      if (ch === delim) break;
      out += ch;
    }
    return out;
  }
  readToEol() {
    let out = '';
    for (;;) {
      if (this.i >= this.text.length) break;
      const ch = this.text[this.i];
      if (ch === '\n') { this.i++; break; }
      if (ch === '\\' && this.text[this.i + 1] === '\n') { this.i += 2; out += '\n'; continue; }
      out += ch; this.i++;
    }
    return out;
  }
}

function parseSedScript(text, extended, labels) {
  const sc = new SedScanner(text);
  const parseList = (inBlock) => {
    const list = [];
    for (;;) {
      sc.skipSeparators();
      if (sc.peek() === null) { if (inBlock) throw new Error(`unmatched '{'`); return list; }
      if (sc.peek() === '}') {
        if (!inBlock) throw new Error(`unexpected '}'`);
        sc.i++;
        return list;
      }
      sc.skipSpace();
      if (sc.peek() === '}') { if (!inBlock) throw new Error(`unexpected '}'`); sc.i++; return list; }
      let addr1 = parseSedAddress(sc);
      let addr2 = null;
      sc.skipSpace();
      if (sc.peek() === ',') {
        sc.i++; sc.skipSpace();
        const save = sc.i;
        if (sc.peek() === '+' || sc.peek() === '~') {
          const t = sc.next(); const n = Number(sc.readWhile(/\d/) || '0');
          addr2 = { type: t === '+' ? 'plus' : 'mod', n };
        } else addr2 = parseSedAddress(sc);
        if (!addr2) { sc.i = save; }
      }
      sc.skipSpace();
      let negate = false;
      if (sc.peek() === '!') { negate = true; sc.i++; sc.skipSpace(); }
      const ch = sc.peek();
      if (ch === null) break;
      if (ch === '{') {
        sc.i++;
        const body = parseList(true);
        list.push({ type: 'group', addr1, addr2, negate, body });
        continue;
      }
      sc.i++;
      const node = { type: 'cmd', cmd: ch, addr1, addr2, negate };
      const rest = () => { sc.skipSpace(); return sc.readToEol(); };
      switch (ch) {
        case 's': case 'y': {
          const delim = sc.next();
          if (delim === null) throw new Error('missing delimiter');
          const pat = sc.readDelimited(delim);
          const rep = sc.readDelimited(delim);
          node.pattern = pat; node.replacement = rep; node.delim = delim;
          if (ch === 's') {
            const flags = sc.readWhile(/[0-9a-zA-Z]/);
            node.flags = flags;
            sc.skipSpace();
            if (sc.peek() === 'w') { sc.i++; node.wfile = sc.readToEol().trim(); }
          }
          break;
        }
        case 'a': case 'i': case 'c': {
          sc.skipSpace();
          if (sc.peek() === '\\') { sc.i++; node.text = sc.readToEol(); }
          else node.text = sc.readToEol();
          break;
        }
        case 'r': case 'R': case 'w': case 'W': node.file = rest().trim(); break;
        case 'b': case 't': case 'T': {
          sc.skipSpace();
          node.label = sc.readWhile(/[A-Za-z0-9_]/);
          if (node.label) labels.set(node.label, true);
          break;
        }
        case 'q': case 'Q': { sc.skipSpace(); const n = sc.readWhile(/\d/); if (n) node.code = Number(n); break; }
        case ':': {
          sc.skipSpace();
          node.label = sc.readWhile(/[A-Za-z0-9_]/);
          labels.set(node.label, true);
          break;
        }
        case 'n': case 'N': case 'd': case 'D': case 'p': case 'P': case 'h': case 'H':
        case 'g': case 'G': case 'x': case 'z': case '=': case 'l':
          break;
        default:
          break;
      }
      list.push(node);
    }
  };
  return parseList(false);
}

function sedExpandRepl(repl, m) {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i];
    if (ch === '&') { out += m[0]; continue; }
    if (ch === '\\') {
      const n = repl[i + 1];
      if (n === undefined) { out += '\\'; continue; }
      if (/\d/.test(n)) { out += m[Number(n)] ?? ''; i++; continue; }
      if (n === 'n') { out += '\n'; i++; continue; }
      if (n === 't') { out += '\t'; i++; continue; }
      if (n === '&' || n === '\\') { out += n; i++; continue; }
      out += n; i++; continue;
    }
    out += ch;
  }
  return out;
}

function sedSubstitute(pat, repl, flags, str, extended) {
  let icase = false, global = false, nth = 0, print = false;
  for (const f of flags) {
    if (f === 'g') global = true;
    else if (f === 'i' || f === 'I') icase = true;
    else if (f === 'p') print = true;
    else if (/\d/.test(f)) nth = nth * 10 + Number(f);
  }
  let re = makeRegex(pat, { extended, basic: !extended, icase });
  re = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let out = '', last = 0, count = 0, replaced = 0;
  let m;
  for (;;) {
    m = re.exec(str);
    if (!m) break;
    count++;
    const wanted = nth ? (global ? count >= nth : count === nth) : (global || count === 1);
    if (wanted) {
      out += str.slice(last, m.index) + sedExpandRepl(repl, m);
      last = m.index + m[0].length;
      replaced++;
      if (!global && !nth) { if (m[0] === '') re.lastIndex = m.index + 1; break; }
    }
    if (m[0] === '') re.lastIndex = m.index + 1;
  }
  if (!replaced) return { text: str, count: 0, print };
  out += str.slice(last);
  return { text: out, count: replaced, print };
}

function sedUnescapeY(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') {
      const n = s[i + 1];
      if (n === undefined) { out += '\\'; continue; }
      const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
      if (n in esc) { out += esc[n]; i++; continue; }
      if (/[0-7]/.test(n)) {
        let oct = n; let j = i + 2;
        while (j < s.length && oct.length < 3 && /[0-7]/.test(s[j])) oct += s[j++];
        out += String.fromCharCode(parseInt(oct, 8)); i = j - 1; continue;
      }
      out += n; i++; continue;
    }
    out += ch;
  }
  return [...out];
}

function sedAddrMatch(addr, st, src) {
  if (!addr) return true;
  switch (addr.type) {
    case 'line': return st.lineNo === addr.line;
    case 'last': return st.isLast;
    case 'step': return addr.step > 0 && st.lineNo >= addr.first && ((st.lineNo - addr.first) % addr.step === 0);
    case 'regex': {
      const re = new RegExp(makeRegex(addr.source, { extended: src.extended, basic: !src.extended, icase: /i/i.test(addr.flags) }).source, '');
      return re.test(st.pattern);
    }
    default: return false;
  }
}

function sedRangeSelect(node, st, src) {
  if (!node.addr1 && !node.addr2) return { ok: true, ended: true };
  if (!node.addr2) return { ok: sedAddrMatch(node.addr1, st, src), ended: true };
  let rs = st.ranges.get(node);
  if (!rs) { rs = { active: false }; st.ranges.set(node, rs); }
  let ok = false;
  if (!rs.active) {
    if (sedAddrMatch(node.addr1, st, src)) {
      rs.active = true;
      if (node.addr2.type === 'plus') rs.end = st.lineNo + node.addr2.n;
      else if (node.addr2.type === 'mod') {
        const m = node.addr2.n;
        const rem = st.lineNo % m;
        rs.end = m > 0 ? st.lineNo + (rem === 0 ? m : m - rem) : st.lineNo;
      }
      ok = true;
    }
  } else {
    ok = true;
    let end = false;
    if (rs.end !== undefined) end = st.lineNo >= rs.end;
    else if (node.addr2.type === 'line') end = st.lineNo >= node.addr2.line;
    else if (node.addr2.type === 'last') end = st.isLast;
    else if (node.addr2.type === 'regex') end = sedAddrMatch(node.addr2, st, src);
    if (end) { rs.active = false; return { ok: true, ended: true }; }
  }
  return { ok, ended: false };
}

function sedLString(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\x07') out += '\\a';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\v') out += '\\v';
    else if (code < 32 || code === 127) out += '\\' + code.toString(8).padStart(3, '0');
    else out += ch;
  }
  return out + '$';
}

function sedRunCycle(c, list, st, src) {
  const labels = src.labels;
  const emit = (s) => st.out.push(s);
  const autoPrint = () => { if (!src.quiet) emit(st.pattern + '\n'); };
  const flushAppend = () => {
    for (const a of st.append) emit(a.endsWith('\n') ? a : a + '\n');
    st.append = [];
  };
  const runList = (cmds) => {
    let i = 0;
    while (i < cmds.length) {
      const node = cmds[i];
      if (node.type === 'cmd' && node.cmd === ':') { i++; continue; }
      const sel = node.addr1 || node.addr2 ? sedRangeSelect(node, st, src) : { ok: true, ended: true };
      const active = node.negate ? !sel.ok : sel.ok;
      if (!active) { i++; continue; }
      if (node.type === 'group') {
        runList(node.body);
        i++;
        continue;
      }
      const cmd = node.cmd;
      switch (cmd) {
        case 's': {
          const res = sedSubstitute(node.pattern, node.replacement, node.flags || '', st.pattern, src.extended);
          if (res.count) {
            st.pattern = res.text;
            st.subst = true;
            if ((node.flags || '').includes('p')) emit(st.pattern + '\n');
            if (node.wfile) st.writes.push({ file: node.wfile, text: st.pattern + '\n' });
          }
          break;
        }
        case 'y': {
          if (!node.yMap) {
            const from = sedUnescapeY(node.pattern), to = sedUnescapeY(node.replacement);
            const map = new Map();
            for (let k = 0; k < from.length; k++) map.set(from[k], to[k] ?? from[k]);
            node.yMap = map;
          }
          st.pattern = [...st.pattern].map((ch) => node.yMap.get(ch) ?? ch).join('');
          break;
        }
        case 'd': throw new SedNext();
        case 'D': {
          const nl = st.pattern.indexOf('\n');
          if (nl >= 0) { st.pattern = st.pattern.slice(nl + 1); throw new SedRestart(); }
          throw new SedNext();
        }
        case 'p': emit(st.pattern + '\n'); break;
        case 'P': emit((st.pattern.split('\n')[0]) + '\n'); break;
        case 'n': {
          autoPrint();
          flushAppend();
          if (!st.readNext()) throw new SedQuit(0);
          break;
        }
        case 'N': {
          if (!st.readNext(true)) { autoPrint(); flushAppend(); throw new SedQuit(0); }
          break;
        }
        case 'q': autoPrint(); flushAppend(); throw new SedQuit(node.code ?? 0);
        case 'Q': flushAppend(); throw new SedQuit(node.code ?? 0);
        case 'a': st.append.push(node.text ?? ''); break;
        case 'i': emit((node.text ?? '') + '\n'); break;
        case 'c': {
          if (node.addr2 && !sel.ended) break;
          st.deleted = true;
          emit((node.text ?? '') + '\n');
          throw new SedNext();
        }
        case 'r': {
          try { st.append.push(readTextFile(c, node.file)); }
          catch { /* ignore missing read file */ }
          break;
        }
        case 'w': st.writes.push({ file: node.file, text: st.pattern + '\n' }); break;
        case 'h': st.hold = st.pattern; break;
        case 'H': st.hold = st.hold === '' ? st.pattern : st.hold + '\n' + st.pattern; break;
        case 'g': st.pattern = st.hold; break;
        case 'G': st.pattern = st.pattern + '\n' + st.hold; break;
        case 'x': { const t = st.pattern; st.pattern = st.hold; st.hold = t; break; }
        case 'z': st.pattern = ''; break;
        case '=': emit(st.lineNo + '\n'); break;
        case 'l': emit(sedLString(st.pattern) + '\n'); break;
        case 'b': case 't': case 'T': {
          const jump = cmd === 'b' ? true : cmd === 't' ? st.subst : !st.subst;
          if (cmd === 't') st.subst = false;
          if (jump) {
            if (!node.label) throw new SedJump(null);
            const target = labels.get(node.label, cmds);
            if (target === cmds) {
              let idx = -1;
              for (let k = 0; k < cmds.length; k++) if (cmds[k].type === 'cmd' && cmds[k].cmd === ':' && cmds[k].label === node.label) { idx = k; break; }
              if (idx >= 0) { i = idx; continue; }
            }
            throw new SedJump(node.label);
          }
          break;
        }
        default: break;
      }
      i++;
    }
  };
  for (;;) {
    try {
      runList(list);
      return { deleted: st.deleted };
    } catch (e) {
      if (e instanceof SedRestart) continue;
      if (e instanceof SedJump) {
        if (e.label === null) return { deleted: st.deleted };
        const target = src.labels.get(e.label);
        if (target && target.length !== undefined) { list = target; continue; }
        return { deleted: st.deleted };
      }
      if (e instanceof SedNext) return { deleted: true };
      if (e instanceof SedQuit) { st.quit = true; st.quitCode = e.code; return { deleted: true }; }
      throw e;
    }
  }
}

function sedBuildScript(text, extended) {
  const labels = new Map();
  const sc = new SedScanner(text);
  // parseSedScript stores labels only as a set; re-parse to retain command lists
  const parser = { text, i: 0 };
  const list = (function parse() {
    const tmpLabels = labels;
    // reuse parseSedScript internals by storing label command nodes: parse twice is wasteful,
    // so parse directly using the same scanner logic via parseSedScript then index labels.
    return parseSedScript(text, extended, tmpLabels);
  })();
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n.type === 'cmd' && n.cmd === ':' && n.label) labels.set(n.label, list);
  }
  return { list, labels, extended };
}

async function sedRun(c, argv) {
  const scripts = [];
  const files = [];
  let quiet = false, extended = false, inPlace = null, separateFiles = false, usingE = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-' ) { files.push(a); continue; }
    if (a.startsWith('--')) {
      if (a === '--quiet' || a === '--silent') quiet = true;
      else if (a === '--regexp-extended') extended = true;
      else if (a === '--separate') separateFiles = true;
      else if (a.startsWith('--in-place')) inPlace = a.includes('=') ? a.slice(a.indexOf('=') + 1) : '';
      else if (a.startsWith('--expression=')) { scripts.push(a.slice(13)); usingE = true; }
      else if (a.startsWith('--file=')) { try { scripts.push(readTextFile(c, a.slice(7))); usingE = true; } catch (e) { return reportErr(c, `sed: ${a.slice(7)}: ${errnoText(e)}`, 2); } }
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      if (a[1] === 'i') { inPlace = a.slice(2); continue; }
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'n') quiet = true;
        else if (ch === 'E' || ch === 'r') extended = true;
        else if (ch === 's') separateFiles = true;
        else if (ch === 'e') { scripts.push(a.slice(k + 1) || argv[++i] || ''); usingE = true; k = a.length; }
        else if (ch === 'f') { const f = a.slice(k + 1) || argv[++i]; try { scripts.push(readTextFile(c, f)); usingE = true; } catch (e) { return reportErr(c, `sed: ${f}: ${errnoText(e)}`, 2); } k = a.length; }
        else if (ch === 'u') { /* unbuffered: no-op */ }
      }
      continue;
    }
    files.push(a);
  }
  if (!usingE) {
    if (!files.length) return reportErr(c, 'sed: no script specified', 2);
    scripts.push(files.shift());
  }
  let scriptList = [];
  let labels = new Map();
  for (const s of scripts) {
    try {
      const parsed = sedBuildScript(s, extended);
      scriptList = scriptList.concat(parsed.list);
      for (const [k, v] of parsed.labels) labels.set(k, v);
    } catch (e) { return reportErr(c, `sed: ${e.message}`, 2); }
  }
  const src = { quiet, extended, labels };
  const sink = [];
  const st = {
    lineNo: 0, isLast: false, pattern: '', hold: '', deleted: false, subst: false,
    append: [], ranges: new Map(), out: sink, writes: [], quit: false, quitCode: 0,
  };
  const runLines = (lines, startLineNo, lastLineNo) => {
    let idx = 0;
    st.lineNo = startLineNo;
    st.readNext = (N) => {
      if (idx >= lines.length) return false;
      if (N) st.pattern += '\n' + lines[idx++];
      else { st.pattern = lines[idx++]; }
      st.lineNo++;
      st.isLast = st.lineNo === lastLineNo;
      st.subst = false;
      st.deleted = false;
      return true;
    };
    while (idx < lines.length) {
      st.readNext(false);
      const r = sedRunCycle(c, scriptList, st, src);
      if (!src.quiet && !r.deleted) sink.push(st.pattern + '\n');
      for (const a of st.append) sink.push(a.endsWith('\n') ? a : a + '\n');
      st.append = [];
      if (st.quit) break;
    }
  };
  try {
    if (!files.length || (files.length === 1 && files[0] === '-')) {
      const text = await c.readText();
      const lines = splitOutput(text).lines;
      runLines(lines, 0, lines.length);
    } else if (inPlace !== null) {
      for (const f of files) {
        let text;
        try { text = readTextFile(c, f); } catch (e) { c.err(`sed: ${f}: ${errnoText(e)}\n`); continue; }
        const start = sink.length;
        st.quit = false; st.quitCode = 0; st.ranges.clear();
        const lines = splitOutput(text).lines;
        runLines(lines, 0, lines.length);
        const result = sink.slice(start).join('');
        try {
          if (inPlace) c.vfs.writeFile(ctxPath(c, f) + inPlace, textBytes(text), cred(c));
          c.vfs.writeFile(ctxPath(c, f), textBytes(result), cred(c));
        } catch (e) { c.err(`sed: ${f}: ${errnoText(e)}\n`); }
      }
      c.out('');
    } else {
      const all = [];
      for (const f of files) {
        try { all.push(...splitOutput(readTextFile(c, f)).lines); }
        catch (e) { c.err(`sed: ${f}: ${errnoText(e)}\n`); }
      }
      runLines(all, 0, all.length);
    }
  } catch (e) {
    if (!(e instanceof SedQuit)) return reportErr(c, `sed: ${e.message || e}`, 2);
  }
  for (const w of st.writes) {
    try { c.vfs.writeFile(ctxPath(c, w.file), textBytes(w.text), cred(c), { append: true }); }
    catch { /* ignore */ }
  }
  if (inPlace === null) c.out(sink.join(''));
  return st.quitCode || 0;
}

/* ============================== awk ============================== */

const AWK_KEYWORDS = new Set(['BEGIN', 'END', 'function', 'if', 'else', 'while', 'do', 'for', 'break', 'continue', 'next', 'exit', 'return', 'delete', 'print', 'printf', 'in', 'getline', 'nextfile']);
const AWK_BUILTINS = new Set(['length', 'substr', 'index', 'split', 'match', 'sub', 'gsub', 'sprintf', 'sin', 'cos', 'atan2', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand', 'tolower', 'toupper', 'system', 'close', 'fflush']);

function awkTokenize(src) {
  const toks = [];
  let i = 0;
  const last = () => toks[toks.length - 1];
  const regexAllowed = () => {
    const p = last();
    if (!p) return true;
    if (p.type === 'num' || p.type === 'str' || p.type === 'regex') return false;
    if (p.type === 'name') return false;
    if (p.type === 'op' && (p.v === ')' || p.v === ']' || p.v === '++' || p.v === '--' || p.v === '$')) return false;
    if (p.type === 'kw' && (p.v === 'getline')) return false;
    return true;
  };
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\r') { i++; continue; }
    if (ch === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (ch === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '\n') {
      i++;
      const p = last();
      const suppress = p && ((p.type === 'op' && ![')', ']', '++', '--'].includes(p.v)) || (p.type === 'kw' && ['print', 'printf', 'else', 'do'].includes(p.v)));
      if (!suppress) toks.push({ type: 'op', v: ';' });
      continue;
    }
    if (ch === '"') {
      i++;
      let s = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') {
          const n = src[i + 1];
          const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b', f: '\f', v: '\v' };
          if (n in esc) { s += esc[n]; i += 2; continue; }
          if (/[0-7]/.test(n)) {
            let oct = '';
            let j = i + 1;
            while (j < src.length && oct.length < 3 && /[0-7]/.test(src[j])) oct += src[j++];
            s += String.fromCharCode(parseInt(oct, 8)); i = j; continue;
          }
          s += n; i += 2; continue;
        }
        s += src[i++];
      }
      i++;
      toks.push({ type: 'str', v: s });
      continue;
    }
    if (/\d/.test(ch) || (ch === '.' && /\d/.test(src[i + 1] || ''))) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      if (/[eE]/.test(src[j] || '')) {
        j++;
        if (src[j] === '+' || src[j] === '-') j++;
        while (j < src.length && /\d/.test(src[j])) j++;
      }
      toks.push({ type: 'num', v: Number(src.slice(i, j)) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i + 1;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      i = j;
      if (AWK_KEYWORDS.has(word)) toks.push({ type: 'kw', v: word });
      else toks.push({ type: 'name', v: word });
      continue;
    }
    if (ch === '/' && regexAllowed()) {
      i++;
      let s = '', closed = false;
      while (i < src.length) {
        if (src[i] === '\\') { s += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
        if (src[i] === '/') { i++; closed = true; break; }
        s += src[i++];
      }
      if (closed) toks.push({ type: 'regex', v: s });
      else toks.push({ type: 'op', v: '/' });
      continue;
    }
    const three = src.slice(i, i + 3);
    if (three === '**=') { toks.push({ type: 'op', v: '^=' }); i += 3; continue; }
    const two = src.slice(i, i + 2);
    const twoOps = ['==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '!~', '>>', '**'];
    if (twoOps.includes(two)) {
      toks.push({ type: 'op', v: two === '**' ? '^' : two });
      i += 2;
      continue;
    }
    toks.push({ type: 'op', v: ch });
    i++;
  }
  return toks;
}

class AwkParser {
  constructor(tokens) { this.toks = tokens; this.i = 0; this.parenDepth = 0; this.printCtx = 0; }
  peek(k = 0) { return this.toks[this.i + k] || { type: 'eof', v: '' }; }
  next() { return this.toks[this.i++] || { type: 'eof', v: '' }; }
  isOp(v, k = 0) { const t = this.peek(k); return t.type === 'op' && t.v === v; }
  isKw(v, k = 0) { const t = this.peek(k); return t.type === 'kw' && t.v === v; }
  eatOp(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  eatKw(v) { if (this.isKw(v)) { this.i++; return true; } return false; }
  expectOp(v) { if (!this.eatOp(v)) throw new Error(`awk: expected '${v}'`); }
  skipSemis() { while (this.isOp(';')) this.i++; }
  skipNewlines() { while (this.isOp(';')) this.i++; }
  parseProgram() {
    const prog = { begin: [], end: [], rules: [], functions: new Map() };
    for (;;) {
      this.skipSemis();
      if (this.peek().type === 'eof') break;
      if (this.eatKw('BEGIN')) { this.skipSemis(); prog.begin.push(this.parseBlock()); continue; }
      if (this.eatKw('END')) { this.skipSemis(); prog.end.push(this.parseBlock()); continue; }
      if (this.eatKw('function')) {
        const name = this.next().v;
        this.expectOp('(');
        const params = [];
        while (!this.isOp(')')) { params.push(this.next().v); if (!this.eatOp(',')) break; }
        this.expectOp(')');
        this.skipSemis();
        prog.functions.set(name, { params, body: this.parseBlock() });
        continue;
      }
      if (this.isOp('{')) { prog.rules.push({ pat: null, action: this.parseBlock() }); continue; }
      const pat = this.parseExpr();
      this.skipSemis();
      let action = null;
      if (this.isOp('{')) action = this.parseBlock();
      prog.rules.push({ pat, action });
    }
    return prog;
  }
  parseBlock() {
    this.expectOp('{');
    const body = [];
    for (;;) {
      this.skipSemis();
      if (this.isOp('}')) { this.i++; break; }
      if (this.peek().type === 'eof') throw new Error('awk: unexpected end of program');
      body.push(this.parseStmt());
      this.skipSemis();
    }
    return { t: 'block', body };
  }
  parseStmt() {
    this.skipSemis();
    if (this.isOp('{')) return this.parseBlock();
    if (this.eatKw('if')) {
      this.expectOp('(');
      const c = this.parseExpr();
      this.expectOp(')');
      this.skipSemis();
      const then = this.parseStmt();
      this.skipSemis();
      let els = null;
      if (this.eatKw('else')) { this.skipSemis(); els = this.parseStmt(); }
      return { t: 'if', c, then, els };
    }
    if (this.eatKw('while')) {
      this.expectOp('(');
      const c = this.parseExpr();
      this.expectOp(')');
      this.skipSemis();
      return { t: 'while', c, body: this.parseStmt() };
    }
    if (this.eatKw('do')) {
      this.skipSemis();
      const body = this.parseStmt();
      this.skipSemis();
      if (!this.eatKw('while')) throw new Error('awk: expected while after do body');
      this.expectOp('(');
      const c = this.parseExpr();
      this.expectOp(')');
      return { t: 'do', body, c };
    }
    if (this.eatKw('for')) {
      this.expectOp('(');
      if (this.peek().type === 'name' && this.isKw('in', 1)) {
        const name = this.next().v;
        this.i++;
        const arr = this.next().v;
        this.expectOp(')');
        this.skipSemis();
        return { t: 'forin', name, arr, body: this.parseStmt() };
      }
      let init = null, cond = null, inc = null;
      if (!this.isOp(';')) init = this.parseExpr();
      this.expectOp(';');
      if (!this.isOp(';')) cond = this.parseExpr();
      this.expectOp(';');
      if (!this.isOp(')')) inc = this.parseExpr();
      this.expectOp(')');
      this.skipSemis();
      return { t: 'for', init, cond, inc, body: this.parseStmt() };
    }
    if (this.eatKw('break')) return { t: 'break' };
    if (this.eatKw('continue')) return { t: 'continue' };
    if (this.eatKw('next')) return { t: 'next' };
    if (this.eatKw('nextfile')) return { t: 'next' };
    if (this.eatKw('exit')) {
      let e = null;
      if (!this.isOp(';') && !this.isOp('}') && this.peek().type !== 'eof') e = this.parseExpr();
      return { t: 'exit', e };
    }
    if (this.eatKw('return')) {
      let e = null;
      if (!this.isOp(';') && !this.isOp('}') && this.peek().type !== 'eof') e = this.parseExpr();
      return { t: 'return', e };
    }
    if (this.eatKw('delete')) {
      const name = this.next().v;
      let idx = null;
      if (this.eatOp('[')) { idx = []; while (!this.isOp(']')) { idx.push(this.parseExpr()); if (!this.eatOp(',')) break; } this.expectOp(']'); }
      return { t: 'delete', name, idx };
    }
    if (this.isKw('print') || this.isKw('printf')) {
      const which = this.next().v;
      const args = [];
      let redir = null;
      if (!this.isOp(';') && !this.isOp('}') && this.peek().type !== 'eof' && !this.isOp('>') && !this.isOp('>>')) {
        this.printCtx++;
        for (;;) {
          args.push(this.parseExpr());
          if (!this.eatOp(',')) break;
        }
        this.printCtx--;
      }
      if (this.isOp('>') || this.isOp('>>')) {
        const op = this.next().v;
        redir = { op, target: this.parseExpr() };
      }
      return { t: which, args, redir };
    }
    return { t: 'expr', e: this.parseExpr() };
  }
  parseExpr() { return this.parseAssign(); }
  parseAssign() {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.type === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '^='].includes(t.v)) {
      this.i++;
      const right = this.parseAssign();
      return { t: 'assign', op: t.v, target: left, value: right };
    }
    return left;
  }
  parseTernary() {
    const c = this.parseOr();
    if (this.eatOp('?')) {
      const a = this.parseAssign();
      this.expectOp(':');
      const b = this.parseAssign();
      return { t: 'ternary', c, a, b };
    }
    return c;
  }
  parseOr() {
    let l = this.parseAnd();
    while (this.isOp('||')) { this.i++; l = { t: 'bin', op: '||', l, r: this.parseAnd() }; }
    return l;
  }
  parseAnd() {
    let l = this.parseIn();
    while (this.isOp('&&')) { this.i++; l = { t: 'bin', op: '&&', l, r: this.parseIn() }; }
    return l;
  }
  parseIn() {
    let l = this.parseMatch();
    while (this.isKw('in')) {
      this.i++;
      const arr = this.next().v;
      l = { t: 'in', e: l, arr };
    }
    return l;
  }
  parseMatch() {
    let l = this.parseCompare();
    while (this.isOp('~') || this.isOp('!~')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.parseCompare() };
    }
    return l;
  }
  parseCompare() {
    let l = this.parseConcat();
    while (this.peek().type === 'op' && ['<', '<=', '>', '>=', '==', '!='].includes(this.peek().v)) {
      if (this.peek().v === '>' && this.printCtx > 0 && this.parenDepth === 0) break;
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.parseConcat() };
    }
    return l;
  }
  startsExpr(t) {
    if (!t) return false;
    if (t.type === 'num' || t.type === 'str' || t.type === 'regex' || t.type === 'name') return true;
    if (t.type === 'kw' && (t.v === 'getline' || AWK_BUILTINS.has(t.v))) return true;
    if (t.type === 'op' && (t.v === '(' || t.v === '$' || t.v === '!' || t.v === '++' || t.v === '--')) return true;
    return false;
  }
  parseConcat() {
    let l = this.parseAdd();
    while (this.startsExpr(this.peek())) {
      l = { t: 'concat', l, r: this.parseAdd() };
    }
    return l;
  }
  parseAdd() {
    let l = this.parseMul();
    while (this.isOp('+') || this.isOp('-')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.parseMul() };
    }
    return l;
  }
  parseMul() {
    let l = this.parseUnary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) {
      const op = this.next().v;
      l = { t: 'bin', op, l, r: this.parseUnary() };
    }
    return l;
  }
  parseUnary() {
    if (this.isOp('!') || this.isOp('-') || this.isOp('+')) {
      const op = this.next().v;
      return { t: 'un', op, e: this.parseUnary() };
    }
    return this.parsePow();
  }
  parsePow() {
    const l = this.parsePostfix();
    if (this.isOp('^')) {
      this.i++;
      return { t: 'bin', op: '^', l, r: this.parseUnary() };
    }
    return l;
  }
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      if (this.isOp('++') || this.isOp('--')) {
        const op = this.next().v;
        e = { t: 'post', op, target: e };
        continue;
      }
      if (this.isOp('[')) {
        if (e.t !== 'var') break;
        this.i++;
        const idx = [];
        while (!this.isOp(']')) { idx.push(this.parseExpr()); if (!this.eatOp(',')) break; }
        this.expectOp(']');
        e = { t: 'index', obj: e.name, idx };
        continue;
      }
      break;
    }
    return e;
  }
  parsePrimary() {
    const t = this.peek();
    if (t.type === 'num') { this.i++; return { t: 'num', v: t.v }; }
    if (t.type === 'str') { this.i++; return { t: 'str', v: t.v }; }
    if (t.type === 'regex') { this.i++; return { t: 'regex', v: t.v }; }
    if (t.type === 'op' && t.v === '(') {
      this.i++;
      this.parenDepth++;
      const e = this.parseExpr();
      this.parenDepth--;
      this.expectOp(')');
      return e;
    }
    if (t.type === 'op' && t.v === '$') {
      this.i++;
      return { t: 'field', e: this.parseUnary() };
    }
    if (t.type === 'op' && (t.v === '++' || t.v === '--')) {
      this.i++;
      return { t: 'pre', op: t.v, target: this.parsePostfix() };
    }
    if (t.type === 'kw' && t.v === 'getline') {
      this.i++;
      let target = null;
      if (this.peek().type === 'name' || this.isOp('$')) {
        target = this.parsePostfix();
      }
      let file = null;
      if (this.eatOp('<')) file = this.parseConcat();
      return { t: 'getline', target, file };
    }
    if (t.type === 'name') {
      this.i++;
      if (this.eatOp('(')) {
        const args = [];
        while (!this.isOp(')')) { args.push(this.parseExpr()); if (!this.eatOp(',')) break; }
        this.expectOp(')');
        return { t: 'call', name: t.v, args };
      }
      return { t: 'var', name: t.v };
    }
    if (t.type === 'kw' && AWK_BUILTINS.has(t.v)) {
      this.i++;
      this.expectOp('(');
      const args = [];
      while (!this.isOp(')')) { args.push(this.parseExpr()); if (!this.eatOp(',')) break; }
      this.expectOp(')');
      return { t: 'call', name: t.v, args };
    }
    throw new Error(`awk: unexpected token '${t.v}'`);
  }
}

class AwkNext extends Error {}
class AwkBreak extends Error {}
class AwkContinue extends Error {}
class AwkExit extends Error { constructor(code) { super('exit'); this.code = code; } }
class AwkReturn extends Error { constructor(v) { super('return'); this.value = v; } }

function awkNumToStr(n) {
  if (Number.isNaN(n)) return 'nan';
  if (!Number.isFinite(n)) return n > 0 ? 'inf' : '-inf';
  if (Number.isInteger(n)) return String(n);
  return String(Number(n.toPrecision(6)));
}

function awkToStr(v) {
  if (v == null) return '';
  if (typeof v === 'number') return awkNumToStr(v);
  if (v && v.__regex !== undefined) return String(v.__regex);
  if (v instanceof Map) return '';
  return String(v);
}

function awkToNum(v) {
  if (typeof v === 'number') return v;
  if (v == null) return 0;
  if (v && v.__regex !== undefined) return 0;
  const n = Number(String(v).trim());
  return Number.isNaN(n) ? 0 : n;
}

function awkTruthy(v, rt) {
  if (typeof v === 'number') return v !== 0;
  if (v && v.__regex !== undefined) return new RegExp(v.__regex).test(rt.record);
  if (v instanceof Map) return v.size > 0;
  const s = String(v ?? '');
  if (s === '') return false;
  return isNumericStr(s) ? Number(s) !== 0 : true;
}

function awkCompare(a, b) {
  const an = typeof a === 'number' || isNumericStr(String(a ?? ''));
  const bn = typeof b === 'number' || isNumericStr(String(b ?? ''));
  if (an && bn) { const x = awkToNum(a), y = awkToNum(b); return x < y ? -1 : x > y ? 1 : 0; }
  const x = awkToStr(a), y = awkToStr(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function awkRegExp(v) {
  const src = v && v.__regex !== undefined ? v.__regex : String(v);
  try { return new RegExp(src); } catch { return new RegExp(escapeRegExp(src)); }
}

function awkFormat(fmt, args) {
  let ai = 0, out = '';
  const nextArg = () => args[ai++];
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '\\') {
      const n = fmt[i + 1];
      const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
      if (n in esc) { out += esc[n]; i++; continue; }
      if (/[0-7]/.test(n)) {
        let oct = ''; let j = i + 1;
        while (j < fmt.length && oct.length < 3 && /[0-7]/.test(fmt[j])) oct += fmt[j++];
        out += String.fromCharCode(parseInt(oct, 8)); i = j - 1; continue;
      }
      out += n; i++; continue;
    }
    if (ch !== '%') { out += ch; continue; }
    if (fmt[i + 1] === '%') { out += '%'; i++; continue; }
    let j = i + 1;
    let flags = '';
    while (j < fmt.length && '-+ 0#'.includes(fmt[j])) flags += fmt[j++];
    let width = '';
    if (fmt[j] === '*') { width = String(Math.trunc(awkToNum(nextArg()))); j++; }
    else while (j < fmt.length && /\d/.test(fmt[j])) width += fmt[j++];
    let prec = null;
    if (fmt[j] === '.') {
      j++; prec = '';
      if (fmt[j] === '*') { prec = String(Math.trunc(awkToNum(nextArg()))); j++; }
      else while (j < fmt.length && /\d/.test(fmt[j])) prec += fmt[j++];
    }
    const conv = fmt[j++];
    const arg = nextArg();
    let s;
    switch (conv) {
      case 's': s = awkToStr(arg); if (prec !== null) s = s.slice(0, Number(prec)); break;
      case 'd': case 'i': s = String(Math.trunc(awkToNum(arg))); break;
      case 'u': s = String(Math.trunc(awkToNum(arg)) >>> 0); break;
      case 'o': s = Math.trunc(awkToNum(arg)).toString(8); break;
      case 'x': s = Math.trunc(awkToNum(arg)).toString(16); break;
      case 'X': s = Math.trunc(awkToNum(arg)).toString(16).toUpperCase(); break;
      case 'c': s = typeof arg === 'number' ? String.fromCharCode(arg) : awkToStr(arg).slice(0, 1); break;
      case 'f': s = awkToNum(arg).toFixed(prec !== null ? Number(prec) : 6); break;
      case 'e': case 'E': s = awkToNum(arg).toExponential(prec !== null ? Number(prec) : 6); if (conv === 'E') s = s.toUpperCase(); break;
      case 'g': case 'G': {
        const n = awkToNum(arg);
        s = prec !== null ? String(Number(n.toPrecision(Number(prec) || 1))) : awkNumToStr(n);
        if (conv === 'G') s = s.toUpperCase();
        break;
      }
      default: s = '%' + conv; ai--;
    }
    const w = Number(width) || 0;
    if (w > s.length) {
      if (flags.includes('-')) s = s.padEnd(w);
      else if (flags.includes('0') && /^[0-9]/.test(s)) {
        const sign = s[0] === '-' ? '-' : '';
        s = sign + s.slice(sign.length).padStart(w - sign.length, '0');
      } else s = s.padStart(w);
    }
    out += s;
    i = j - 1;
  }
  return out;
}

function awkSplitRecord(rec, fs) {
  if (rec === '') return [];
  if (fs === ' ' || fs == null) return rec.trim().split(/\s+/).filter((s) => s !== '');
  if (fs === '') return [...rec];
  if (fs.length === 1) return rec.split(fs);
  let re;
  try { re = new RegExp(fs); } catch { re = new RegExp(escapeRegExp(fs)); }
  return rec.split(re);
}

function awkSplitRecords(text, rs) {
  if (rs === '') return text.split(/\n{2,}/).map((s) => s.replace(/^\n+|\n+$/g, '')).filter((s) => s !== '');
  const sep = rs === ' ' ? ' ' : rs;
  if (sep === '\n') return splitOutput(text).lines;
  const parts = text.split(sep);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

function awkRegexValue(src) { return { __regex: src }; }

function awkMakeRt(c, prog) {
  const rt = {
    c, prog, vars: new Map(), frames: [],
    record: '', fields: [], NR: 0, FNR: 0, FILENAME: '',
    FILENAME_DEFAULT: '', FS: ' ', OFS: ' ', ORS: '\n', RS: '\n', SUBSEP: '\x1c',
    RSTART: 0, RLENGTH: -1, ARGC: 0, ARGV: new Map(),
    CONVFMT: '%.6g', OFMT: '%.6g', exitCode: 0, out: [],
    readers: new Map(), mainReader: null,
  };
  rt.setRecord = (rec) => { rt.record = rec; rt.fields = awkSplitRecord(rec, rt.FS); };
  rt.getField = (n) => {
    n = Math.trunc(n);
    if (n === 0) return rt.record;
    if (n < 0) return '';
    return rt.fields[n - 1] ?? '';
  };
  rt.setField = (n, v) => {
    n = Math.trunc(n);
    const s = awkToStr(v);
    if (n === 0) { rt.setRecord(s); return; }
    while (rt.fields.length < n) rt.fields.push('');
    rt.fields[n - 1] = s;
    rt.record = rt.fields.join(rt.OFS);
  };
  rt.setNF = (n) => {
    n = Math.max(0, Math.trunc(n));
    while (rt.fields.length < n) rt.fields.push('');
    rt.fields.length = n;
    rt.record = rt.fields.join(rt.OFS);
  };
  rt.emit = (s) => rt.out.push(s);
  rt.getVar = (name) => {
    switch (name) {
      case 'NF': return rt.fields.length;
      case 'NR': return rt.NR;
      case 'FNR': return rt.FNR;
      case 'FILENAME': return rt.FILENAME;
      case 'FS': return rt.FS;
      case 'OFS': return rt.OFS;
      case 'ORS': return rt.ORS;
      case 'RS': return rt.RS;
      case 'SUBSEP': return rt.SUBSEP;
      case 'RSTART': return rt.RSTART;
      case 'RLENGTH': return rt.RLENGTH;
      case 'ARGC': return rt.ARGC;
      case 'CONVFMT': return rt.CONVFMT;
      case 'OFMT': return rt.OFMT;
      default: break;
    }
    for (let i = rt.frames.length - 1; i >= 0; i--) if (rt.frames[i].has(name)) return rt.frames[i].get(name);
    return rt.vars.has(name) ? rt.vars.get(name) : '';
  };
  rt.setVar = (name, v) => {
    switch (name) {
      case 'NF': rt.setNF(awkToNum(v)); return;
      case 'NR': rt.NR = awkToNum(v); return;
      case 'FNR': rt.FNR = awkToNum(v); return;
      case 'FILENAME': rt.FILENAME = awkToStr(v); return;
      case 'FS': rt.FS = awkToStr(v); return;
      case 'OFS': rt.OFS = awkToStr(v); return;
      case 'ORS': rt.ORS = awkToStr(v); return;
      case 'RS': rt.RS = awkToStr(v); return;
      case 'SUBSEP': rt.SUBSEP = awkToStr(v); return;
      case 'RSTART': rt.RSTART = awkToNum(v); return;
      case 'RLENGTH': rt.RLENGTH = awkToNum(v); return;
      case 'ARGC': rt.ARGC = awkToNum(v); return;
      case 'CONVFMT': rt.CONVFMT = awkToStr(v); return;
      case 'OFMT': rt.OFMT = awkToStr(v); return;
      default: break;
    }
    for (let i = rt.frames.length - 1; i >= 0; i--) if (rt.frames[i].has(name)) { rt.frames[i].set(name, v); return; }
    rt.vars.set(name, v);
  };
  rt.getArray = (name) => {
    let cur = rt.getVar(name);
    if (cur instanceof Map) return cur;
    const arr = new Map();
    rt.setVar(name, arr);
    return arr;
  };
  rt.isArray = (name) => rt.getVar(name) instanceof Map;
  return rt;
}

function awkLValueKey(rt, node) {
  return node.idx.map((e) => awkToStr(rt.evalSync(e))).join(rt.SUBSEP);
}

async function awkEval(node, rt) {
  if (!node) return '';
  switch (node.t) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'regex': return awkRegexValue(node.v);
    case 'var': return rt.getVar(node.name);
    case 'field': return rt.getField(awkToNum(await awkEval(node.e, rt)));
    case 'index': {
      const idx = [];
      for (const e of node.idx) idx.push(awkToStr(await awkEval(e, rt)));
      return rt.getArray(node.obj).get(idx.join(rt.SUBSEP)) ?? '';
    }
    case 'concat': return awkToStr(await awkEval(node.l, rt)) + awkToStr(await awkEval(node.r, rt));
    case 'un': {
      const v = await awkEval(node.e, rt);
      if (node.op === '!') return awkTruthy(v, rt) ? 0 : 1;
      if (node.op === '-') return -awkToNum(v);
      return awkToNum(v);
    }
    case 'bin': return awkEvalBin(node, rt);
    case 'ternary': return awkTruthy(await awkEval(node.c, rt), rt) ? awkEval(node.a, rt) : awkEval(node.b, rt);
    case 'in': {
      const key = awkToStr(await awkEval(node.e, rt));
      return rt.getArray(node.arr).has(key) ? 1 : 0;
    }
    case 'assign': {
      let value = await awkEval(node.value, rt);
      const old = await awkReadLValue(node.target, rt);
      if (node.op !== '=') {
        const a = awkToNum(old), b = awkToNum(value);
        value = node.op === '+=' ? a + b : node.op === '-=' ? a - b : node.op === '*=' ? a * b
          : node.op === '/=' ? (b === 0 ? 0 : a / b) : node.op === '%=' ? (b === 0 ? 0 : a % b) : Math.pow(a, b);
      }
      await awkWriteLValue(node.target, value, rt);
      return value;
    }
    case 'pre': case 'post': {
      const old = awkToNum(await awkReadLValue(node.target, rt));
      const nv = node.op === '++' ? old + 1 : old - 1;
      await awkWriteLValue(node.target, nv, rt);
      return node.t === 'pre' ? nv : old;
    }
    case 'call': return awkCall(node, rt);
    case 'getline': return awkGetline(node, rt);
    default: return '';
  }
}

function awkEvalSync(node, rt) {
  // Only used for array subscripts, which are simple expressions in practice.
  switch (node.t) {
    case 'num': return node.v;
    case 'str': return node.v;
    case 'var': return rt.getVar(node.name);
    case 'concat': return awkToStr(awkEvalSync(node.l, rt)) + awkToStr(awkEvalSync(node.r, rt));
    case 'bin': {
      const l = awkToNum(awkEvalSync(node.l, rt)), r = awkToNum(awkEvalSync(node.r, rt));
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      return l;
    }
    default: return awkToStr(node.v ?? '');
  }
}

async function awkReadLValue(node, rt) {
  if (node.t === 'var') return rt.getVar(node.name);
  if (node.t === 'field') return rt.getField(awkToNum(await awkEval(node.e, rt)));
  if (node.t === 'index') {
    const idx = [];
    for (const e of node.idx) idx.push(awkToStr(await awkEval(e, rt)));
    return rt.getArray(node.obj).get(idx.join(rt.SUBSEP)) ?? '';
  }
  return '';
}

async function awkWriteLValue(node, value, rt) {
  if (node.t === 'var') { rt.setVar(node.name, value); return; }
  if (node.t === 'field') { rt.setField(awkToNum(await awkEval(node.e, rt)), value); return; }
  if (node.t === 'index') {
    const idx = [];
    for (const e of node.idx) idx.push(awkToStr(await awkEval(e, rt)));
    rt.getArray(node.obj).set(idx.join(rt.SUBSEP), value);
  }
}

async function awkEvalBin(node, rt) {
  if (node.op === '&&') {
    if (!awkTruthy(await awkEval(node.l, rt), rt)) return 0;
    return awkTruthy(await awkEval(node.r, rt), rt) ? 1 : 0;
  }
  if (node.op === '||') {
    if (awkTruthy(await awkEval(node.l, rt), rt)) return 1;
    return awkTruthy(await awkEval(node.r, rt), rt) ? 1 : 0;
  }
  const l = await awkEval(node.l, rt);
  const r = await awkEval(node.r, rt);
  switch (node.op) {
    case '+': return awkToNum(l) + awkToNum(r);
    case '-': return awkToNum(l) - awkToNum(r);
    case '*': return awkToNum(l) * awkToNum(r);
    case '/': { const d = awkToNum(r); return d === 0 ? (awkToNum(l) === 0 ? NaN : Infinity) : awkToNum(l) / d; }
    case '%': { const d = awkToNum(r); return d === 0 ? NaN : awkToNum(l) % d; }
    case '^': return Math.pow(awkToNum(l), awkToNum(r));
    case '==': return awkCompare(l, r) === 0 ? 1 : 0;
    case '!=': return awkCompare(l, r) !== 0 ? 1 : 0;
    case '<': return awkCompare(l, r) < 0 ? 1 : 0;
    case '<=': return awkCompare(l, r) <= 0 ? 1 : 0;
    case '>': return awkCompare(l, r) > 0 ? 1 : 0;
    case '>=': return awkCompare(l, r) >= 0 ? 1 : 0;
    case '~': return awkRegExp(r).test(awkToStr(l)) ? 1 : 0;
    case '!~': return awkRegExp(r).test(awkToStr(l)) ? 0 : 1;
    default: return 0;
  }
}

function awkSubstitute(rt, re, repl, str, global) {
  const reG = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  let out = '', last = 0, count = 0;
  let m;
  for (;;) {
    m = reG.exec(str);
    if (!m) break;
    let rep = '';
    for (let i = 0; i < repl.length; i++) {
      const ch = repl[i];
      if (ch === '&') { rep += m[0]; continue; }
      if (ch === '\\') {
        const n = repl[i + 1];
        if (n === '&') { rep += '&'; i++; continue; }
        if (n === '\\') { rep += '\\'; i++; continue; }
        if (/\d/.test(n)) { rep += m[Number(n)] ?? ''; i++; continue; }
        rep += n ?? ''; i++; continue;
      }
      rep += ch;
    }
    out += str.slice(last, m.index) + rep;
    last = m.index + m[0].length;
    count++;
    if (!global) break;
    if (m[0] === '') reG.lastIndex = m.index + 1;
  }
  if (!count) return { text: str, count: 0 };
  out += str.slice(last);
  return { text: out, count };
}

async function awkCall(node, rt) {
  const name = node.name;
  const prog = rt.prog;
  if (prog.functions.has(name)) {
    const fn = prog.functions.get(name);
    const frame = new Map();
    for (let i = 0; i < fn.params.length; i++) {
      const argNode = node.args[i];
      let v = '';
      if (argNode) {
        if (argNode.t === 'var' && rt.isArray(argNode.name)) v = rt.getArray(argNode.name);
        else v = await awkEval(argNode, rt);
      }
      frame.set(fn.params[i], v);
    }
    rt.frames.push(frame);
    try {
      await awkExec(fn.body, rt);
      return '';
    } catch (e) {
      if (e instanceof AwkReturn) return e.value;
      throw e;
    } finally {
      rt.frames.pop();
    }
  }
  const arg = (i) => (node.args[i] ? awkEval(node.args[i], rt) : Promise.resolve(''));
  switch (name) {
    case 'length': {
      if (!node.args.length) return rt.record.length;
      if (node.args[0].t === 'var' && rt.isArray(node.args[0].name)) return rt.getArray(node.args[0].name).size;
      return awkToStr(await arg(0)).length;
    }
    case 'substr': {
      const s = awkToStr(await arg(0));
      const start = Math.max(1, Math.trunc(awkToNum(await arg(1))));
      if (node.args.length > 2) {
        const len = Math.trunc(awkToNum(await arg(2)));
        return len <= 0 ? '' : s.slice(start - 1, start - 1 + len);
      }
      return s.slice(start - 1);
    }
    case 'index': {
      const s = awkToStr(await arg(0)), t = awkToStr(await arg(1));
      return s.indexOf(t) + 1;
    }
    case 'split': {
      const s = awkToStr(await arg(0));
      const arrNode = node.args[1];
      const fs = node.args.length > 2 ? awkToStr(await arg(2)) : rt.FS;
      if (!arrNode || arrNode.t !== 'var') return 0;
      const arr = rt.getArray(arrNode.name);
      arr.clear();
      const parts = awkSplitRecord(s, fs);
      for (let i = 0; i < parts.length; i++) arr.set(String(i + 1), parts[i]);
      return parts.length;
    }
    case 'match': {
      const s = awkToStr(await arg(0));
      const re = awkRegExp(await arg(1));
      const m = new RegExp(re.source, re.flags.replace('g', '')).exec(s);
      if (!m) { rt.RSTART = 0; rt.RLENGTH = -1; return 0; }
      rt.RSTART = m.index + 1; rt.RLENGTH = m[0].length;
      return rt.RSTART;
    }
    case 'sub': case 'gsub': {
      const re = awkRegExp(await arg(0));
      const repl = awkToStr(await arg(1));
      const targetNode = node.args[2];
      if (targetNode) {
        const old = awkToStr(await awkReadLValue(targetNode, rt));
        const r = awkSubstitute(rt, re, repl, old, name === 'gsub');
        if (r.count) await awkWriteLValue(targetNode, r.text, rt);
        return r.count;
      }
      const r = awkSubstitute(rt, re, repl, rt.record, name === 'gsub');
      if (r.count) rt.setRecord(r.text);
      return r.count;
    }
    case 'sprintf': {
      const args = [];
      for (const a of node.args) args.push(await awkEval(a, rt));
      return awkFormat(awkToStr(args[0]), args.slice(1));
    }
    case 'sin': return Math.sin(awkToNum(await arg(0)));
    case 'cos': return Math.cos(awkToNum(await arg(0)));
    case 'atan2': return Math.atan2(awkToNum(await arg(0)), awkToNum(await arg(1)));
    case 'exp': return Math.exp(awkToNum(await arg(0)));
    case 'log': return Math.log(awkToNum(await arg(0)));
    case 'sqrt': return Math.sqrt(awkToNum(await arg(0)));
    case 'int': return Math.trunc(awkToNum(await arg(0)));
    case 'rand': return Math.random();
    case 'srand': return 0;
    case 'tolower': return awkToStr(await arg(0)).toLowerCase();
    case 'toupper': return awkToStr(await arg(0)).toUpperCase();
    case 'system': {
      const cmd = awkToStr(await arg(0));
      if (!cmd) return -1;
      const res = await rt.c.spawn(cmd).done;
      return res.code;
    }
    case 'close': case 'fflush': return 0;
    default: return '';
  }
}

async function awkGetline(node, rt) {
  if (node.file) {
    const fname = awkToStr(await awkEval(node.file, rt));
    let reader = rt.readers.get(fname);
    if (!reader) {
      let text;
      try { text = readTextFile(rt.c, fname); } catch { return -1; }
      reader = { records: awkSplitRecords(text, rt.RS), idx: 0 };
      rt.readers.set(fname, reader);
    }
    if (reader.idx >= reader.records.length) return 0;
    const rec = reader.records[reader.idx++];
    if (node.target) await awkWriteLValue(node.target, rec, rt);
    else rt.setRecord(rec);
    return 1;
  }
  if (!rt.mainReader) return 0;
  const next = rt.mainReader();
  if (!next) return 0;
  rt.FILENAME = next.file;
  if (node.target) await awkWriteLValue(node.target, next.record, rt);
  else rt.setRecord(next.record);
  return 1;
}

async function awkExec(node, rt) {
  if (!node) return;
  switch (node.t) {
    case 'block': for (const s of node.body) await awkExec(s, rt); return;
    case 'if': if (awkTruthy(await awkEval(node.c, rt), rt)) await awkExec(node.then, rt); else if (node.els) await awkExec(node.els, rt); return;
    case 'while': {
      let guard = 0;
      while (awkTruthy(await awkEval(node.c, rt), rt)) {
        if (++guard > 10_000_000) break;
        try { await awkExec(node.body, rt); } catch (e) { if (e instanceof AwkBreak) break; if (!(e instanceof AwkContinue)) throw e; }
      }
      return;
    }
    case 'do': {
      let guard = 0;
      do {
        if (++guard > 10_000_000) break;
        try { await awkExec(node.body, rt); } catch (e) { if (e instanceof AwkBreak) break; if (!(e instanceof AwkContinue)) throw e; }
      } while (awkTruthy(await awkEval(node.c, rt), rt));
      return;
    }
    case 'for': {
      if (node.init) await awkEval(node.init, rt);
      let guard = 0;
      while (!node.cond || awkTruthy(await awkEval(node.cond, rt), rt)) {
        if (++guard > 10_000_000) break;
        try { await awkExec(node.body, rt); } catch (e) { if (e instanceof AwkBreak) break; if (!(e instanceof AwkContinue)) throw e; }
        if (node.inc) await awkEval(node.inc, rt);
      }
      return;
    }
    case 'forin': {
      const arr = rt.getArray(node.arr);
      for (const k of [...arr.keys()]) {
        rt.setVar(node.name, k);
        try { await awkExec(node.body, rt); } catch (e) { if (e instanceof AwkBreak) break; if (!(e instanceof AwkContinue)) throw e; }
      }
      return;
    }
    case 'break': throw new AwkBreak();
    case 'continue': throw new AwkContinue();
    case 'next': throw new AwkNext();
    case 'nextfile': throw new AwkNext(true);
    case 'exit': throw new AwkExit(node.e ? Math.trunc(awkToNum(await awkEval(node.e, rt))) : rt.exitCode);
    case 'return': throw new AwkReturn(node.e ? await awkEval(node.e, rt) : '');
    case 'delete': {
      const arr = rt.getArray(node.name);
      if (node.idx) {
        const key = [];
        for (const e of node.idx) key.push(awkToStr(await awkEval(e, rt)));
        arr.delete(key.join(rt.SUBSEP));
      } else arr.clear();
      return;
    }
    case 'print': case 'printf': {
      const vals = [];
      for (const a of node.args) vals.push(await awkEval(a, rt));
      let text;
      if (node.t === 'printf') text = awkFormat(vals.length ? awkToStr(vals[0]) : '', vals.slice(1));
      else text = (vals.length ? vals.map(awkToStr).join(rt.OFS) : rt.record) + rt.ORS;
      if (node.redir) {
        const target = awkToStr(await awkEval(node.redir.target, rt));
        try {
          c_vfsAppend(rt.c, target, text, node.redir.op === '>>');
        } catch { /* ignore write errors */ }
      } else rt.emit(text);
      return;
    }
    case 'expr': await awkEval(node.e, rt); return;
    default: return;
  }
}

function c_vfsAppend(c, file, text, append) {
  c.vfs.writeFile(ctxPath(c, file), textBytes(text), cred(c), { append });
}

function awkUnescape(s) {
  return s.replace(/\\([nrt\\abfv]|[0-7]{1,3})/g, (m, e) => {
    const map = { n: '\n', r: '\r', t: '\t', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v' };
    return e in map ? map[e] : String.fromCharCode(parseInt(e, 8));
  });
}

async function awkRun(c, argv) {
  let fs = null, program = null;
  const assignList = [], progFiles = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '-F') { fs = argv[++i] ?? ''; continue; }
    if (a.startsWith('-F')) { fs = a.slice(2); continue; }
    if (a === '-v') { assignList.push(argv[++i] ?? ''); continue; }
    if (a.startsWith('-v')) { assignList.push(a.slice(2)); continue; }
    if (a === '-f') { progFiles.push(argv[++i]); continue; }
    if (a.startsWith('-f')) { progFiles.push(a.slice(2)); continue; }
    if (a.length > 1 && a.startsWith('-')) continue;
    break;
  }
  const operands = argv.slice(i);
  if (progFiles.length) {
    const parts = [];
    for (const f of progFiles) {
      try { parts.push(readTextFile(c, f)); }
      catch (e) { return reportErr(c, `awk: can't open file ${f}: ${errnoText(e)}`, 2); }
    }
    program = parts.join('\n');
  } else {
    if (!operands.length) return reportErr(c, 'awk: no program given', 2);
    program = operands.shift();
  }
  let prog;
  try { prog = new AwkParser(awkTokenize(program)).parseProgram(); }
  catch (e) { return reportErr(c, `awk: ${e.message}`, 2); }
  const rt = awkMakeRt(c, prog);
  if (fs !== null) rt.FS = awkUnescape(fs);
  for (const a of assignList) {
    const eq = a.indexOf('=');
    if (eq > 0) rt.setVar(a.slice(0, eq), awkUnescape(a.slice(eq + 1)));
  }
  const sources = [];
  const cmdAssigns = [];
  for (const op of operands) {
    const m = op.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s);
    if (m) { cmdAssigns.push([m[1], awkUnescape(m[2])]); continue; }
    let text;
    try { text = await readTextOperand(c, op); }
    catch (e) { c.err(`awk: can't open file ${op}: ${errnoText(e)}\n`); continue; }
    sources.push({ name: op === '-' ? '-' : op, records: awkSplitRecords(text, rt.RS) });
  }
  if (!operands.length) {
    const text = await c.readText();
    sources.push({ name: '-', records: awkSplitRecords(text, rt.RS) });
  }
  rt.ARGC = sources.length + 1;
  rt.ARGV.set('0', 'awk');
  sources.forEach((s, idx) => rt.ARGV.set(String(idx + 1), s.name));
  let si = 0, ri = 0;
  rt.mainReader = () => {
    while (si < sources.length) {
      const src = sources[si];
      if (ri >= src.records.length) { si++; ri = 0; continue; }
      const rec = src.records[ri++];
      rt.NR++; rt.FNR = ri; rt.FILENAME = src.name;
      return { record: rec, file: src.name };
    }
    return null;
  };
  let code = 0;
  const runEnd = async () => {
    for (const blk of prog.end) {
      try { await awkExec(blk, rt); }
      catch (e) { if (e instanceof AwkExit) { code = e.code; } else throw e; }
    }
  };
  try {
    for (const [name, value] of cmdAssigns) rt.setVar(name, value);
    for (const blk of prog.begin) {
      try { await awkExec(blk, rt); }
      catch (e) { if (e instanceof AwkExit) { code = e.code; await runEnd(); c.out(rt.out.join('')); return code; } if (!(e instanceof AwkNext)) throw e; }
    }
    let next;
    while ((next = rt.mainReader()) !== null) {
      rt.setRecord(next.record);
      let jumped = false;
      for (const rule of prog.rules) {
        let ok = true;
        if (rule.pat) ok = awkTruthy(await awkEval(rule.pat, rt), rt);
        if (!ok) continue;
        try {
          if (rule.action) await awkExec(rule.action, rt);
          else rt.emit(rt.record + rt.ORS);
        } catch (e) {
          if (e instanceof AwkNext) { if (e.message === true || e === true) { /* nextfile */ } jumped = true; break; }
          throw e;
        }
      }
      if (jumped) continue;
    }
    await runEnd();
  } catch (e) {
    if (e instanceof AwkExit) { code = e.code; await runEnd(); }
    else return reportErr(c, `awk: ${e.message || e}`, 2);
  }
  c.out(rt.out.join(''));
  return code;
}

/* ============================== sort ============================== */

function parseSortArgs(args) {
  const o = { keys: [], t: null, n: false, r: false, u: false, f: false, b: false, h: false, V: false, M: false, s: false, c: false, C: false, z: false, o: null, files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.files.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq >= 0 ? a.slice(eq + 1) : undefined;
      if (name === 'key') o.keys.push(val ?? args[++i]);
      else if (name === 'field-separator') o.t = awkUnescape(val ?? args[++i]);
      else if (name === 'output') o.o = val ?? args[++i];
      else if (name === 'numeric-sort') o.n = true;
      else if (name === 'reverse') o.r = true;
      else if (name === 'unique') o.u = true;
      else if (name === 'ignore-case') o.f = true;
      else if (name === 'ignore-leading-blanks') o.b = true;
      else if (name === 'human-numeric-sort') o.h = true;
      else if (name === 'version-sort') o.V = true;
      else if (name === 'month-sort') o.M = true;
      else if (name === 'stable') o.s = true;
      else if (name === 'check') o.c = true;
      else if (name === 'check=quiet') { o.c = true; o.C = true; }
      else if (name === 'zero-terminated') o.z = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'k') { o.keys.push(a.slice(k + 1) || args[++i]); k = a.length; }
        else if (ch === 't') { o.t = awkUnescape(a.slice(k + 1) || args[++i] || '\t'); k = a.length; }
        else if (ch === 'o') { o.o = a.slice(k + 1) || args[++i]; k = a.length; }
        else if ('nrufhbVMsCciz'.includes(ch)) o[ch] = true;
        else if (ch === 'S') continue;
      }
      continue;
    }
    o.files.push(a);
  }
  return o;
}

function sortParseKeySpec(spec) {
  const parts = spec.split(',');
  const one = (s) => {
    if (!s) return null;
    const m = s.match(/^(\d+)(?:\.(\d+))?([nrufhbVMdgi]*)$/);
    if (!m) return null;
    return { field: Number(m[1]), char: m[2] ? Number(m[2]) : 1, opts: m[3] || '' };
  };
  const a = one(parts[0]);
  const b = parts[1] !== undefined ? one(parts[1]) : null;
  if (!a) return null;
  return { start: a, end: b, opts: (a.opts + (b?.opts || '')) };
}

function sortSplitFields(line, sep) {
  if (sep === null) {
    const fields = [];
    const re = /\S+/g;
    let m;
    while ((m = re.exec(line)) !== null) fields.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    return fields;
  }
  const fields = [];
  let start = 0, idx = 0;
  for (;;) {
    const pos = line.indexOf(sep, idx);
    if (pos < 0) { fields.push({ text: line.slice(start), start, end: line.length }); break; }
    fields.push({ text: line.slice(start, pos), start, end: pos });
    start = pos + sep.length; idx = pos + sep.length;
  }
  return fields;
}

function sortKeyText(line, key, sep) {
  if (!key) return line;
  const fields = sortSplitFields(line, sep);
  const f = fields[key.start.field - 1];
  if (!f) return '';
  let start = f.start;
  if (sep === null) start = f.start;
  else start = Math.min(f.end, f.start + key.start.char - 1);
  let end = f.end;
  if (key.end) {
    const ef = fields[key.end.field - 1];
    if (ef) {
      end = Math.min(ef.end, ef.start + key.end.char);
    }
  }
  return line.slice(start, Math.max(start, end));
}

function sortHumanNum(s) {
  const m = String(s).trim().match(/^([+-]?[\d.]+)\s*([KMGTPEZY]?)/i);
  if (!m) return 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6, Z: 1024 ** 7, Y: 1024 ** 8 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

function sortVersionCmp(a, b) {
  const ra = String(a).match(/\d+|\D+/g) || [];
  const rb = String(b).match(/\d+|\D+/g) || [];
  for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
    const x = ra[i] ?? '', y = rb[i] ?? '';
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) { const d = Number(x) - Number(y); if (d) return d < 0 ? -1 : 1; }
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function sortMonthNum(s) {
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const idx = months.indexOf(String(s).trim().slice(0, 3).toLowerCase());
  return idx < 0 ? 0 : idx + 1;
}

function sortTransition(line, key, opts, sep) {
  let text = sortKeyText(line, key, sep);
  const flags = key ? key.opts : '';
  if (opts.b || flags.includes('b')) text = text.replace(/^\s+/, '');
  if (opts.f || flags.includes('f') || flags.includes('d')) text = text.toLowerCase();
  if (opts.h || flags.includes('h')) return sortHumanNum(text);
  if (opts.V || flags.includes('V')) return text;
  if (opts.M || flags.includes('M')) return sortMonthNum(text);
  if (opts.n || flags.includes('n') || flags.includes('g')) {
    const m = text.trim().match(/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/);
    return m ? Number(m[0]) : 0;
  }
  return text;
}

function sortCompareLines(a, b, keys, opts) {
  for (const key of keys) {
    const ka = sortTransition(a, key, opts, opts.t);
    const kb = sortTransition(b, key, opts, opts.t);
    let r = 0;
    if (typeof ka === 'number' || typeof kb === 'number') {
      const x = Number(ka), y = Number(kb);
      r = x < y ? -1 : x > y ? 1 : 0;
    } else if (opts.V || key?.opts.includes('V')) r = sortVersionCmp(ka, kb);
    else r = ka < kb ? -1 : ka > kb ? 1 : 0;
    if (r) return opts.r ? -r : r;
  }
  if (!opts.s) { const r = a < b ? -1 : a > b ? 1 : 0; return opts.r ? -r : r; }
  return 0;
}

async function sortRun(c, argv) {
  const o = parseSortArgs(argv);
  const keys = o.keys.length ? o.keys.map(sortParseKeySpec).filter(Boolean) : [null];
  const readAll = async () => {
    const texts = await readAllFiles(c, o.files);
    const lines = [];
    for (const t of texts) {
      if (o.z) {
        const parts = t.text.split('\0');
        if (parts.length && parts[parts.length - 1] === '') parts.pop();
        lines.push(...parts);
      } else lines.push(...splitOutput(t.text).lines);
    }
    return lines;
  };
  const lines = await readAll();
  if (o.c || o.C) {
    for (let i = 1; i < lines.length; i++) {
      if (sortCompareLines(lines[i - 1], lines[i], keys, o) > 0) {
        if (!o.C) c.err(`sort: -:${i + 1}: disorder: ${lines[i]}\n`);
        return 1;
      }
    }
    return 0;
  }
  const sorted = lines.slice().sort((a, b) => sortCompareLines(a, b, keys, o));
  let out = sorted;
  if (o.u) {
    out = [];
    for (const line of sorted) {
      if (!out.length || sortCompareLines(out[out.length - 1], line, keys, o) !== 0) out.push(line);
    }
  }
  const sep = o.z ? '\0' : '\n';
  const result = out.length ? out.join(sep) + sep : '';
  if (o.o) {
    try { c.vfs.writeFile(ctxPath(c, o.o), textBytes(result), cred(c)); }
    catch (e) { return reportErr(c, `sort: ${o.o}: ${errnoText(e)}`, 2); }
  } else c.out(result);
  return 0;
}

/* ============================== uniq ============================== */

async function uniqRun(c, argv) {
  const o = parseOpts(argv, 'cdDui:f:s:w:z', {
    count: 'c', repeated: 'd', 'all-repeated': 'D', unique: 'u', 'ignore-case': 'i',
    skipFields: 'f', skipChars: 's', checkChars: 'w', 'zero-terminated': 'z',
  });
  let skipFields = Number(o.f || 0), skipChars = Number(o.s || 0), checkChars = o.w ? Number(o.w) : Infinity;
  const inputName = o._[0] || '-';
  const text = await readTextOperand(c, inputName);
  const lines = o.z ? text.split('\0').filter((x, idx, arr) => !(idx === arr.length - 1 && x === '')) : splitOutput(text).lines;
  const keyOf = (line) => {
    let s = line;
    if (skipFields) s = s.replace(new RegExp(`^\\s*(\\S+\\s+){0,${skipFields}}`), '');
    if (skipChars) s = s.slice(skipChars);
    if (checkChars !== Infinity) s = s.slice(0, checkChars);
    return o.i ? s.toLowerCase() : s;
  };
  const groups = [];
  for (const line of lines) {
    const k = keyOf(line);
    if (groups.length && groups[groups.length - 1].key === k) groups[groups.length - 1].lines.push(line);
    else groups.push({ key: k, lines: [line] });
  }
  const sep = o.z ? '\0' : '\n';
  let out = '';
  for (const g of groups) {
    if (o.d && g.lines.length < 2) continue;
    if (o.u && g.lines.length !== 1) continue;
    if (o.D) { if (g.lines.length > 1) for (const l of g.lines) out += l + sep; continue; }
    if (o.c) { out += String(g.lines.length).padStart(7) + ' ' + g.lines[0] + sep; continue; }
    out += g.lines[0] + sep;
  }
  c.out(out);
  return 0;
}

/* ============================== cut ============================== */

function cutParseRanges(list) {
  const out = [];
  for (const part of String(list).split(',')) {
    const m = part.trim().match(/^(\d*)-(\d*)$/);
    if (m) {
      const a = m[1] ? Number(m[1]) : 1;
      const b = m[2] ? Number(m[2]) : Infinity;
      out.push([a, b]);
    } else if (/^\d+$/.test(part.trim())) {
      const n = Number(part);
      out.push([n, n]);
    }
  }
  return out;
}

function cutSelect(items, ranges) {
  const res = [];
  for (const [a, b] of ranges) {
    const start = Math.max(1, a) - 1;
    const end = b === Infinity ? items.length : Math.min(items.length, b);
    if (start < end) res.push(...items.slice(start, end));
  }
  return res;
}

async function cutRun(c, argv) {
  let bytes = null, chars = null, fields = null, delim = '\t', onlyDelimited = false, complement = false;
  let outDelim = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--complement') { complement = true; continue; }
    if (a.startsWith('--output-delimiter=')) { outDelim = awkUnescape(a.slice(19)); continue; }
    if (a === '--output-delimiter') { outDelim = awkUnescape(argv[++i] ?? ''); continue; }
    if (a === '--only-delimited') { onlyDelimited = true; continue; }
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        const val = a.slice(k + 1) || argv[++i];
        if (ch === 'b') { bytes = cutParseRanges(val); k = a.length; }
        else if (ch === 'c') { chars = cutParseRanges(val); k = a.length; }
        else if (ch === 'f') { fields = cutParseRanges(val); k = a.length; }
        else if (ch === 'd') { delim = awkUnescape(a.slice(k + 1) || argv[++i] || '\t'); k = a.length; }
        else if (ch === 's') onlyDelimited = true;
        else if (ch === 'n') continue;
      }
      continue;
    }
    files.push(a);
  }
  const mode = bytes ? 'b' : chars ? 'c' : 'f';
  const ranges = bytes || chars || fields;
  if (!ranges) return reportErr(c, 'cut: you must specify a list of bytes, characters, or fields', 1);
  const inputs = await readAllFiles(c, files);
  const invert = (items, rgs) => {
    if (!complement) return cutSelect(items, rgs);
    const keep = new Set();
    for (const [a, b] of rgs) for (let n = a; n <= Math.min(b, items.length); n++) keep.add(n - 1);
    return items.filter((_, idx) => !keep.has(idx));
  };
  let out = '';
  for (const input of inputs) {
    const lines = splitOutput(input.text).lines;
    for (const line of lines) {
      if (mode === 'f') {
        if (!line.includes(delim)) {
          if (!onlyDelimited) out += line + '\n';
          continue;
        }
        const parts = line.split(delim);
        out += invert(parts, ranges).join(outDelim ?? delim) + '\n';
      } else if (mode === 'c') {
        const charsArr = [...line];
        out += invert(charsArr, ranges).join(outDelim ?? '') + '\n';
      } else {
        const b = textBytes(line);
        const sel = invert([...b], ranges);
        out += bytesText(new Uint8Array(sel)) + '\n';
      }
    }
  }
  c.out(out);
  return 0;
}

/* ============================== paste ============================== */

function pasteDelims(list) {
  if (list === undefined) return ['\t'];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (ch === '\\') {
      const n = list[i + 1];
      if (n === undefined) { out.push('\\'); continue; }
      if (n === 't') out.push('\t');
      else if (n === 'n') out.push('\n');
      else if (n === '0') out.push('');
      else out.push(n);
      i++;
      continue;
    }
    out.push(ch);
  }
  return out.length ? out : ['\t'];
}

async function pasteRun(c, argv) {
  let delims = ['\t'], serial = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--serial')) { serial = true; continue; }
    if (a.startsWith('--delimiters=')) { delims = pasteDelims(a.slice(13)); continue; }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 's') serial = true;
        else if (ch === 'd') { delims = pasteDelims(a.slice(k + 1) || argv[++i] || ''); k = a.length; }
      }
      continue;
    }
    files.push(a);
  }
  if (!files.length) files.push('-');
  const texts = [];
  const stdinCount = files.filter((f) => f === '-').length;
  let stdinLines = null;
  let stdinOp = 0;
  for (const f of files) {
    if (f === '-') {
      if (stdinLines === null) stdinLines = splitOutput(await c.readText()).lines;
      const stride = stdinOp++;
      texts.push(stdinLines.filter((_, idx) => idx % stdinCount === stride));
      continue;
    }
    try { texts.push(splitOutput(await readTextOperand(c, f)).lines); }
    catch (e) { c.err(`paste: ${f}: ${errnoText(e)}\n`); texts.push([]); }
  }
  let out = '';
  if (serial) {
    for (const lines of texts) {
      if (!lines.length) { out += '\n'; continue; }
      let s = '';
      for (let i = 0; i < lines.length; i++) { if (i) s += delims[(i - 1) % delims.length]; s += lines[i]; }
      out += s + '\n';
    }
  } else {
    const max = texts.reduce((m, t) => Math.max(m, t.length), 0);
    for (let i = 0; i < max; i++) {
      let s = '', first = true;
      for (const lines of texts) {
        if (!first) s += delims[(texts.indexOf(lines) - 1) % delims.length];
        s += lines[i] ?? '';
        first = false;
      }
      out += s + '\n';
    }
  }
  c.out(out);
  return 0;
}

/* ============================== join ============================== */

function joinParseArgs(args) {
  const o = { f1: 1, f2: 1, t: null, a: [], v: [], e: '', o: null, i: false, files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.files.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq >= 0 ? a.slice(eq + 1) : undefined;
      if (name === 'ignore-case') o.i = true;
      else if (name === 'header') continue;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === '1') { o.f1 = Number(a.slice(k + 1) || args[++i]); k = a.length; }
        else if (ch === '2') { o.f2 = Number(a.slice(k + 1) || args[++i]); k = a.length; }
        else if (ch === 't') { o.t = awkUnescape(a.slice(k + 1) || args[++i] || '\t'); k = a.length; }
        else if (ch === 'a') { o.a.push(Number(a.slice(k + 1) || args[++i])); k = a.length; }
        else if (ch === 'v') { o.v.push(Number(a.slice(k + 1) || args[++i])); k = a.length; }
        else if (ch === 'e') { o.e = awkUnescape(a.slice(k + 1) || args[++i] || ''); k = a.length; }
        else if (ch === 'o') { o.o = a.slice(k + 1) || args[++i]; k = a.length; }
        else if (ch === 'i') o.i = true;
      }
      continue;
    }
    o.files.push(a);
  }
  return o;
}

function joinFields(line, opts) {
  if (opts.t !== null) return line.split(opts.t);
  return line.trim().split(/\s+/).filter((s) => s !== '');
}

function joinKey(fields, n, icase) {
  const v = fields[n - 1] ?? '';
  return icase ? v.toLowerCase() : v;
}

function joinReadLines(c, name, opts) {
  try {
    const text = name === '-' ? null : readTextFile(c, name);
    return text === null ? [] : splitOutput(text).lines.map((l) => ({ line: l, fields: joinFields(l, opts) }));
  } catch (e) { c.err(`join: ${name}: ${errnoText(e)}\n`); return null; }
}

async function joinRun(c, argv) {
  const o = joinParseArgs(argv);
  const files = o.files.slice();
  let text1, text2;
  try {
    if (files.length >= 1) text1 = files[0] === '-' ? await c.readText() : readTextFile(c, files[0]);
    else text1 = await c.readText();
    if (files.length >= 2) text2 = files[1] === '-' ? await c.readText() : readTextFile(c, files[1]);
    else text2 = await c.readText();
  } catch (e) { return reportErr(c, `join: ${errnoText(e)}`, 2); }
  const src1 = splitOutput(text1).lines.map((l) => ({ line: l, fields: joinFields(l, o) }));
  const src2 = splitOutput(text2).lines.map((l) => ({ line: l, fields: joinFields(l, o) }));
  const out = [];
  const fmt = (f1, f2, key) => {
    if (o.o) {
      const specs = o.o.split(',').map((s) => s.trim());
      const parts = [];
      for (const s of specs) {
        if (s === '0') parts.push(key);
        else if (s === '1.0' || s === '2.0') parts.push(key);
        else {
          const m = s.match(/^([12])\.(\d+)$/);
          if (!m) continue;
          const src = m[1] === '1' ? f1 : f2;
          if (!src) parts.push(o.e);
          else parts.push(src.fields[Number(m[2]) - 1] ?? o.e);
        }
      }
      return parts.join(o.t ?? ' ');
    }
    const outFields = [];
    if (f1 && f2) {
      outFields.push(f1.fields[o.f1 - 1] ?? key);
      const rest = [...f1.fields.slice(0, o.f1 - 1), ...f1.fields.slice(o.f1)];
      outFields.push(...rest);
      outFields.push(...f2.fields.slice(0, o.f2 - 1), ...f2.fields.slice(o.f2));
    } else if (f1) {
      outFields.push(...f1.fields);
    } else if (f2) {
      outFields.push(...f2.fields);
    }
    return outFields.join(o.t ?? ' ');
  };
  let i = 0, j = 0, unmatched = false;
  while (i < src1.length || j < src2.length) {
    const k1 = i < src1.length ? joinKey(src1[i].fields, o.f1, o.i) : null;
    const k2 = j < src2.length ? joinKey(src2[j].fields, o.f2, o.i) : null;
    if (k1 !== null && k2 !== null && k1 === k2) {
      const g1 = [], g2 = [];
      while (i < src1.length && joinKey(src1[i].fields, o.f1, o.i) === k1) g1.push(src1[i++]);
      while (j < src2.length && joinKey(src2[j].fields, o.f2, o.i) === k2) g2.push(src2[j++]);
      for (const a of g1) for (const b of g2) out.push(fmt(a, b, k1));
    } else if (k1 !== null && (k2 === null || k1 < k2)) {
      if (o.a.includes(1) || o.v.includes(1)) out.push(fmt(src1[i], null, k1));
      else unmatched = true;
      i++;
    } else if (k2 !== null) {
      if (o.a.includes(2) || o.v.includes(2)) out.push(fmt(null, src2[j], k2));
      else unmatched = true;
      j++;
    } else break;
  }
  c.out(out.length ? out.join('\n') + '\n' : '');
  return unmatched ? 1 : 0;
}

/* ============================== comm ============================== */

async function commRun(c, argv) {
  const o = parseOpts(argv, '123', {});
  if (o._.length < 2) return reportErr(c, 'comm: missing operand', 2);
  let t1, t2;
  try { t1 = readTextFile(c, o._[0]); t2 = readTextFile(c, o._[1]); }
  catch (e) { return reportErr(c, `comm: ${errnoText(e)}`, 2); }
  const a = splitOutput(t1).lines, b = splitOutput(t2).lines;
  const cols = [];
  if (!o[1]) cols.push(0);
  if (!o[2]) cols.push(1);
  if (!o[3]) cols.push(2);
  const out = [];
  const emit = (only1, only2, both) => {
    const parts = [];
    if (!o[1]) parts.push(only1);
    if (!o[2]) parts.push(only2);
    if (!o[3]) parts.push(both);
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    out.push(parts.join('\t'));
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i >= a.length) emit('', b[j], ''), j++;
    else if (j >= b.length) emit(a[i], '', ''), i++;
    else if (a[i] === b[j]) emit('', '', a[i]), i++, j++;
    else if (a[i] < b[j]) emit(a[i], '', ''), i++;
    else emit('', b[j], ''), j++;
  }
  c.out(out.length ? out.join('\n') + '\n' : '');
  return 0;
}

/* ============================== tr ============================== */

function trChar(spec, i) {
  const ch = spec[i];
  if (ch !== '\\') return { ch, next: i + 1 };
  const n = spec[i + 1];
  if (n === undefined) return { ch: '\\', next: i + 1 };
  const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', a: '\x07', b: '\b', f: '\f', v: '\v', '0': '\0' };
  if (n in esc) return { ch: esc[n], next: i + 2 };
  if (/[0-7]/.test(n)) {
    let oct = '';
    let j = i + 1;
    while (j < spec.length && oct.length < 3 && /[0-7]/.test(spec[j])) oct += spec[j++];
    return { ch: String.fromCharCode(parseInt(oct, 8)), next: j };
  }
  return { ch: n, next: i + 2 };
}

function trClassChars(name) {
  const out = [];
  const add = (a, b) => { for (let c = a; c <= b; c++) out.push(String.fromCharCode(c)); };
  switch (name) {
    case 'alpha': add(65, 90); add(97, 122); break;
    case 'digit': add(48, 57); break;
    case 'alnum': add(48, 57); add(65, 90); add(97, 122); break;
    case 'upper': add(65, 90); break;
    case 'lower': add(97, 122); break;
    case 'space': out.push(' ', '\t', '\n', '\r', '\f', '\v'); break;
    case 'blank': out.push(' ', '\t'); break;
    case 'punct': for (let c = 33; c < 127; c++) if (!/[A-Za-z0-9]/.test(String.fromCharCode(c))) out.push(String.fromCharCode(c)); break;
    case 'print': add(32, 126); break;
    case 'graph': add(33, 126); break;
    case 'cntrl': add(0, 31); out.push('\x7f'); break;
    case 'xdigit': add(48, 57); add(65, 70); add(97, 102); break;
    default: break;
  }
  return out;
}

function trExpandSet(spec) {
  const out = [];
  for (let i = 0; i < spec.length;) {
    if (spec[i] === '[' && spec[i + 1] === ':') {
      const m = spec.slice(i).match(/^\[:(\w+):\]/);
      if (m) { out.push(...trClassChars(m[1])); i += m[0].length; continue; }
    }
    const a = trChar(spec, i);
    if (spec[a.next] === '-' && a.next + 1 < spec.length) {
      const b = trChar(spec, a.next + 1);
      const ac = a.ch.charCodeAt(0), bc = b.ch.charCodeAt(0);
      if (ac <= bc) for (let c = ac; c <= bc; c++) out.push(String.fromCharCode(c));
      else out.push(a.ch, '-', b.ch);
      i = b.next;
      continue;
    }
    out.push(a.ch);
    i = a.next;
  }
  return out;
}

async function trRun(c, argv) {
  let del = false, squeeze = false, complement = false;
  const sets = [];
  let endOpts = false;
  for (const a of argv) {
    if (endOpts) { sets.push(a); continue; }
    if (a === '--') { endOpts = true; continue; }
    if (a.startsWith('--')) {
      if (a === '--complement') complement = true;
      else if (a === '--delete') del = true;
      else if (a === '--squeeze-repeats') squeeze = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1 && sets.length === 0) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'c' || a[k] === 'C') complement = true;
        else if (a[k] === 'd') del = true;
        else if (a[k] === 's') squeeze = true;
      }
      continue;
    }
    sets.push(a);
  }
  if (!sets.length) return reportErr(c, 'tr: missing operand', 1);
  const set1 = trExpandSet(sets[0]);
  const set2 = sets[1] !== undefined ? trExpandSet(sets[1]) : null;
  if (!del && set2 === null && !squeeze) return reportErr(c, 'tr: missing operand after set1', 1);
  const inSet1 = new Set(set1);
  const map = new Map();
  if (set2 && !del) {
    if (!complement) {
      for (let i = 0; i < set1.length; i++) map.set(set1[i], set2[Math.min(i, set2.length - 1)] ?? set1[i]);
    } else {
      const comp = [];
      for (let code = 1; code < 256; code++) {
        const ch = String.fromCharCode(code);
        if (!inSet1.has(ch)) comp.push(ch);
      }
      for (let i = 0; i < comp.length; i++) map.set(comp[i], set2[Math.min(i, set2.length - 1)]);
    }
  }
  const squeezeSet = new Set(squeeze ? (set2 && !del ? set2 : set1) : []);
  const text = await c.readText();
  let out = '';
  let prev = null;
  for (const ch of text) {
    if (del) {
      const remove = complement ? !inSet1.has(ch) : inSet1.has(ch);
      if (remove) continue;
    } else if (map.size) {
      if (map.has(ch)) { out += map.get(ch); prev = ch; continue; }
    }
    if (squeeze && squeezeSet.has(ch) && ch === prev) continue;
    out += ch;
    prev = ch;
  }
  c.out(out);
  return 0;
}

/* ============================== fold ============================== */

async function foldRun(c, argv) {
  const o = parseOpts(argv, 'w:sb', { width: 'w:' });
  const width = Number(o.w || 80) || 80;
  if (width <= 0) return reportErr(c, 'fold: invalid number of columns', 1);
  const inputs = await readAllFiles(c, o._);
  let out = '';
  for (const input of inputs) {
    const { lines, trailing } = splitOutput(input.text);
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      let rest = line;
      while (rest.length > 0) {
        const units = o.b ? [...textBytes(rest)] : [...rest];
        if (units.length <= width) { out += rest + '\n'; rest = ''; break; }
        let cut = width;
        if (o.s) {
          const spaceIdx = [...rest].lastIndexOf(' ', width - 1);
          if (spaceIdx >= 0) cut = spaceIdx + 1;
        }
        out += [...rest].slice(0, cut).join('') + '\n';
        rest = [...rest].slice(cut).join('');
      }
      if (line.length === 0) out += '\n';
      if (li === lines.length - 1 && !trailing) { /* newline is always emitted by fold */ }
    }
  }
  c.out(out);
  return 0;
}

/* ============================== fmt ============================== */

function fmtWrap(text, width) {
  const words = text.split(/\s+/).filter((w) => w !== '');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur === '') cur = w;
    else if (cur.length + 1 + w.length <= width) cur += ' ' + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur !== '' || !lines.length) lines.push(cur);
  return lines;
}

async function fmtRun(c, argv) {
  const o = parseOpts(argv, 'w:sup:', { width: 'w:', prefix: 'p:' });
  const width = Number(o.w || 75) || 75;
  const inputs = await readAllFiles(c, o._);
  let out = '';
  for (const input of inputs) {
    const lines = splitOutput(input.text).lines;
    if (o.s) {
      for (const line of lines) {
        if (!line.trim()) { out += '\n'; continue; }
        out += fmtWrap(line.trim(), width).join('\n') + '\n';
      }
      continue;
    }
    let para = [];
    const flush = () => {
      if (!para.length) return;
      out += fmtWrap(para.join(' '), width).join('\n') + '\n';
      para = [];
    };
    for (const line of lines) {
      if (!line.trim()) { flush(); out += '\n'; continue; }
      para.push(line.trim());
    }
    flush();
  }
  c.out(out);
  return 0;
}

/* ============================== expand / unexpand ============================== */

function tabStops(list) {
  if (!list) return [8];
  const stops = String(list).split(/[,\s]+/).filter((s) => s !== '').map(Number).filter((n) => n > 0);
  return stops.length ? stops : [8];
}

function nextTab(col, stops) {
  if (stops.length === 1) return (Math.floor(col / stops[0]) + 1) * stops[0];
  for (const s of stops) if (s > col) return s;
  const last = stops[stops.length - 1];
  const prev = stops.length > 1 ? stops[stops.length - 2] : last;
  const step = Math.max(1, last - prev);
  let c = last;
  while (c <= col) c += step;
  return c;
}

async function expandRun(c, argv) {
  const o = parseOpts(argv, 't:i', { tabs: 't:', initial: 'i' });
  const stops = tabStops(o.t);
  const inputs = await readAllFiles(c, o._);
  let out = '';
  for (const input of inputs) {
    const lines = splitOutput(input.text).lines;
    for (const line of lines) {
      let col = 0, res = '', initial = true;
      for (const ch of line) {
        if (ch === '\t') {
          if (o.i && !initial) { res += '\t'; continue; }
          const next = nextTab(col, stops);
          res += ' '.repeat(next - col);
          col = next;
        } else {
          res += ch;
          if (ch !== ' ') initial = false;
          col++;
        }
      }
      out += res + '\n';
    }
  }
  c.out(out);
  return 0;
}

async function unexpandRun(c, argv) {
  const o = parseOpts(argv, 't:a', { tabs: 't:', all: 'a' });
  const stops = tabStops(o.t);
  const inputs = await readAllFiles(c, o._);
  let out = '';
  for (const input of inputs) {
    const lines = splitOutput(input.text).lines;
    for (const line of lines) {
      let col = 0, res = '', pending = 0, leading = true;
      const flushSpaces = (force) => {
        while (pending > 0) {
          const next = nextTab(col, stops);
          const need = next - col;
          if (pending >= need) { res += '\t'; col = next; pending -= need; }
          else { res += ' '.repeat(pending); col += pending; pending = 0; }
          if (!force) break;
        }
      };
      for (const ch of line) {
        if (ch === ' ') {
          if (!o.a && !leading) { res += ch; col++; continue; }
          pending++;
          continue;
        }
        if (ch === '\t') {
          if (pending) flushSpaces(true);
          res += '\t';
          col = nextTab(col, stops);
          leading = false;
          continue;
        }
        if (pending) { flushSpaces(true); pending = 0; }
        res += ch;
        col++;
        leading = false;
      }
      if (pending) flushSpaces(true);
      out += res + '\n';
    }
  }
  c.out(out);
  return 0;
}

/* ============================== od / hexdump ============================== */

function odEscapeByte(b) {
  const ch = String.fromCharCode(b);
  if (b === 0) return '\\0';
  if (ch === '\n') return '\\n';
  if (ch === '\t') return '\\t';
  if (ch === '\r') return '\\r';
  if (b >= 32 && b < 127) return ch;
  return '\\' + b.toString(8).padStart(3, '0');
}

function odReadInput(c, argv) {
  const files = argv;
  if (!files.length) return null;
  const chunks = [];
  for (const f of files) {
    if (f === '-') { chunks.push(null); continue; }
    try { chunks.push(c.vfs.readFile(ctxPath(c, f), cred(c))); }
    catch (e) { c.err(`${c.name}: ${f}: ${errnoText(e)}\n`); }
  }
  return chunks;
}

async function odRun(c, argv) {
  const types = [];
  let addrBase = 'o', limit = Infinity, skip = 0, verbose = false, width = 16;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-A') { const v = argv[++i]; addrBase = v === 'n' ? 'n' : v || 'o'; continue; }
    if (a.startsWith('-A') && a.length > 2) { addrBase = a[2]; continue; }
    if (a === '-t') { types.push(...String(argv[++i] || 'o2').split(',')); continue; }
    if (a.startsWith('-t') && a.length > 2) { types.push(...a.slice(2).split(',')); continue; }
    if (a === '-N') { limit = Number(argv[++i]) || 0; continue; }
    if (a.startsWith('-N')) { limit = Number(a.slice(2)) || 0; continue; }
    if (a === '-j') { skip = Number(argv[++i]) || 0; continue; }
    if (a.startsWith('-j')) { skip = Number(a.slice(2)) || 0; continue; }
    if (a === '-v') { verbose = true; continue; }
    if (a === '-w') { width = Number(argv[++i]) || 16; continue; }
    if (a === '-c') { types.push('c'); continue; }
    if (a === '-x') { types.push('x2'); continue; }
    if (a === '-b') { types.push('o1'); continue; }
    if (a === '-o') { types.push('o2'); continue; }
    if (a === '-d') { types.push('d2'); continue; }
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  if (!types.length) types.push('o2');
  let bytes;
  if (!files.length || (files.length === 1 && files[0] === '-')) bytes = await c.readBytes();
  else {
    const chunks = [];
    for (const f of files) {
      try { chunks.push(c.vfs.readFile(ctxPath(c, f), cred(c))); }
      catch (e) { return reportErr(c, `od: ${f}: ${errnoText(e)}`, 1); }
    }
    bytes = concatBytes(chunks);
  }
  if (skip) bytes = bytes.slice(skip);
  if (limit !== Infinity) bytes = bytes.slice(0, limit);
  const parsed = types.map((t) => {
    const m = String(t).match(/^([a-z])(\d*)$/);
    if (!m) return { kind: 'x', size: 1 };
    return { kind: m[1], size: m[2] ? Number(m[2]) : (m[1] === 'c' ? 1 : 2) };
  });
  const fmtOff = (n) => {
    if (addrBase === 'n') return '';
    if (addrBase === 'x') return n.toString(16).padStart(7, '0');
    if (addrBase === 'd') return String(n).padStart(7, ' ');
    return n.toString(8).padStart(7, '0');
  };
  let out = '', prevHex = null;
  for (let off = 0; off < bytes.length; off += width) {
    const chunk = bytes.slice(off, off + width);
    const hex = [...chunk].join(',');
    if (!verbose && hex === prevHex) {
      if (!out.endsWith('*\n')) out += '*\n';
      continue;
    }
    prevHex = hex;
    for (const ty of parsed) {
      let line = fmtOff(off + skip) + ' ';
      if (ty.kind === 'c') {
        for (const b of chunk) line += odEscapeByte(b).padStart(4, ' ');
      } else {
        for (let p = 0; p < chunk.length; p += ty.size) {
          let v = 0;
          for (let k = 0; k < ty.size && p + k < chunk.length; k++) v += chunk[p + k] * 2 ** (8 * k);
          let s;
          if (ty.kind === 'x') s = v.toString(16).padStart(ty.size * 2, '0');
          else if (ty.kind === 'o') s = v.toString(8).padStart(Math.ceil(ty.size * 8 / 3), '0');
          else if (ty.kind === 'u') s = String(v >>> 0).padStart(ty.size === 1 ? 3 : ty.size === 2 ? 5 : ty.size === 4 ? 10 : 20, ' ');
          else s = String(v).padStart(ty.size === 1 ? 4 : ty.size === 2 ? 6 : ty.size === 4 ? 11 : 20, ' ');
          line += s + ' ';
        }
      }
      out += line.replace(/\s+$/, '') + '\n';
    }
  }
  if (addrBase !== 'n') out += fmtOff(bytes.length + skip) + '\n';
  c.out(out);
  return 0;
}

async function hexdumpRun(c, argv) {
  let mode = 'C', limit = Infinity, skip = 0, verbose = false;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C') { mode = 'C'; continue; }
    if (a === '-c') { mode = 'c'; continue; }
    if (a === '-x') { mode = 'x'; continue; }
    if (a === '-b') { mode = 'b'; continue; }
    if (a === '-o') { mode = 'o'; continue; }
    if (a === '-d') { mode = 'd'; continue; }
    if (a === '-v') { verbose = true; continue; }
    if (a === '-n') { limit = Number(argv[++i]) || 0; continue; }
    if (a.startsWith('-n')) { limit = Number(a.slice(2)) || 0; continue; }
    if (a === '-s') { skip = Number(argv[++i]) || 0; continue; }
    if (a.startsWith('-s')) { skip = Number(a.slice(2)) || 0; continue; }
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-')) continue;
    files.push(a);
  }
  let bytes;
  if (!files.length) bytes = await c.readBytes();
  else {
    const chunks = [];
    for (const f of files) {
      try { chunks.push(f === '-' ? await c.readBytes() : c.vfs.readFile(ctxPath(c, f), cred(c))); }
      catch (e) { return reportErr(c, `hexdump: ${f}: ${errnoText(e)}`, 1); }
    }
    bytes = concatBytes(chunks);
  }
  if (skip) bytes = bytes.slice(skip);
  if (limit !== Infinity) bytes = bytes.slice(0, limit);
  let out = '', prevHex = null;
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    const hex = [...chunk].join(',');
    if (!verbose && hex === prevHex) { if (!out.endsWith('*\n')) out += '*\n'; continue; }
    prevHex = hex;
    if (mode === 'C') {
      let hexPart = '';
      for (let i = 0; i < 16; i++) {
        hexPart += i < chunk.length ? chunk[i].toString(16).padStart(2, '0') + ' ' : '   ';
        if (i === 7) hexPart += ' ';
      }
      const ascii = [...chunk].map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
      out += off.toString(16).padStart(8, '0') + '  ' + hexPart + ' |' + ascii + '|\n';
    } else if (mode === 'c') {
      let s = off.toString(16).padStart(7, '0') + ' ';
      for (const b of chunk) s += odEscapeByte(b).padStart(4, ' ');
      out += s.replace(/\s+$/, '') + '\n';
    } else if (mode === 'b') {
      let s = off.toString(16).padStart(7, '0') + ' ';
      for (const b of chunk) s += b.toString(8).padStart(3, '0') + ' ';
      out += s.replace(/\s+$/, '') + '\n';
    } else {
      const size = 2;
      let s = off.toString(16).padStart(7, '0') + ' ';
      for (let p = 0; p < chunk.length; p += size) {
        let v = chunk[p];
        if (p + 1 < chunk.length) v += chunk[p + 1] * 256;
        if (mode === 'x') s += v.toString(16).padStart(4, '0') + ' ';
        else if (mode === 'o') s += v.toString(8).padStart(6, '0') + ' ';
        else s += String(v).padStart(5, ' ') + ' ';
      }
      out += s.replace(/\s+$/, '') + '\n';
    }
  }
  out += bytes.length.toString(16).padStart(7, '0') + '\n';
  c.out(out);
  return 0;
}

/* ============================== split / csplit ============================== */

function splitSuffix(n, len, numeric) {
  if (numeric) return String(n).padStart(len, '0');
  let s = '';
  let v = n;
  for (let i = 0; i < len; i++) { s = String.fromCharCode(97 + (v % 26)) + s; v = Math.floor(v / 26); }
  return s;
}

function splitSize(str) {
  const m = String(str).match(/^(\d+)([KMG]?)$/i);
  if (!m) return Number(str) || 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

function splitLineChunks(text) {
  const chunks = text.match(/[^\n]*\n|[^\n]+$/g);
  return chunks || [];
}

async function splitRun(c, argv) {
  let lines = 1000, bytesMode = 0, chunksN = 0, numeric = false, suffixLen = 2, additional = '';
  const operands = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--additional-suffix=')) { additional = a.slice(20); continue; }
    if (a === '--numeric-suffixes') { numeric = true; continue; }
    if (a === '--suffix-length') { suffixLen = Number(argv[++i]) || 2; continue; }
    if (a.startsWith('--suffix-length=')) { suffixLen = Number(a.slice(16)) || 2; continue; }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'l') { lines = Number(a.slice(k + 1) || argv[++i]) || 1000; k = a.length; }
        else if (ch === 'b') { bytesMode = splitSize(a.slice(k + 1) || argv[++i]); k = a.length; }
        else if (ch === 'n') { const v = a.slice(k + 1) || argv[++i]; const lm = String(v).match(/^l\/(\d+)$/); if (lm) chunksN = -Number(lm[1]); else chunksN = Number(v) || 0; k = a.length; }
        else if (ch === 'a') { suffixLen = Number(a.slice(k + 1) || argv[++i]) || 2; k = a.length; }
        else if (ch === 'd') numeric = true;
        else if (ch === 'e') continue;
      }
      continue;
    }
    operands.push(a);
  }
  const prefix = operands.length >= 2 ? operands[1] : 'x';
  const input = operands[0] ?? '-';
  let bytes;
  if (input === '-') bytes = await c.readBytes();
  else {
    try { bytes = c.vfs.readFile(ctxPath(c, input), cred(c)); }
    catch (e) { return reportErr(c, `split: ${input}: ${errnoText(e)}`, 1); }
  }
  const writeChunk = (idx, chunk) => {
    const name = prefix + splitSuffix(idx, suffixLen, numeric) + additional;
    try { c.vfs.writeFile(ctxPath(c, name), chunk, cred(c)); }
    catch (e) { c.err(`split: ${name}: ${errnoText(e)}\n`); }
  };
  if (chunksN) {
    if (chunksN < 0) {
      const text = bytesText(bytes);
      const all = splitLineChunks(text);
      const per = Math.ceil(all.length / -chunksN) || 1;
      for (let i = 0, idx = 0; i < all.length; i += per, idx++) writeChunk(idx, textBytes(all.slice(i, i + per).join('')));
      return 0;
    }
    if (!bytes.length) return 0;
    const size = Math.ceil(bytes.length / chunksN) || 1;
    for (let i = 0, idx = 0; i < bytes.length; i += size, idx++) writeChunk(idx, bytes.slice(i, i + size));
    return 0;
  }
  if (bytesMode) {
    for (let i = 0, idx = 0; i < bytes.length; i += bytesMode, idx++) writeChunk(idx, bytes.slice(i, i + bytesMode));
    return 0;
  }
  const all = splitLineChunks(bytesText(bytes));
  for (let i = 0, idx = 0; i < all.length; i += lines, idx++) writeChunk(idx, textBytes(all.slice(i, i + lines).join('')));
  return 0;
}

function csprintf(fmt, n) {
  return String(fmt).replace(/%0?(\d*)d/, (m, w) => String(n).padStart(w ? Number(w) : 0, '0'))
    .replace(/%d/g, String(n)).replace(/%%/g, '%');
}

async function csplitRun(c, argv) {
  let prefix = 'xx', format = null, digits = 2, quiet = false, keep = false;
  const operands = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) continue;
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'f') { prefix = a.slice(k + 1) || argv[++i] || 'xx'; k = a.length; }
        else if (ch === 'b') { format = a.slice(k + 1) || argv[++i] || '%02d'; k = a.length; }
        else if (ch === 'n') { digits = Number(a.slice(k + 1) || argv[++i]) || 2; k = a.length; }
        else if (ch === 's' || ch === 'q') quiet = true;
        else if (ch === 'k') keep = true;
      }
      continue;
    }
    operands.push(a);
  }
  if (!operands.length) return reportErr(c, 'csplit: missing operand', 1);
  const input = operands.shift();
  const text = input === '-' ? await c.readText() : readInputFile(c, input);
  if (text === null) return 1;
  const lines = splitOutput(text).lines;
  const patterns = [];
  for (const raw of operands) {
    const m = raw.match(/^(.*?)\{(\d+|\*)\}$/);
    const p = m ? m[1] : raw;
    const reps = m ? (m[2] === '*' ? Infinity : Number(m[2])) : 1;
    patterns.push({ p, reps });
  }
  const created = [];
  let cur = 0, fileIdx = 0, failed = null;
  const fileName = (n) => (format ? prefix + csprintf(format, n) : prefix + String(n).padStart(digits, '0'));
  const writePiece = (to) => {
    const name = fileName(fileIdx++);
    created.push(name);
    const chunk = lines.slice(cur, to).map((l) => l + '\n').join('');
    try { c.vfs.writeFile(ctxPath(c, name), textBytes(chunk), cred(c)); }
    catch (e) { c.err(`csplit: ${name}: ${errnoText(e)}\n`); }
    if (!quiet) c.out(String(textBytes(chunk).length) + '\n');
    cur = to;
  };
  const findRegex = (raw, from, offset) => {
    let re = raw;
    let ig = '';
    if (raw.startsWith('/') || raw.startsWith('%')) {
      const delim = raw[0];
      const end = raw.lastIndexOf(delim);
      if (end <= 0) return -1;
      re = raw.slice(1, end);
      ig = raw.slice(end + 1).trim();
    }
    let off = offset;
    if (ig) { const om = ig.match(/^([+-]\d+)$/); if (om) off = Number(om[1]); }
    const rx = makeRegex(re, { extended: true });
    for (let i = from; i < lines.length; i++) if (rx.test(lines[i])) return i + off;
    return -1;
  };
  outer: for (const { p, reps } of patterns) {
    for (let r = 0; r < reps; r++) {
      if (p.startsWith('/') || p.startsWith('%')) {
        const skipOnly = p.startsWith('%');
        const boundary = findRegex(p, cur, 0);
        if (boundary < 0 || boundary < cur) { failed = p; break outer; }
        if (skipOnly) cur = Math.min(boundary, lines.length);
        else writePiece(boundary);
      } else if (/^\d+$/.test(p)) {
        const boundary = Number(p) - 1;
        if (boundary < cur) { failed = p; break outer; }
        writePiece(Math.min(boundary, lines.length));
      }
    }
  }
  if (failed !== null) {
    c.err(`csplit: '${failed}': match not found\n`);
    if (!keep) { for (const f of created) { try { c.vfs.unlink(ctxPath(c, f), cred(c)); } catch { /* ignore */ } } }
    return 1;
  }
  writePiece(lines.length);
  return 0;
}

/* ============================== tee ============================== */

async function teeRun(c, argv) {
  let append = false;
  const files = [];
  for (const a of argv) {
    if (a === '--') continue;
    if (a === '--append') { append = true; continue; }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        if (a[k] === 'a') append = true;
        else if (a[k] === 'i') continue;
        else if (a[k] === 'p') continue;
      }
      continue;
    }
    files.push(a);
  }
  const bytes = await c.readBytes();
  let code = 0;
  for (const f of files) {
    try { c.vfs.writeFile(ctxPath(c, f), bytes, cred(c), { append }); }
    catch (e) { c.err(`tee: ${f}: ${errnoText(e)}\n`); code = 1; }
  }
  c.stdout.write(bytes);
  return code;
}

/* ============================== diff ============================== */

function diffLcs(aKeys, bKeys) {
  const n = aKeys.length, m = bKeys.length;
  if (n * m > 25_000_000) {
    const ops = [];
    const min = Math.min(n, m);
    let i = 0;
    for (; i < min; i++) {
      if (aKeys[i] === bKeys[i]) ops.push({ type: 'eq', ai: i, bi: i });
      else { ops.push({ type: 'del', ai: i, bi: i }); ops.push({ type: 'ins', ai: i, bi: i }); }
    }
    for (let k = i; k < n; k++) ops.push({ type: 'del', ai: k, bi: k });
    for (let k = i; k < m; k++) ops.push({ type: 'ins', ai: k, bi: k });
    return ops;
  }
  const W = m + 1;
  const dp = new Uint32Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = aKeys[i] === bKeys[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aKeys[i] === bKeys[j]) { ops.push({ type: 'eq', ai: i, bi: j }); i++; j++; }
    else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { ops.push({ type: 'del', ai: i, bi: j }); i++; }
    else { ops.push({ type: 'ins', ai: i, bi: j }); j++; }
  }
  while (i < n) ops.push({ type: 'del', ai: i++, bi: j });
  while (j < m) ops.push({ type: 'ins', ai: i, bi: j++ });
  return ops;
}

function diffRange(start, count) {
  if (count <= 0) return String(start);
  if (count === 1) return String(start + 1);
  return `${start + 1},${start + count}`;
}

function diffNormalOps(aLines, bLines, ops, out) {
  let k = 0;
  while (k < ops.length) {
    if (ops[k].type === 'eq') { k++; continue; }
    const dels = [], ins = [];
    const aPos = ops[k].ai, bPos = ops[k].bi;
    while (k < ops.length && ops[k].type !== 'eq') {
      if (ops[k].type === 'del') dels.push(aLines[ops[k].ai]);
      else ins.push(bLines[ops[k].bi]);
      k++;
    }
    if (dels.length && ins.length) {
      out.push(`${diffRange(aPos, dels.length)}c${diffRange(bPos, ins.length)}`);
      for (const l of dels) out.push('< ' + l);
      out.push('---');
      for (const l of ins) out.push('> ' + l);
    } else if (dels.length) {
      out.push(`${diffRange(aPos, dels.length)}d${bPos}`);
      for (const l of dels) out.push('< ' + l);
    } else {
      out.push(`${aPos}a${diffRange(bPos, ins.length)}`);
      for (const l of ins) out.push('> ' + l);
    }
  }
}

function diffHunks(ops, context) {
  const changes = [];
  ops.forEach((op, idx) => { if (op.type !== 'eq') changes.push(idx); });
  const groups = [];
  for (const idx of changes) {
    if (!groups.length) { groups.push({ start: idx, end: idx }); continue; }
    const g = groups[groups.length - 1];
    if (idx - g.end <= context * 2 + 1) g.end = idx;
    else groups.push({ start: idx, end: idx });
  }
  return groups.map((g) => {
    const start = Math.max(0, g.start - context);
    const end = Math.min(ops.length, g.end + context + 1);
    return { start, end };
  });
}

function diffUnified(aLines, bLines, aName, bName, ops, context) {
  const out = [`--- ${aName}`, `+++ ${bName}`];
  for (const h of diffHunks(ops, context)) {
    const slice = ops.slice(h.start, h.end);
    let aCount = 0, bCount = 0, aStart = -1, bStart = -1;
    for (const op of slice) {
      if (op.type === 'eq' || op.type === 'del') { if (aStart < 0) aStart = op.ai; aCount++; }
      if (op.type === 'eq' || op.type === 'ins') { if (bStart < 0) bStart = op.bi; bCount++; }
    }
    if (aStart < 0) aStart = aLines.length;
    if (bStart < 0) bStart = bLines.length;
    const as = aCount === 0 ? `${aStart},0` : `${aStart + 1}${aCount === 1 ? '' : ',' + aCount}`;
    const bs = bCount === 0 ? `${bStart},0` : `${bStart + 1}${bCount === 1 ? '' : ',' + bCount}`;
    out.push(`@@ -${as} +${bs} @@`);
    for (const op of slice) {
      if (op.type === 'eq') out.push(' ' + aLines[op.ai]);
      else if (op.type === 'del') out.push('-' + aLines[op.ai]);
      else out.push('+' + bLines[op.bi]);
    }
  }
  return out;
}

function diffContextFormat(aLines, bLines, aName, bName, ops, context) {
  const out = [`*** ${aName}`, `--- ${bName}`];
  for (const h of diffHunks(ops, context)) {
    out.push('***************');
    const slice = ops.slice(h.start, h.end);
    let aFirst = -1, aLast = -1, bFirst = -1, bLast = -1;
    for (const op of slice) {
      if (op.type === 'eq' || op.type === 'del') { if (aFirst < 0) aFirst = op.ai; aLast = op.ai; }
      if (op.type === 'eq' || op.type === 'ins') { if (bFirst < 0) bFirst = op.bi; bLast = op.bi; }
    }
    out.push(`*** ${aFirst + 1},${aLast + 1} ****`);
    for (const op of slice) {
      if (op.type === 'eq') out.push('  ' + aLines[op.ai]);
      else if (op.type === 'del') out.push('- ' + aLines[op.ai]);
    }
    out.push(`--- ${bFirst + 1},${bLast + 1} ----`);
    for (const op of slice) {
      if (op.type === 'eq') out.push('  ' + bLines[op.bi]);
      else if (op.type === 'ins') out.push('+ ' + bLines[op.bi]);
    }
  }
  return out;
}

function diffParseArgs(args) {
  const o = { u: false, c: false, q: false, i: false, w: false, b: false, B: false, r: false, N: false, context: 3, files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.files.push(...args.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      if (a === '--unified') o.u = true;
      else if (a.startsWith('--unified=')) { o.u = true; o.context = Number(a.slice(10)) || 3; }
      else if (a === '--context') o.c = true;
      else if (a === '--brief') o.q = true;
      else if (a === '--ignore-case') o.i = true;
      else if (a === '--ignore-all-space') o.w = true;
      else if (a === '--ignore-space-change') o.b = true;
      else if (a === '--ignore-blank-lines') o.B = true;
      else if (a === '--recursive') o.r = true;
      else if (a === '--new-file') o.N = true;
      else if (a === '--text') continue;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'u') o.u = true;
        else if (ch === 'c') o.c = true;
        else if (ch === 'q') o.q = true;
        else if (ch === 'i') o.i = true;
        else if (ch === 'w') o.w = true;
        else if (ch === 'b') o.b = true;
        else if (ch === 'B') o.B = true;
        else if (ch === 'r') o.r = true;
        else if (ch === 'N') o.N = true;
        else if (ch === 'U' || ch === 'C') { o.context = Number(a.slice(k + 1) || args[++i]) || 3; if (ch === 'C') o.c = true; else o.u = true; k = a.length; }
        else if (ch === 'a') continue;
      }
      continue;
    }
    o.files.push(a);
  }
  return o;
}

function diffNormalizeLine(line, o) {
  let s = line;
  if (o.w) s = s.replace(/\s+/g, '');
  else if (o.b) s = s.replace(/\s+/g, ' ').trim();
  if (o.i) s = s.toLowerCase();
  return s;
}

async function diffFiles(c, name1, name2, o, out) {
  let text1, text2;
  try { text1 = readTextFile(c, name1); }
  catch (e) { c.err(`diff: ${name1}: ${errnoText(e)}\n`); return 2; }
  try { text2 = readTextFile(c, name2); }
  catch (e) { c.err(`diff: ${name2}: ${errnoText(e)}\n`); return 2; }
  const aLines = splitOutput(text1).lines;
  const bLines = splitOutput(text2).lines;
  let aIdx = aLines.map((_, i) => i), bIdx = bLines.map((_, i) => i);
  let a = aLines, b = bLines;
  if (o.B) {
    aIdx = []; bIdx = [];
    a = [];
    b = [];
    aLines.forEach((l, i) => { if (l.trim()) { a.push(l); aIdx.push(i); } });
    bLines.forEach((l, i) => { if (l.trim()) { b.push(l); bIdx.push(i); } });
  }
  const aKeys = a.map((l) => diffNormalizeLine(l, o));
  const bKeys = b.map((l) => diffNormalizeLine(l, o));
  const ops = diffLcs(aKeys, bKeys);
  const changed = ops.some((op) => op.type !== 'eq');
  if (!changed) return 0;
  if (o.q) { out.push(`Files ${name1} and ${name2} differ`); return 1; }
  if (o.u) out.push(...diffUnified(a, b, name1, name2, ops, o.context));
  else if (o.c) out.push(...diffContextFormat(a, b, name1, name2, ops, o.context));
  else diffNormalOps(a, b, ops, out);
  return 1;
}

async function diffRun(c, argv) {
  const o = diffParseArgs(argv);
  if (o.files.length < 2) return reportErr(c, 'diff: missing operand', 2);
  const out = [];
  let status = 0;
  const walk = async (p1, p2, shown1, shown2) => {
    const st1 = tryStat(c, p1, { follow: true });
    const st2 = tryStat(c, p2, { follow: true });
    if (st1 && st1.isDirectory() && st2 && st2.isDirectory()) {
      let e1 = [], e2 = [];
      try { e1 = [...c.vfs.readdirNodes(ctxPath(c, p1), cred(c))].map((x) => x[0]).filter((n) => n !== '.' && n !== '..'); } catch { /* ignore */ }
      try { e2 = [...c.vfs.readdirNodes(ctxPath(c, p2), cred(c))].map((x) => x[0]).filter((n) => n !== '.' && n !== '..'); } catch { /* ignore */ }
      const names = [...new Set([...e1, ...e2])].sort();
      for (const nm of names) {
        const c1 = joinPath(p1, nm), c2 = joinPath(p2, nm);
        const in1 = e1.includes(nm), in2 = e2.includes(nm);
        if (in1 && in2) await walk(c1, c2, joinPath(shown1, nm), joinPath(shown2, nm));
        else if (o.N) {
          const present = in1 ? c1 : c2;
          const st = tryStat(c, present, { follow: true });
          if (st && st.isDirectory()) { if (o.r) await walk(present, present, shown1, shown2); continue; }
          const r = await diffFiles(c, in1 ? c1 : '/dev/null', in2 ? c2 : '/dev/null', o, out);
          if (r === 2) { c.err(`diff: ${in1 ? c1 : c2}: No such file or directory\n`); status = 2; }
          else if (r === 1) { if (!o.q) out.unshift(`diff ${in1 ? c1 : c2} ${in2 ? c2 : c1}`); status = 1; }
        } else {
          out.push(`Only in ${in1 ? shown1 : shown2}: ${nm}`);
          status = status || 1;
        }
      }
      return;
    }
    if (!st1 || !st2) {
      if (o.N && (st1 || st2)) {
        const r = await diffFiles(c, st1 ? p1 : '/dev/null', st2 ? p2 : '/dev/null', o, out);
        if (r === 1) { if (!o.q) out.unshift(`diff ${st1 ? p1 : '/dev/null'} ${st2 ? p2 : '/dev/null'}`); status = status || 1; }
        else if (r === 2) status = 2;
        return;
      }
      if (!st1) c.err(`diff: ${shown1}: ${errnoText({ code: 'ENOENT' })}\n`);
      if (!st2) c.err(`diff: ${shown2}: ${errnoText({ code: 'ENOENT' })}\n`);
      status = 2;
      return;
    }
    if (st1.isDirectory() || st2.isDirectory()) { c.err(`diff: cannot compare a file with a directory\n`); status = 2; return; }
    const r = await diffFiles(c, p1, p2, o, out);
    if (r === 2) status = 2;
    else if (r === 1) status = status || 1;
  };
  await walk(o.files[0], o.files[1], o.files[0], o.files[1]);
  c.out(out.length ? out.join('\n') + '\n' : '');
  return status;
}

/* ============================== cmp ============================== */

async function cmpRun(c, argv) {
  let silent = false, listAll = false, showBytes = false, skip1 = 0, skip2 = 0, limit = Infinity;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      if (a === '--silent' || a === '--quiet') silent = true;
      else if (a === '--verbose') listAll = true;
      else if (a === '--print-bytes') showBytes = true;
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 's') silent = true;
        else if (ch === 'l') listAll = true;
        else if (ch === 'b') showBytes = true;
        else if (ch === 'i') {
          const v = a.slice(k + 1) || argv[++i] || '0';
          const parts = String(v).split(':');
          skip1 = Number(parts[0]) || 0;
          skip2 = Number(parts[1] ?? parts[0]) || 0;
          k = a.length;
        } else if (ch === 'n') { limit = Number(a.slice(k + 1) || argv[++i]) || 0; k = a.length; }
      }
      continue;
    }
    files.push(a);
  }
  if (files.length < 2) return reportErr(c, 'cmp: missing operand', 2);
  let b1, b2;
  try {
    b1 = files[0] === '-' ? await c.readBytes() : c.vfs.readFile(ctxPath(c, files[0]), cred(c));
    b2 = files[1] === '-' ? await c.readBytes() : c.vfs.readFile(ctxPath(c, files[1]), cred(c));
  } catch (e) { return reportErr(c, `cmp: ${errnoText(e)}`, 2); }
  b1 = b1.slice(skip1); b2 = b2.slice(skip2);
  const n = Math.min(b1.length, b2.length, limit);
  let diffs = [];
  for (let i = 0; i < n; i++) if (b1[i] !== b2[i]) diffs.push(i);
  const lenDiff = b1.length !== b2.length && Math.min(b1.length, b2.length) < limit;
  if (!diffs.length && !lenDiff) return 0;
  if (silent) return 1;
  if (listAll) {
    for (const i of diffs) {
      c.out(`${i + 1 + skip1} ${b1[i].toString(8)} ${b2[i].toString(8)}\n`);
    }
    if (lenDiff) c.err(`cmp: EOF on ${b1.length < b2.length ? files[0] : files[1]} after byte ${n + skip1}\n`);
    return 1;
  }
  if (diffs.length) {
    const i = diffs[0];
    let line = 1;
    for (let k = 0; k < i; k++) if (b1[k] === 10) line++;
    let msg = `${files[0]} ${files[1]} differ: byte ${i + 1 + skip1}, line ${line}`;
    if (showBytes) msg += ` is ${b1[i].toString(8)} ${String.fromCharCode(b1[i])} ${b2[i].toString(8)} ${String.fromCharCode(b2[i])}`;
    c.out(msg + '\n');
    return 1;
  }
  c.out(`cmp: EOF on ${b1.length < b2.length ? files[0] : files[1]} after byte ${n + skip1}\n`);
  return 1;
}

/* ============================== find ============================== */

const FIND_NOARG = new Set(['print', 'print0', 'prune', 'empty', 'nouser', 'nogroup', 'delete', 'quit', 'depth', 'follow', 'true', 'false']);
const FIND_ONEARG = new Set(['maxdepth', 'mindepth', 'name', 'iname', 'path', 'ipath', 'regex', 'iregex', 'type', 'size', 'mtime', 'mmin', 'atime', 'ctime', 'amin', 'cmin', 'newer', 'perm', 'user', 'group', 'links', 'samefile', 'printf', 'fstype']);

function findParse(tokens) {
  let i = 0;
  const peek = () => tokens[i];
  const primary = () => {
    const t = peek();
    if (t === undefined) throw new Error('find: expected expression');
    if (t === '(') { i++; const e = parseOr(); if (peek() !== ')') throw new Error("find: missing ')'"); i++; return e; }
    if (t === '!') { i++; return { t: 'not', e: primary() }; }
    if (!t.startsWith('-')) throw new Error(`find: paths must precede expression: '${t}'`);
    const name = t.slice(1);
    i++;
    if (name === 'not') return { t: 'not', e: primary() };
    if (name === 'a' || name === 'and') return primary();
    if (name === 'o' || name === 'or') return { t: 'true' };
    if (name === 'exec' || name === 'execdir' || name === 'ok') {
      const args = [];
      while (i < tokens.length && tokens[i] !== ';' && tokens[i] !== '+') args.push(tokens[i++]);
      const term = tokens[i++];
      return { t: 'test', name: 'exec', args, mode: term === '+' ? '+' : ';' };
    }
    if (FIND_NOARG.has(name)) return { t: 'test', name, args: [] };
    if (FIND_ONEARG.has(name)) {
      if (i >= tokens.length) throw new Error(`find: missing argument to '-${name}'`);
      return { t: 'test', name, args: [tokens[i++]] };
    }
    if (i < tokens.length && !tokens[i].startsWith('-') && tokens[i] !== '(' && tokens[i] !== '!' && tokens[i] !== ')') {
      return { t: 'test', name, args: [tokens[i++]] };
    }
    return { t: 'test', name, args: [] };
  };
  const parseAnd = () => {
    let l = primary();
    for (;;) {
      const t = peek();
      if (t === undefined || t === ')' || t === '-o' || t === '-or' || t === ',') break;
      if (t === '-a' || t === '-and') i++;
      l = { t: 'and', l, r: primary() };
    }
    return l;
  };
  const parseOr = () => {
    let l = parseAnd();
    while (peek() === '-o' || peek() === '-or' || peek() === ',') { i++; l = { t: 'or', l, r: parseAnd() }; }
    return l;
  };
  return parseOr();
}

function findCollectOpts(node, opts) {
  if (!node) return;
  if (node.t === 'and' || node.t === 'or') { findCollectOpts(node.l, opts); findCollectOpts(node.r, opts); return; }
  if (node.t === 'not') { findCollectOpts(node.e, opts); return; }
  if (node.t !== 'test') return;
  const a = node.args[0];
  switch (node.name) {
    case 'maxdepth': opts.maxdepth = Number(a); break;
    case 'mindepth': opts.mindepth = Number(a); break;
    case 'depth': opts.depth = true; break;
    case 'delete': opts.depth = true; opts.delete = true; break;
    case 'follow': opts.follow = true; break;
    default: break;
  }
}

function findNumCmp(actual, spec) {
  const m = String(spec).match(/^([+-]?)(\d+)$/);
  if (!m) return false;
  const n = Number(m[2]);
  if (m[1] === '+') return actual > n;
  if (m[1] === '-') return actual < n;
  return actual === n;
}

function findSize(stat, spec) {
  const m = String(spec).match(/^([+-]?)(\d+)([cwbkMG]?)$/);
  if (!m) return false;
  const unit = { c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[3]] || 1;
  const actual = unit === 1 ? stat.size : Math.ceil(stat.size / unit);
  return findNumCmp(actual, m[1] + m[2]);
}

function findTypeChar(stat) {
  if (stat.isDirectory()) return 'd';
  if (stat.isFile()) return 'f';
  if (stat.isSymbolicLink()) return 'l';
  if (stat.isBlockDevice()) return 'b';
  if (stat.isCharacterDevice()) return 'c';
  if (stat.isFIFO()) return 'p';
  if (stat.isSocket()) return 's';
  return '?';
}

function findRelative(root, p) {
  if (p === root) return '.';
  const prefix = root === '/' ? '/' : root.replace(/\/+$/, '') + '/';
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}

function findPrintfFmt(fmt, st) {
  const stat = st.stat;
  const t = new Date(stat.mtimeMs);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const ctime = `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()]} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][t.getUTCMonth()]} ${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:${pad(t.getUTCSeconds())} 1970`;
  const map = {
    p: st.display, f: baseName(st.display), s: String(stat.size), m: (stat.mode & 0o7777).toString(8),
    u: String(st.uidName ?? stat.uid), g: String(st.gidName ?? stat.gid), t: ctime,
    y: findTypeChar(stat), d: String(st.depth), h: dirName(st.display), P: findRelative(st.rootDisplay, st.display),
    '%': '%',
  };
  let out = '';
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '\\') {
      const n = fmt[i + 1];
      const esc = { n: '\n', t: '\t', r: '\r', '\\': '\\', '0': '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };
      if (n in esc) { out += esc[n]; i++; continue; }
      out += n ?? ''; i++; continue;
    }
    if (ch === '%') {
      const n = fmt[i + 1];
      if (n in map) { out += map[n]; i++; continue; }
      out += '%'; continue;
    }
    out += ch;
  }
  return out;
}

async function findEval(node, st, g) {
  if (!node) return true;
  if (node.t === 'and') return (await findEval(node.l, st, g)) && (await findEval(node.r, st, g));
  if (node.t === 'or') return (await findEval(node.l, st, g)) || (await findEval(node.r, st, g));
  if (node.t === 'not') return !(await findEval(node.e, st, g));
  const { c } = g;
  const stat = st.stat;
  const name = node.name;
  const arg = node.args[0];
  switch (name) {
    case 'print': c.out(st.display + '\n'); return true;
    case 'print0': c.out(st.display + '\0'); return true;
    case 'printf': c.out(findPrintfFmt(arg, st)); return true;
    case 'prune': if (stat.isDirectory()) st.prune = true; return true;
    case 'empty': {
      if (stat.isDirectory()) { try { return c.vfs.readdirNodes(ctxPath(c, st.display), cred(c)).size === 0; } catch { return false; } }
      return stat.size === 0;
    }
    case 'nouser': return g.c.kernel.userByUid(stat.uid) === null;
    case 'nogroup': return g.c.kernel.groupByGid(stat.gid) === null;
    case 'delete': {
      try {
        if (stat.isDirectory()) c.vfs.rmdir(ctxPath(c, st.display), cred(c));
        else c.vfs.unlink(ctxPath(c, st.display), cred(c));
        return true;
      } catch (e) { c.err(`find: ${st.display}: ${errnoText(e)}\n`); g.error = true; return false; }
    }
    case 'quit': g.quit = true; return true;
    case 'true': return true;
    case 'false': return false;
    case 'maxdepth': case 'mindepth': case 'depth': case 'follow': return true;
    case 'name': case 'iname': {
      let re = globToRegExp(arg);
      if (name === 'iname') re = new RegExp(re.source, 'i');
      return re.test(baseName(st.display));
    }
    case 'path': case 'ipath': {
      let re = globToRegExp(arg, { pathMode: true });
      if (name === 'ipath') re = new RegExp(re.source, 'i');
      return re.test(st.display);
    }
    case 'regex': case 'iregex': {
      let re = makeRegex(arg, { extended: true });
      if (name === 'iregex') re = new RegExp(re.source, 'i');
      return re.test(st.display);
    }
    case 'type': {
      const types = String(arg).replace(/,/g, '');
      return types.includes(findTypeChar(stat));
    }
    case 'size': return findSize(stat, arg);
    case 'mtime': case 'atime': case 'ctime': {
      const ms = name === 'mtime' ? stat.mtimeMs : name === 'atime' ? stat.atimeMs : stat.ctimeMs;
      const days = Math.floor((Date.now() - ms) / 86400000);
      return findNumCmp(days, arg);
    }
    case 'mmin': case 'amin': case 'cmin': {
      const ms = name === 'mmin' ? stat.mtimeMs : name === 'amin' ? stat.atimeMs : stat.ctimeMs;
      const mins = Math.floor((Date.now() - ms) / 60000);
      return findNumCmp(mins, arg);
    }
    case 'newer': {
      try { const ref = statOf(c, arg, { follow: true }); return stat.mtimeMs > ref.mtimeMs; }
      catch (e) { g.error = true; return false; }
    }
    case 'samefile': {
      try { const ref = statOf(c, arg, { follow: true }); return stat.ino === ref.ino && stat.dev === ref.dev; }
      catch { return false; }
    }
    case 'perm': {
      let spec = String(arg), kind = 'exact';
      if (spec.startsWith('-')) { kind = 'all'; spec = spec.slice(1); }
      else if (spec.startsWith('/')) { kind = 'any'; spec = spec.slice(1); }
      const modeNum = parseInt(spec, 8);
      if (Number.isNaN(modeNum)) return false;
      const m = stat.mode & 0o7777;
      if (kind === 'all') return (m & modeNum) === modeNum;
      if (kind === 'any') return (m & modeNum) !== 0;
      return m === modeNum;
    }
    case 'user': {
      const u = /^\d+$/.test(String(arg)) ? c.kernel.userByUid(Number(arg)) : c.kernel.userByName(String(arg));
      return u ? stat.uid === u.uid : false;
    }
    case 'group': {
      const gr = /^\d+$/.test(String(arg)) ? c.kernel.groupByGid(Number(arg)) : c.kernel.groupByName(String(arg));
      return gr ? stat.gid === gr.gid : false;
    }
    case 'links': return findNumCmp(stat.nlink, arg);
    case 'fstype': return false;
    case 'exec': {
      if (node.mode === '+') {
        let list = g.batches.get(node);
        if (!list) { list = []; g.batches.set(node, list); }
        list.push(st.display);
        return true;
      }
      const parts = node.args.map((a) => quoteShell(a.replace(/\{\}/g, st.display)));
      const res = await c.spawn(parts.join(' ')).done;
      return res.code === 0;
    }
    default: return true;
  }
}

async function findWalk(display, depth, g) {
  if (g.quit) return;
  const opts = g.opts;
  let stat;
  try { stat = statOf(g.c, display, { follow: opts.follow }); }
  catch (e) {
    g.c.err(`find: '${display}': ${errnoText(e)}\n`);
    g.error = true;
    return;
  }
  const st = {
    display, stat, depth, rootDisplay: g.rootDisplay,
    uidName: g.c.kernel.userByUid(stat.uid)?.name, gidName: g.c.kernel.groupByGid(stat.gid)?.name,
    prune: false,
  };
  const isDir = stat.isDirectory();
  const descend = async () => {
    if (!isDir || depth >= opts.maxdepth || g.quit) return;
    const key = `${stat.dev}:${stat.ino}`;
    if (opts.follow) { if (g.visited.has(key)) return; g.visited.add(key); }
    let entries;
    try { entries = [...g.c.vfs.readdirNodes(ctxPath(g.c, display), cred(g.c))]; }
    catch (e) { g.c.err(`find: '${display}': ${errnoText(e)}\n`); g.error = true; return; }
    for (const [nm] of entries) {
      if (nm === '.' || nm === '..') continue;
      const childDisplay = display.endsWith('/') ? display + nm : display + '/' + nm;
      await findWalk(childDisplay, depth + 1, g);
      if (g.quit) break;
    }
  };
  if (opts.depth) {
    await descend();
    if (g.quit) return;
    if (depth >= opts.mindepth) await findEval(g.expr, st, g);
  } else {
    if (depth >= opts.mindepth) {
      await findEval(g.expr, st, g);
      if (st.prune) { st.prune = false; return; }
    }
    await descend();
  }
}

async function findRun(c, argv) {
  const paths = [];
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '(' || a === '!' || a.startsWith('-')) break;
    paths.push(a);
  }
  if (!paths.length) paths.push('.');
  const tokens = argv.slice(i);
  let expr;
  try {
    expr = tokens.length ? findParse(tokens) : { t: 'test', name: 'print', args: [] };
  } catch (e) { return reportErr(c, e.message, 1); }
  const opts = { maxdepth: Infinity, mindepth: 0, depth: false, follow: false, delete: false };
  findCollectOpts(expr, opts);
  const hasPrint = (() => {
    const scan = (n) => (!n ? false : n.t === 'and' || n.t === 'or' ? scan(n.l) || scan(n.r) : n.t === 'not' ? scan(n.e) : n.t === 'test' ? ['print', 'print0', 'printf', 'exec', 'delete'].includes(n.name) : false);
    return scan(expr);
  })();
  if (!hasPrint) expr = { t: 'and', l: expr, r: { t: 'test', name: 'print', args: [] } };
  const g = {
    c, opts, expr, quit: false, error: false, visited: new Set(), batches: new Map(),
    rootDisplay: paths[0],
  };
  for (const p of paths) {
    g.rootDisplay = p;
    if (opts.follow) g.visited.clear();
    await findWalk(p, 0, g);
    if (g.quit) break;
  }
  for (const [node, list] of g.batches) {
    if (!list.length) continue;
    const parts = [];
    let replaced = false;
    for (const a of node.args) {
      if (a === '{}') { for (const p of list) parts.push(quoteShell(p)); replaced = true; }
      else if (a.includes('{}')) { parts.push(quoteShell(a.replace(/\{\}/g, list[0]))); replaced = true; }
      else parts.push(quoteShell(a));
    }
    if (!replaced) for (const p of list) parts.push(quoteShell(p));
    const res = await c.spawn(parts.join(' ')).done;
    if (res.code !== 0) g.error = true;
  }
  return g.error ? 1 : 0;
}

/* ============================== xargs ============================== */

async function xargsRun(c, argv) {
  let nul = false, maxArgs = 0, maxLines = 0, replace = null, delim = null, noRun = false, trace = false, eofStr = null;
  let inputFile = null;
  const cmdArgs = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { cmdArgs.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq >= 0 ? a.slice(2, eq) : a.slice(2);
      const val = eq >= 0 ? a.slice(eq + 1) : undefined;
      if (name === 'null') nul = true;
      else if (name === 'max-args') { maxArgs = Number(val ?? argv[++i]) || 0; }
      else if (name === 'max-lines') { maxLines = Number(val ?? argv[++i]) || 0; }
      else if (name === 'replace') replace = val ?? (argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '{}');
      else if (name === 'delimiter') delim = awkUnescape(val ?? argv[++i] ?? '\n');
      else if (name === 'no-run-if-empty') noRun = true;
      else if (name === 'verbose') trace = true;
      else if (name === 'eof') eofStr = val ?? argv[++i];
      else if (name === 'arg-file') inputFile = val ?? argv[++i];
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === '0') nul = true;
        else if (ch === 'r') noRun = true;
        else if (ch === 't' || ch === 'p') trace = true;
        else if (ch === 'n') { maxArgs = Number(a.slice(k + 1) || argv[++i]) || 0; k = a.length; }
        else if (ch === 'L') { maxLines = Number(a.slice(k + 1) || argv[++i]) || 0; k = a.length; }
        else if (ch === 'I') { replace = a.slice(k + 1) || argv[++i] || '{}'; k = a.length; }
        else if (ch === 'd') { delim = awkUnescape(a.slice(k + 1) || argv[++i] || '\n'); k = a.length; }
        else if (ch === 'E') { eofStr = a.slice(k + 1) || argv[++i]; k = a.length; }
        else if (ch === 'e') { if (a.length > k + 1) { eofStr = a.slice(k + 1); k = a.length; } }
        else if (ch === 'a') { inputFile = a.slice(k + 1) || argv[++i]; k = a.length; }
      }
      continue;
    }
    cmdArgs.push(a);
  }
  if (!cmdArgs.length) cmdArgs.push('echo');
  let text;
  if (inputFile) {
    try { text = readTextFile(c, inputFile); }
    catch (e) { return reportErr(c, `xargs: ${inputFile}: ${errnoText(e)}`, 1); }
  } else text = await c.readText();
  let items = [];
  let lineBatches = null;
  if (nul) {
    items = text.split('\0');
    if (items.length && items[items.length - 1] === '') items.pop();
  } else if (delim !== null) {
    items = text.split(delim);
    if (items.length && items[items.length - 1] === '') items.pop();
  } else if (maxLines) {
    const lines = splitOutput(text).lines;
    lineBatches = [];
    for (let i = 0; i < lines.length; i += maxLines) {
      lineBatches.push(splitWords(lines.slice(i, i + maxLines).join(' ')));
    }
    items = lineBatches.flat();
  } else {
    items = splitWords(text);
  }
  if (eofStr) {
    const idx = items.indexOf(eofStr);
    if (idx >= 0) items = items.slice(0, idx);
  }
  if (!items.length && noRun) return 0;
  const runOne = async (batch) => {
    let command;
    if (replace !== null) {
      const single = batch[0];
      const parts = cmdArgs.map((a) => quoteShell(a.split(replace).join(single)));
      command = parts.join(' ');
    } else {
      const parts = [...cmdArgs, ...batch].map(quoteShell);
      command = parts.join(' ');
    }
    if (trace) c.err(command + '\n');
    const res = await c.spawn(command).done;
    if (res.stdout) c.out(res.stdout);
    if (res.stderr) c.err(res.stderr);
    return res.code;
  };
  const batches = [];
  if (replace !== null) {
    for (const it of items) batches.push([it]);
  } else if (lineBatches) {
    batches.push(...lineBatches);
  } else {
    const size = maxArgs || Math.max(1, items.length);
    for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  }
  if (!batches.length && !noRun) batches.push([]);
  let worst = 0;
  for (const b of batches) {
    const code = await runOne(b);
    if (code === 127) worst = 127;
    else if (code === 255) { if (worst !== 127) worst = 124; }
    else if (code !== 0 && worst !== 127 && worst !== 124) worst = 123;
  }
  return worst;
}

/* ============================== which ============================== */

async function whichRun(c, argv) {
  let all = false;
  const names = [];
  for (const a of argv) {
    if (a === '--all') { all = true; continue; }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) if (a[k] === 'a') all = true;
      continue;
    }
    names.push(a);
  }
  const pathVar = c.env.PATH ?? '/bin:/usr/bin';
  const dirs = String(pathVar).split(':').map((d) => (d === '' ? '.' : d));
  let code = 0, printed = 0;
  for (const name of names) {
    const found = [];
    if (name.includes('/')) {
      const st = tryStat(c, name, { follow: true });
      if (st && !st.isDirectory() && (st.mode & 0o111)) found.push(name);
    } else {
      for (const d of dirs) {
        const p = d === '.' ? name : joinPath(d, name);
        const st = tryStat(c, p, { follow: true });
        if (st && !st.isDirectory() && (st.mode & 0o111)) {
          found.push(p);
          if (!all) break;
        }
      }
    }
    if (!found.length) { code = 1; continue; }
    for (const p of found) { c.out(p + '\n'); printed++; }
  }
  return code;
}

/* ============================== column ============================== */

async function columnRun(c, argv) {
  let table = false, sep = null, outSep = '  ';
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--table')) { table = true; continue; }
    if (a === '-t') { table = true; continue; }
    if (a === '-x') { table = true; continue; }
    if (a.startsWith('-')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 't') table = true;
        else if (ch === 's') { sep = awkUnescape(a.slice(k + 1) || argv[++i] || '\t'); k = a.length; }
        else if (ch === 'o') { outSep = awkUnescape(a.slice(k + 1) || argv[++i] || '  '); k = a.length; }
        else if (ch === 'c') { argv[++i]; k = a.length; }
      }
      continue;
    }
    files.push(a);
  }
  const inputs = await readAllFiles(c, files);
  let out = '';
  for (const input of inputs) {
    const lines = splitOutput(input.text).lines;
    if (!table) { out += lines.map((l) => l + '\n').join(''); continue; }
    const rows = lines.map((line) => {
      if (sep === null) return line.trim().split(/\s+/).filter((s) => s !== '');
      return line.split(sep);
    });
    const widths = [];
    for (const row of rows) {
      row.forEach((cell, idx) => { widths[idx] = Math.max(widths[idx] || 0, cell.length); });
    }
    for (const row of rows) {
      if (!row.length) { out += '\n'; continue; }
      let s = '';
      for (let i = 0; i < row.length; i++) {
        if (i) s += outSep;
        s += i === row.length - 1 ? row[i] : row[i].padEnd(widths[i]);
      }
      out += s.replace(/\s+$/, '') + '\n';
    }
  }
  c.out(out);
  return 0;
}

/* ============================== strings ============================== */

async function stringsRun(c, argv) {
  let minLen = 4, offsetMode = null;
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a === '-a' || a === '--all') continue;
    if (a.startsWith('-')) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'n') { minLen = Number(a.slice(k + 1) || argv[++i]) || 4; k = a.length; }
        else if (ch === 't') {
          const v = a.slice(k + 1) || argv[++i] || 'd';
          offsetMode = v[0];
          k = a.length;
        }
      }
      continue;
    }
    files.push(a);
  }
  if (!files.length) files.push('-');
  let out = '';
  const printable = (b) => b === 9 || (b >= 32 && b < 127);
  for (const f of files) {
    let bytes;
    if (f === '-') bytes = await c.readBytes();
    else {
      try { bytes = c.vfs.readFile(ctxPath(c, f), cred(c)); }
      catch (e) { c.err(`strings: ${f}: ${errnoText(e)}\n`); continue; }
    }
    let start = -1;
    for (let i = 0; i <= bytes.length; i++) {
      const ok = i < bytes.length && printable(bytes[i]);
      if (ok && start < 0) start = i;
      if (!ok && start >= 0) {
        if (i - start >= minLen) {
          let prefix = '';
          if (offsetMode === 'd') prefix = String(start).padStart(7, ' ') + ' ';
          else if (offsetMode === 'x') prefix = start.toString(16).padStart(7, '0') + ' ';
          else if (offsetMode === 'o') prefix = start.toString(8).padStart(7, '0') + ' ';
          out += prefix + bytesText(bytes.slice(start, i)) + '\n';
        }
        start = -1;
      }
    }
  }
  c.out(out);
  return 0;
}

/* ============================== look ============================== */

async function lookRun(c, argv) {
  let fold = false, term = null;
  const operands = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'f') fold = true;
        else if (ch === 'b') continue;
        else if (ch === 't') { term = a.slice(k + 1) || argv[++i]; k = a.length; }
      }
      continue;
    }
    operands.push(a);
  }
  if (!operands.length) return reportErr(c, 'look: missing word', 1);
  const word = operands[0];
  const dict = operands[1] || '/usr/share/dict/words';
  let text;
  try { text = readTextFile(c, dict); }
  catch (e) { return reportErr(c, `look: ${dict}: ${errnoText(e)}`, 1); }
  const needle = fold ? word.toLowerCase() : word;
  let out = '';
  for (const line of splitOutput(text).lines) {
    let key = line;
    if (term !== null) { const idx = key.indexOf(term); if (idx >= 0) key = key.slice(0, idx); }
    const cmp = fold ? key.toLowerCase() : key;
    if (cmp.startsWith(needle)) out += line + '\n';
  }
  c.out(out);
  return 0;
}

/* ============================== patch ============================== */

function patchParseHunks(lines, reverse) {
  const files = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('--- ')) {
      const oldName = line.slice(4).split('\t')[0].trim();
      let newName = null;
      if (i + 1 < lines.length && lines[i + 1].startsWith('+++ ')) {
        newName = lines[i + 1].slice(4).split('\t')[0].trim();
        i++;
      }
      cur = { oldName, newName, hunks: [] };
      files.push(cur);
      continue;
    }
    if (!cur || !line.startsWith('@@')) continue;
    const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (!m) continue;
    const hunk = { oldStart: Number(m[1]), oldCount: m[2] !== undefined ? Number(m[2]) : 1, newStart: Number(m[3]), newCount: m[4] !== undefined ? Number(m[4]) : 1, oldLines: [], newLines: [] };
    i++;
    while (i < lines.length && !lines[i].startsWith('@@') && !lines[i].startsWith('--- ')) {
      const ln = lines[i];
      if (ln.startsWith('\\')) { i++; continue; }
      if (ln === '') break;
      const tag = ln[0];
      const body = ln.slice(1);
      if (tag === ' ') { hunk.oldLines.push(body); hunk.newLines.push(body); }
      else if (tag === '-') hunk.oldLines.push(body);
      else if (tag === '+') hunk.newLines.push(body);
      else break;
      i++;
    }
    i--;
    cur.hunks.push(hunk);
  }
  if (reverse) {
    for (const f of files) {
      [f.oldName, f.newName] = [f.newName, f.oldName];
      for (const h of f.hunks) {
        [h.oldLines, h.newLines] = [h.newLines, h.oldLines];
        [h.oldStart, h.newStart] = [h.newStart, h.oldStart];
        [h.oldCount, h.newCount] = [h.newCount, h.oldCount];
      }
    }
  }
  return files;
}

function patchStrip(path, count) {
  if (!path || path === '/dev/null') return null;
  const parts = path.split('/').filter((p) => p !== '');
  if (count <= 0) return path;
  if (parts.length <= count) return parts[parts.length - 1] || path;
  return parts.slice(count).join('/');
}

async function patchRun(c, argv) {
  let strip = 0, patchFile = null, reverse = false, dryRun = false, quiet = false;
  const operands = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { operands.push(...argv.slice(i + 1)); break; }
    if (a === '--reverse') { reverse = true; continue; }
    if (a === '--dry-run') { dryRun = true; continue; }
    if (a === '--quiet' || a === '--silent') { quiet = true; continue; }
    if (a.startsWith('--strip=')) { strip = Number(a.slice(8)) || 0; continue; }
    if (a.startsWith('-') && a.length > 1) {
      for (let k = 1; k < a.length; k++) {
        const ch = a[k];
        if (ch === 'p') { strip = Number(a.slice(k + 1) || argv[++i]) || 0; k = a.length; }
        else if (ch === 'i') { patchFile = a.slice(k + 1) || argv[++i]; k = a.length; }
        else if (ch === 'R') reverse = true;
        else if (ch === 'N') continue;
        else if (ch === 's') quiet = true;
        else if (ch === 'b') continue;
        else if (ch === 'd') { argv[++i]; k = a.length; }
      }
      continue;
    }
    operands.push(a);
  }
  let patchText;
  let targetOverride = null;
  if (patchFile) {
    try { patchText = readTextFile(c, patchFile); }
    catch (e) { return reportErr(c, `patch: ${patchFile}: ${errnoText(e)}`, 2); }
    targetOverride = operands[0] ?? null;
  } else if (operands.length >= 2) {
    targetOverride = operands[0];
    try { patchText = readTextFile(c, operands[1]); }
    catch (e) { return reportErr(c, `patch: ${operands[1]}: ${errnoText(e)}`, 2); }
  } else {
    targetOverride = operands[0] ?? null;
    patchText = await c.readText();
  }
  const files = patchParseHunks(splitOutput(patchText).lines, reverse);
  if (!files.length) return reportErr(c, 'patch: only garbage was found in the patch input', 2);
  let failed = false;
  for (const f of files) {
    const target = targetOverride ?? patchStrip(f.newName ?? f.oldName, strip);
    if (!target) continue;
    let content;
    try { content = splitOutput(readTextFile(c, target)).lines; }
    catch { content = []; }
    let offset = 0, ok = true;
    for (const h of f.hunks) {
      const oldLines = h.oldLines;
      const newLines = h.newLines;
      let pos = Math.max(0, h.oldStart - 1 + offset);
      const matchesAt = (p) => p >= 0 && p + oldLines.length <= content.length && oldLines.every((l, k) => content[p + k] === l);
      if (!matchesAt(pos)) {
        let found = -1;
        for (let d = 1; d <= Math.max(pos, content.length); d++) {
          if (matchesAt(pos - d)) { found = pos - d; break; }
          if (matchesAt(pos + d)) { found = pos + d; break; }
        }
        if (found < 0 && oldLines.length === 0) found = Math.min(pos, content.length);
        pos = found;
      }
      if (pos < 0) {
        c.err(`patch: **** malformed patch at line ${h.oldStart} (hunk failed)\n`);
        ok = false;
        failed = true;
        break;
      }
      content.splice(pos, oldLines.length, ...newLines);
      offset += newLines.length - oldLines.length;
    }
    if (!ok) continue;
    if (!quiet) c.out(`patching file ${target}\n`);
    if (!dryRun) {
      try { c.vfs.writeFile(ctxPath(c, target), textBytes(content.length ? content.join('\n') + '\n' : ''), cred(c)); }
      catch (e) { c.err(`patch: ${target}: ${errnoText(e)}\n`); failed = true; }
    }
  }
  return failed ? 1 : 0;
}

/* ============================== registration ============================== */

export function registerTextCommands(kernel) {
  const ctx = { kernel };
  reg(ctx, 'grep', 'Print lines matching a pattern', (c) => grepRun(c, c.args));
  reg(ctx, 'egrep', 'Print lines matching an extended regex', (c) => grepRun(c, c.args));
  reg(ctx, 'fgrep', 'Print lines matching a fixed string', (c) => grepRun(c, c.args));
  reg(ctx, 'sed', 'Stream editor for filtering and transforming text', (c) => sedRun(c, c.args));
  reg(ctx, 'awk', 'Pattern scanning and processing language', (c) => awkRun(c, c.args));
  reg(ctx, 'sort', 'Sort lines of text files', (c) => sortRun(c, c.args));
  reg(ctx, 'uniq', 'Report or omit repeated lines', (c) => uniqRun(c, c.args));
  reg(ctx, 'cut', 'Remove sections from each line of files', (c) => cutRun(c, c.args));
  reg(ctx, 'paste', 'Merge lines of files', (c) => pasteRun(c, c.args));
  reg(ctx, 'join', 'Join lines of two files on a common field', (c) => joinRun(c, c.args));
  reg(ctx, 'comm', 'Compare two sorted files line by line', (c) => commRun(c, c.args));
  reg(ctx, 'tr', 'Translate or delete characters', (c) => trRun(c, c.args));
  reg(ctx, 'fold', 'Wrap each input line to fit in specified width', (c) => foldRun(c, c.args));
  reg(ctx, 'fmt', 'Reformat paragraphs to a given width', (c) => fmtRun(c, c.args));
  reg(ctx, 'expand', 'Convert tabs to spaces', (c) => expandRun(c, c.args));
  reg(ctx, 'unexpand', 'Convert spaces to tabs', (c) => unexpandRun(c, c.args));
  reg(ctx, 'od', 'Dump files in octal and other formats', (c) => odRun(c, c.args));
  reg(ctx, 'hexdump', 'Display file contents in hexadecimal or other formats', (c) => hexdumpRun(c, c.args));
  reg(ctx, 'split', 'Split a file into pieces', (c) => splitRun(c, c.args));
  reg(ctx, 'csplit', 'Split a file into context-determined pieces', (c) => csplitRun(c, c.args));
  reg(ctx, 'tee', 'Read stdin and write to stdout and files', (c) => teeRun(c, c.args));
  reg(ctx, 'diff', 'Compare files line by line', (c) => diffRun(c, c.args));
  reg(ctx, 'cmp', 'Compare two files byte by byte', (c) => cmpRun(c, c.args));
  reg(ctx, 'find', 'Search for files in a directory hierarchy', (c) => findRun(c, c.args));
  reg(ctx, 'xargs', 'Build and execute command lines from standard input', (c) => xargsRun(c, c.args));
  reg(ctx, 'which', 'Locate a command in PATH', (c) => whichRun(c, c.args));
  reg(ctx, 'column', 'Columnate lists', (c) => columnRun(c, c.args));
  reg(ctx, 'strings', 'Print printable strings in binary files', (c) => stringsRun(c, c.args));
  reg(ctx, 'look', 'Display lines beginning with a given string', (c) => lookRun(c, c.args));
  reg(ctx, 'patch', 'Apply a diff file to an original', (c) => patchRun(c, c.args));
}
