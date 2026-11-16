/* POSIX test / [ expression evaluator (also used for [[ ]]). */

import { globToRegex } from './expand.js';

export function evaluateTest(args, shell, { doubleBracket = false } = {}) {
  let i = 0;
  const vfs = shell.kernel.vfs;
  const cred = shell.cred();
  const stat = (p) => { try { return vfs.stat(p, cred); } catch { return null; } };
  const lstat = (p) => { try { return vfs.stat(p, cred, { followFinal: false }); } catch { return null; } };
  const unary = (op, val) => {
    switch (op) {
      case '-e': return stat(val) !== null;
      case '-a': return stat(val) !== null;
      case '-f': return !!stat(val)?.isFile();
      case '-d': return !!stat(val)?.isDirectory();
      case '-h': case '-L': return !!lstat(val)?.isSymbolicLink();
      case '-s': return (stat(val)?.size ?? 0) > 0;
      case '-r': { try { vfs.access(val, 4, cred); return true; } catch { return false; } }
      case '-w': { try { vfs.access(val, 2, cred); return true; } catch { return false; } }
      case '-x': { try { vfs.access(val, 1, cred); return true; } catch { return false; } }
      case '-p': return !!stat(val)?.isFIFO();
      case '-S': return !!stat(val)?.isSocket();
      case '-b': return !!stat(val)?.isBlockDevice();
      case '-c': return !!stat(val)?.isCharacterDevice();
      case '-u': return !!(stat(val)?.mode & 0o4000);
      case '-g': return !!(stat(val)?.mode & 0o2000);
      case '-k': return !!(stat(val)?.mode & 0o1000);
      case '-z': return val === '';
      case '-n': return val !== '';
      case '-t': return false;
      case '-O': return stat(val)?.uid === shell.uid;
      case '-G': return stat(val)?.gid === shell.gid;
      default: throw new Error(`${op}: unary operator expected`);
    }
  };
  const toNum = (s) => {
    const n = Number(s);
    if (Number.isNaN(n)) throw new Error(`${s}: integer expression expected`);
    return n;
  };
  const binary = (l, op, r) => {
    switch (op) {
      case '=': case '==': return doubleBracket ? globToRegex(r, { pathMode: false }).test(l) : l === r;
      case '!=': return doubleBracket ? !globToRegex(r, { pathMode: false }).test(l) : l !== r;
      case '<': return l < r;
      case '>': return l > r;
      case '=~': {
        const m = String(r).match(/^\/(.*)\/([a-z]*)$/);
        const re = m ? new RegExp(m[1], m[2]) : new RegExp(r);
        return re.test(l);
      }
      case '-eq': return toNum(l) === toNum(r);
      case '-ne': return toNum(l) !== toNum(r);
      case '-lt': return toNum(l) < toNum(r);
      case '-le': return toNum(l) <= toNum(r);
      case '-gt': return toNum(l) > toNum(r);
      case '-ge': return toNum(l) >= toNum(r);
      case '-ef': {
        const a = stat(l), b = stat(r);
        return !!a && !!b && a.ino === b.ino;
      }
      case '-nt': { const a = stat(l), b = stat(r); return !!a && (!b || a.mtimeMs > b.mtimeMs); }
      case '-ot': { const a = stat(l), b = stat(r); return !!b && (!a || a.mtimeMs < b.mtimeMs); }
      default: throw new Error(`${op}: binary operator expected`);
    }
  };
  const isUnary = (t) => /^-[efdhLsrwxpSbcugkznOtOG]$/.test(t);
  const isBinary = (t) => ['=', '==', '!=', '<', '>', '=~', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-ef', '-nt', '-ot'].includes(t);

  const orExpr = () => {
    let v = andExpr();
    while (i < args.length && (args[i] === '-o' || args[i] === '||')) { i++; const r = andExpr(); v = v || r; }
    return v;
  };
  const andExpr = () => {
    let v = notExpr();
    while (i < args.length && (args[i] === '-a' || args[i] === '&&')) { i++; const r = notExpr(); v = v && r; }
    return v;
  };
  const notExpr = () => {
    if (args[i] === '!') { i++; return !notExpr(); }
    return primary();
  };
  const primary = () => {
    if (args[i] === '(') {
      i++;
      const v = orExpr();
      if (args[i] !== ')') throw new Error("')' expected");
      i++;
      return v;
    }
    const t = args[i];
    if (t === undefined) return false;
    if (isUnary(t) && args[i + 1] !== undefined) {
      i += 2;
      return unary(t, args[i - 1]);
    }
    if (args[i + 1] !== undefined && isBinary(args[i + 1])) {
      const l = args[i], op = args[i + 1], r = args[i + 2];
      i += 3;
      return binary(l, op, r);
    }
    i++;
    return t !== '';
  };
  if (!args.length) return false;
  const result = orExpr();
  if (i !== args.length) throw new Error(`unexpected argument '${args[i]}'`);
  return result;
}
