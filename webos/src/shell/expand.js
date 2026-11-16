/* Word expansion: braces, tilde, parameters, command substitution, arithmetic,
 * field splitting and pathname generation. */

import { parseWordOnly } from './parser.js';

const GLOB_META = /[\\*?[\]]/;
const DEFAULT_IFS = ' \t\n';

export class ExpansionError extends Error {
  constructor(message) { super(message); this.name = 'ExpansionError'; }
}

export function escapeGlob(s) {
  return String(s).replace(/[\\*?[\]]/g, (c) => '\\' + c);
}
export function unescapeGlob(s) {
  return String(s).replace(/\\(.)/g, '$1');
}

export function globToRegex(pattern, { pathMode = true, nocase = false } = {}) {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '\\') { i++; out += escapeRegex(pattern[i] ?? ''); continue; }
    if (c === '*') {
      if (pattern[i + 1] === '*' && pathMode) { out += '.*'; i++; }
      else out += pathMode ? '[^/]*' : '.*';
      continue;
    }
    if (c === '?') { out += pathMode ? '[^/]' : '.'; continue; }
    if (c === '[') {
      let j = i + 1;
      let cls = '';
      if (pattern[j] === '!' || pattern[j] === '^') { cls += '^'; j++; }
      if (pattern[j] === ']') { cls += '\\]'; j++; }
      while (j < pattern.length && pattern[j] !== ']') {
        if (pattern[j] === '\\') { cls += '\\' + pattern[j + 1]; j += 2; continue; }
        cls += pattern[j]; j++;
      }
      if (j < pattern.length) { out += '[' + cls + ']'; i = j; continue; }
      out += '\\[';
      continue;
    }
    out += escapeRegex(c);
  }
  return new RegExp('^' + out + '$', nocase ? 'i' : '');
}
function escapeRegex(c) { return /[\\^$.*+?()[\]{}|]/.test(c) ? '\\' + c : c; }

export function braceExpand(str) {
  let i = -1;
  for (let k = 0; k < str.length; k++) {
    if (str[k] === '\\') { k++; continue; }
    if (str[k] === '{') { i = k; break; }
  }
  if (i < 0) return [str];
  let depth = 0, end = -1;
  const commas = [];
  for (let k = i; k < str.length; k++) {
    if (str[k] === '\\') { k++; continue; }
    if (str[k] === '{') depth++;
    else if (str[k] === '}') { depth--; if (depth === 0) { end = k; break; } }
    else if (str[k] === ',' && depth === 1) commas.push(k);
  }
  if (end < 0) return [str];
  const prefix = str.slice(0, i);
  const suffix = str.slice(end + 1);
  const inside = str.slice(i + 1, end);
  let alts;
  if (commas.length) {
    alts = [];
    let last = 0;
    for (const c of commas) { alts.push(inside.slice(last, c)); last = c + 1; }
    alts.push(inside.slice(last));
  } else {
    const seq = inside.match(/^(-?\d+)\.\.(-?\d+)(?:\.\.(-?\d+))?$/);
    const chars = inside.match(/^([A-Za-z])\.\.([A-Za-z])(?:\.\.(-?\d+))?$/);
    if (seq) {
      let [a, b] = [Number(seq[1]), Number(seq[2])];
      let step = Number(seq[3] || (a <= b ? 1 : -1));
      if (!step) return [str];
      if ((a < b && step < 0) || (a > b && step > 0)) step = -step;
      alts = [];
      for (let v = a; step > 0 ? v <= b : v >= b; v += step) alts.push(String(v));
    } else if (chars) {
      let a = chars[1].charCodeAt(0), b = chars[2].charCodeAt(0);
      let step = Number(chars[3] || (a <= b ? 1 : -1));
      if (!step) return [str];
      if ((a < b && step < 0) || (a > b && step > 0)) step = -step;
      alts = [];
      for (let v = a; step > 0 ? v <= b : v >= b; v += step) alts.push(String.fromCharCode(v));
    } else return [str];
  }
  const out = [];
  for (const a of alts) for (const rest of braceExpand(suffix)) out.push(prefix + a + rest);
  return out;
}

/* ------------------------- arithmetic ------------------------- */

const ARITH_OPS = ['<<=', '>>=', '**=', '++', '--', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '+', '-', '*', '/', '%', '<', '>', '&', '|', '^', '~', '!', '?', ':', '(', ')', ',', '='];

export function evalArithmetic(expr, shell) {
  let src = String(expr);
  // simple assignment form
  const assign = src.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(\*=|\/=|%=|\+=|-=|<<=|>>=|&=|\|=|\^|=)(?!=)\s*([\s\S]*)$/);
  if (assign) {
    const [, name, op, rest] = assign;
    const rhs = evalArithmetic(rest, shell);
    const cur = Number.parseInt(shell.getVar(name) || '0', 10) || 0;
    let val = rhs;
    switch (op) {
      case '+=': val = cur + rhs; break;
      case '-=': val = cur - rhs; break;
      case '*=': val = cur * rhs; break;
      case '/=': val = Math.trunc(cur / rhs); break;
      case '%=': val = cur % rhs; break;
      case '<<=': val = cur << rhs; break;
      case '>>=': val = cur >> rhs; break;
      case '&=': val = cur & rhs; break;
      case '|=': val = cur | rhs; break;
      case '^=': val = cur ^ rhs; break;
      default: val = rhs;
    }
    shell.setVar(name, String(val));
    return val;
  }
  let i = 0;
  const toks = [];
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      let s = '';
      while (i < src.length && /[0-9a-fA-FxXbB]/.test(src[i])) { s += src[i]; i++; }
      toks.push({ t: 'num', v: s });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = '';
      while (i < src.length && /[A-Za-z0-9_]/.test(src[i])) { s += src[i]; i++; }
      toks.push({ t: 'id', v: s });
      continue;
    }
    const op = ARITH_OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new ExpansionError(`arithmetic syntax error near '${src.slice(i)}'`);
    toks.push({ t: 'op', v: op });
    i += op.length;
  }
  let p = 0;
  const peek = () => toks[p]?.v;
  const eat = (v) => { if (toks[p]?.v === v) { p++; return true; } return false; };
  const expect = (v) => { if (!eat(v)) throw new ExpansionError(`arithmetic: expected '${v}'`); };
  const num = (v) => {
    if (v === undefined) return 0;
    if (/^0[xX]/.test(v)) return parseInt(v.slice(2), 16) || 0;
    if (/^0[bB]/.test(v)) return parseInt(v.slice(2), 2) || 0;
    if (/^0[0-7]+$/.test(v)) return parseInt(v, 8) || 0;
    return Number(v) || 0;
  };
  const primary = () => {
    const tk = toks[p];
    if (!tk) return 0;
    if (tk.t === 'num') { p++; return num(tk.v); }
    if (tk.t === 'id') {
      p++;
      let val = Number.parseInt(shell.getVar(tk.v) || '0', 10) || 0;
      if (peek() === '++') { p++; shell.setVar(tk.v, String(val + 1)); }
      else if (peek() === '--') { p++; shell.setVar(tk.v, String(val - 1)); }
      return val;
    }
    if (eat('(')) { const v = ternary(); expect(')'); return v; }
    if (eat('+')) return unary();
    if (eat('-')) return -unary();
    if (eat('!')) return unary() ? 0 : 1;
    if (eat('~')) return ~unary();
    if (eat('++')) { const tk2 = toks[p++]; const v = (parseInt(shell.getVar(tk2.v) || '0', 10) || 0) + 1; shell.setVar(tk2.v, String(v)); return v; }
    if (eat('--')) { const tk2 = toks[p++]; const v = (parseInt(shell.getVar(tk2.v) || '0', 10) || 0) - 1; shell.setVar(tk2.v, String(v)); return v; }
    return 0;
  };
  const power = () => { let l = primaryWhile(); while (eat('**')) l = Math.pow(l, unary()); return l; };
  const primaryWhile = () => primary();
  const unary = () => power();
  const mul = () => {
    let l = unary();
    for (;;) { if (eat('*')) l *= unary(); else if (eat('/')) { const r = unary(); if (!r) throw new ExpansionError('division by zero'); l = Math.trunc(l / r); } else if (eat('%')) { const r = unary(); if (!r) throw new ExpansionError('division by zero'); l %= r; } else break; }
    return l;
  };
  const add = () => {
    let l = mul();
    for (;;) { if (eat('+')) l += mul(); else if (eat('-')) l -= mul(); else break; }
    return l;
  };
  const shift = () => { let l = add(); for (;;) { if (eat('<<')) l <<= add(); else if (eat('>>')) l >>= add(); else break; } return l; };
  const rel = () => { let l = shift(); for (;;) { if (eat('<')) l = l < shift() ? 1 : 0; else if (eat('<=')) l = l <= shift() ? 1 : 0; else if (eat('>')) l = l > shift() ? 1 : 0; else if (eat('>=')) l = l >= shift() ? 1 : 0; else break; } return l; };
  const eq = () => { let l = rel(); for (;;) { if (eat('==')) l = l === rel() ? 1 : 0; else if (eat('!=')) l = l !== rel() ? 1 : 0; else break; } return l; };
  const band = () => { let l = eq(); while (eat('&') && peek() !== '&') l &= eq(); return l; };
  const bxor = () => { let l = band(); while (eat('^')) l ^= band(); return l; };
  const bor = () => { let l = bxor(); while (eat('|') && peek() !== '|') l |= bxor(); return l; };
  const land = () => { let l = bor(); while (peek() === '&&') { p++; const r = bor(); l = l && r ? 1 : 0; } return l; };
  const lor = () => { let l = land(); while (peek() === '||') { p++; const r = land(); l = l || r ? 1 : 0; } return l; };
  const ternary = () => {
    const c = lor();
    if (eat('?')) { const a = ternary(); expect(':'); const b = ternary(); return c ? a : b; }
    return c;
  };
  const v = ternary();
  if (p < toks.length) throw new ExpansionError(`arithmetic: unexpected token '${toks[p].v}'`);
  return v;
}

/* ------------------------- expander ------------------------- */

export class Expander {
  constructor(shell) {
    this.shell = shell;
    this.vfs = shell.kernel.vfs;
  }
  context() { return this.shell.cred(); }

  async expandWords(words) {
    const out = [];
    for (const w of words) out.push(...await this.expandWord(w));
    return out;
  }

  async expandWord(word) {
    let words = [word];
    if (!word.quoted && word.raw.includes('{')) {
      const expanded = braceExpand(word.raw);
      if (expanded.length > 1 || expanded[0] !== word.raw) words = expanded.map((r) => parseWordOnly(r));
    }
    let out = [];
    for (const w of words) out.push(...await this.expandOne(w));
    return out;
  }

  async expandString(word) {
    // expansion without field splitting / globbing (used for assignments, redirects, here-docs)
    const f = { chunks: [], present: false };
    const fields = [f];
    await this.expandPartsInto(word.parts, fields, f, false);
    return fields.map((x) => x.chunks.map((c) => c.s).join('')).join(' ');
  }

  async expandPartsString(parts) {
    return this.expandString({ parts });
  }

  async expandOne(word) {
    const fields = [];
    let cur = { chunks: [], present: false };
    fields.push(cur);
    await this.expandPartsInto(word.parts, fields, cur, true);
    const keep = fields.filter((f) => f.present || f.chunks.length);
    const result = [];
    for (const f of keep) result.push(...this.finishField(f));
    return result;
  }

  async expandPartsInto(parts, fields, cur, split) {
    const setCur = (f) => { cur = f; return f; };
    let current = cur;
    const newField = () => { const f = { chunks: [], present: false }; fields.push(f); return f; };
    const append = (text, glob) => { current.present = true; if (text) current.chunks.push({ s: text, glob }); };
    const addSplit = (text) => {
      if (!text) return;
      const ifs = this.shell.getVar('IFS') ?? DEFAULT_IFS;
      let buf = '';
      let started = false;
      for (const ch of text) {
        if (ifs.includes(ch)) {
          if (buf) { append(buf, true); buf = ''; started = true; }
          if (started) { current = newField(); started = false; }
          // collapse runs of whitespace; do not create fields for empty segments
          if (current.chunks.length) current = newField();
        } else {
          buf += ch;
          started = true;
        }
      }
      if (buf) append(buf, true);
      if (started && current !== fields[fields.length - 1]) {
        // leave trailing empty field to be removed by caller
      }
    };

    for (let idx = 0; idx < parts.length; idx++) {
      let part = parts[idx];
      if (idx === 0 && part.t === 'lit' && !part.q && part.v.startsWith('~')) {
        part = { ...part, v: this.tilde(part.v) };
      }
      if (part.t === 'lit') {
        append(part.v, !part.q);
        continue;
      }
      if (part.t === 'compound') {
        const sub = [];
        const f = { chunks: [], present: false };
        sub.push(f);
        const localCur = f;
        await this.expandPartsInto(part.parts.map((p) => ({ ...p, q: true })), sub, localCur, false);
        for (const sf of sub) {
          for (const c of sf.chunks) append(c.s, false);
          if (sf.present) current.present = true;
        }
        continue;
      }
      if (part.t === 'param') {
        const values = await this.expandParam(part);
        if (part.name === '@' || part.name === '*') {
          if (part.q) {
            const pos = this.shell.positional;
            if (part.name === '@') {
              if (!pos.length) continue;
              for (let k = 0; k < pos.length; k++) {
                if (k > 0) current = newField();
                append(pos[k], false);
              }
            } else append(pos.join((this.shell.getVar('IFS') ?? DEFAULT_IFS)[0] || ' '), false);
          } else {
            for (const p of this.shell.positional) addSplit(p);
          }
          continue;
        }
        const text = values;
        if (part.q) append(text, false);
        else if (split) addSplit(text);
        else append(text, true);
        continue;
      }
      if (part.t === 'cmdsub' || part.t === 'arith') {
        let text;
        if (part.t === 'arith') text = String(evalArithmetic(part.src, this.shell));
        else {
          const r = await this.shell.runSubshell(part.src);
          text = r.stdout.replace(/\n+$/, '');
          if (r.stderr) this.shell.writeStderr(r.stderr);
        }
        if (part.q) append(text, false);
        else if (split) addSplit(text);
        else append(text, true);
        continue;
      }
    }
    cur = current;
    return current;
  }

  async expandParam(part) {
    if (part.name) {
      return this.paramValue(part.name);
    }
    return this.expandParamRaw(part.raw);
  }

  paramValue(name) {
    const sh = this.shell;
    switch (name) {
      case '?': return String(sh.status);
      case '$': return String(sh.pid);
      case '!': return sh.lastBg ? String(sh.lastBg) : '';
      case '#': return String(sh.positional.length);
      case '-': return sh.optionFlags();
      case '0': return sh.argv0 || 'sh';
      case '@': case '*': return sh.positional.join(' ');
      default:
        if (/^\d+$/.test(name)) return sh.positional[Number(name) - 1] ?? '';
        return sh.getVar(name) ?? '';
    }
  }

  isSet(name) {
    const sh = this.shell;
    if (name === '?') return true;
    if (/^\d+$/.test(name)) return Number(name) <= sh.positional.length;
    return sh.hasVar(name);
  }

  async expandParamRaw(raw) {
    const sh = this.shell;
    let length = false;
    if (raw.startsWith('#')) { length = true; raw = raw.slice(1); }
    if (raw.startsWith('!')) {
      const rest = raw.slice(1);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(rest)) {
        const n = sh.getVar(rest);
        return n == null ? '' : this.paramValue(n);
      }
      const names = sh.varNames().filter((n) => n.startsWith(rest));
      return names.join(' ');
    }
    const nameMatch = raw.match(/^([A-Za-z_][A-Za-z0-9_]*|\d+|[@*#?$!-])/);
    if (!nameMatch) return '';
    const name = nameMatch[1];
    let rest = raw.slice(name.length);
    let value = this.paramValue(name);
    const set = this.isSet(name);
    if (length) return String(name === '@' || name === '*' ? sh.positional.length : [...value].length);

    const opMatch = rest.match(/^(:-|:=|:\+|:\?|-|=|\+|\?)/);
    if (opMatch) {
      const op = opMatch[1];
      const colon = op.startsWith(':');
      const kind = op.replace(':', '');
      const wordText = rest.slice(op.length);
      const unset = !set || (colon && value === '');
      const word = unset ? await this.expandString(parseWordOnly(wordText)) : '';
      if (kind === '-') return unset ? word : value;
      if (kind === '=') {
        if (unset) { sh.setVar(name, word); return word; }
        return value;
      }
      if (kind === '?') {
        if (unset) throw new ExpansionError(`${name}: ${word || 'parameter not set'}`);
        return value;
      }
      if (kind === '+') return unset ? '' : word;
    }
    if (rest.startsWith(':')) {
      const m = rest.match(/^:\s*(-?\d+)(?::\s*(-?\d+))?$/);
      if (m) {
        const off = Number(m[1]);
        const len = m[2] === undefined ? undefined : Number(m[2]);
        const chars = [...value];
        const start = off < 0 ? Math.max(0, chars.length + off) : off;
        return (len === undefined ? chars.slice(start) : chars.slice(start, start + (len < 0 ? chars.length + len : len))).join('');
      }
    }
    if (rest.startsWith('##') || rest.startsWith('#') || rest.startsWith('%%') || rest.startsWith('%')) {
      const long = rest.startsWith('##') || rest.startsWith('%%');
      const kind = rest[0];
      const pat = await this.expandString(parseWordOnly(rest.slice(long ? 2 : 1)));
      if (!pat) return value;
      const re = globToRegex(pat, { pathMode: false });
      if (kind === '#') {
        const chars = [...value];
        let best = long ? -1 : 0;
        for (let k = 0; k <= chars.length; k++) {
          const sub = chars.slice(0, k).join('');
          if (re.test(sub)) { if (!long) { best = k; break; } best = k; }
        }
        if (best >= 0) return chars.slice(best).join('');
        return value;
      }
      const chars = [...value];
      let best = long ? -1 : chars.length;
      for (let k = 0; k <= chars.length; k++) {
        const sub = chars.slice(k).join('');
        if (re.test(sub)) { if (!long) { best = k; break; } best = k; }
      }
      if (best >= 0) return chars.slice(0, best).join('');
      return value;
    }
    if (rest.startsWith('/')) {
      const all = rest.startsWith('//');
      let body = rest.slice(all ? 2 : 1);
      let anchor = '';
      if (body.startsWith('#')) { anchor = '#'; body = body.slice(1); }
      else if (body.startsWith('%')) { anchor = '%'; body = body.slice(1); }
      const slash = body.indexOf('/');
      let pat = slash < 0 ? body : body.slice(0, slash);
      let repl = slash < 0 ? '' : body.slice(slash + 1);
      pat = await this.expandString(parseWordOnly(pat));
      repl = await this.expandString(parseWordOnly(repl));
      const reSrc = globToRegex(pat, { pathMode: false }).source;
      const flags = all ? 'g' : '';
      if (anchor === '#') return value.replace(new RegExp('^' + reSrc.replace(/^\^/, '').replace(/\$$/, ''), flags), repl);
      if (anchor === '%') return value.replace(new RegExp(reSrc.replace(/^\^/, '').replace(/\$$/, '') + '$', flags), repl);
      return value.replace(new RegExp(reSrc.replace(/^\^/, '').replace(/\$$/, ''), flags), repl);
    }
    if (rest === '^^') return value.toUpperCase();
    if (rest === '^') return value ? value[0].toUpperCase() + value.slice(1) : value;
    if (rest === ',,') return value.toLowerCase();
    if (rest === ',') return value ? value[0].toLowerCase() + value.slice(1) : value;
    return value;
  }

  tilde(text) {
    if (!text.startsWith('~')) return text;
    const slash = text.indexOf('/');
    const who = slash < 0 ? text.slice(1) : text.slice(1, slash);
    const tail = slash < 0 ? '' : text.slice(slash);
    if (!who) return (this.shell.home || '/home/user') + tail;
    const u = this.shell.kernel.userByName(who);
    if (u) return u.home + tail;
    return text;
  }

  finishField(field) {
    if (!field.present) return [];
    const hasMagic = field.chunks.some((c) => c.glob && /[*?[]/.test(c.s));
    // Only unquoted (glob-enabled) chunks may contain backslash escapes; quoted
    // backslashes are literal (e.g. printf "%s\n" must keep the backslash).
    const plainText = field.chunks.map((c) => (c.glob ? unescapeGlob(c.s) : c.s)).join('');
    if (!hasMagic) return [plainText];
    const pattern = field.chunks.map((c) => (c.glob ? c.s : escapeGlob(c.s))).join('');
    const matches = this.glob(pattern);
    if (!matches.length) return [plainText];
    return matches;
  }

  glob(pattern) {
    const absolute = pattern.startsWith('/');
    const cwd = this.shell.cwd;
    const base0 = absolute ? '/' : cwd;
    const segs = pattern.split('/').filter((s) => s !== '');
    if (!segs.length) return [absolute ? '/' : '.'];
    let bases = [base0];
    for (const seg of segs) {
      const magic = hasGlobMagic(seg);
      const next = [];
      if (!magic) {
        const name = unescapeGlob(seg);
        for (const b of bases) {
          const p = joinAbs(b, name);
          try {
            const st = this.vfs.stat(p, this.context());
            next.push(p);
          } catch { /* missing */ }
        }
      } else {
        const re = globToRegex(seg);
        for (const b of bases) {
          let names;
          try { names = this.vfs.readdir(b, this.context()); } catch { continue; }
          names.sort();
          for (const n of names) {
            if (n.startsWith('.') && !seg.startsWith('.')) continue;
            if (re.test(n)) next.push(joinAbs(b, n));
          }
        }
      }
      bases = next;
      if (!bases.length) break;
    }
    const out = [];
    for (const p of bases) {
      let display = p;
      if (!absolute) {
        const prefix = cwd === '/' ? '/' : cwd + '/';
        display = p.startsWith(prefix) ? p.slice(prefix.length) : p;
      }
      out.push(display);
    }
    return [...new Set(out)].sort();
  }
}

function hasGlobMagic(seg) {
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '\\') { i++; continue; }
    if (seg[i] === '*' || seg[i] === '?' || seg[i] === '[') return true;
  }
  return false;
}

export function joinAbs(base, name) {
  if (name.startsWith('/')) return name;
  if (base === '/') return '/' + name;
  return base + '/' + name;
}
