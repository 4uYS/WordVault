/* Core file, directory and misc utilities. */

import { Inode } from '../kernel/vfs.js';
import {
  parseOpts, resolvePath, statOf, tryStat, readTextFile, errnoText,
  modeString, humanSize, pad, fmtDate, makeTempName, parseSize,
} from './util.js';

const ctxPath = (ctx, p) => resolvePath(ctx, p);
const cred = (ctx) => ctx.cred();
const join = (a, b) => (a === '/' ? '/' + b : a + '/' + b);
const base = (p) => (p === '/' ? '/' : p.replace(/\/+$/, '').split('/').pop());

function reg(ctx, name, summary, run) {
  ctx.kernel.registerCommand(name, { summary, run });
}

function reportErr(ctx, msg, code = 1) {
  ctx.err(msg + '\n');
  return code;
}

export function registerCoreutils(kernel) {
  const ctx = { kernel };

  reg(ctx, 'ls', 'list directory contents', async (c) => {
    const o = parseOpts(c.args, 'laAhRrtSd1FinpsU', {
      all: 'a', 'almost-all': 'A', long: 'l', human: 'h', recursive: 'R',
      reverse: 'r', time: 't', sort: 'S', directory: 'd', inode: 'i', numeric: 'n',
    });
    const all = !!o.a, almost = !!o.A || all;
    const long = !!o.l, human = !!o.h, recursive = !!o.R, dirOnly = !!o.d;
    const showInode = !!o.i, numeric = !!o.n, classify = !!o.F;
    const operands = o._.length ? o._ : ['.'];
    const creds = cred(c);
    let exit = 0;

    const displayName = (path, st, name) => {
      let out = name;
      if (classify) {
        if (st.isDirectory()) out += '/';
        else if (st.isSymbolicLink()) out += '@';
        else if (st.isFIFO()) out += '|';
        else if (st.mode & 0o111) out += '*';
      }
      if (long && st.isSymbolicLink()) {
        try { out += ' -> ' + c.vfs.readlink(path, creds); } catch { /* ignore */ }
      }
      return out;
    };
    const listDir = (path, header) => {
      let entries;
      try { entries = [...c.vfs.readdirNodes(path, creds)]; }
      catch (e) { exit = reportErr(c, `cannot open directory '${path}': ${errnoText(e)}`, 2); return; }
      let items = entries
        .filter(([n]) => (all ? n !== '.' && n !== '..' : almost ? !n.startsWith('.') || n === '.' : !n.startsWith('.')))
        .map(([n, node]) => ({ name: n, node, st: c.vfs.statObj(node) }));
      if (!all) items = items.filter((x) => !x.name.startsWith('.') || almost);
      const cmp = (a, b) => {
        let r;
        if (o.t) r = b.st.mtimeMs - a.st.mtimeMs;
        else if (o.S) r = b.st.size - a.st.size;
        else r = a.name.localeCompare(b.name, 'en');
        return o.r ? -r : r;
      };
      items.sort(cmp);
      if (header) c.out(`${path}:\n`);
      if (long) {
        const total = items.reduce((s, x) => s + Math.ceil(x.st.size / 1024), 0);
        c.out(`total ${total}\n`);
        for (const x of items) {
          const owner = numeric ? x.st.uid : (kernel.userByUid(x.st.uid)?.name || String(x.st.uid));
          const group = numeric ? x.st.gid : (kernel.groupByGid(x.st.gid)?.name || String(x.st.gid));
          const size = human ? humanSize(x.st.size) : String(x.st.size);
          const name = displayName(join(path, x.name), x.st, x.name);
          c.out(`${showInode ? pad(x.st.ino, 8, true) + ' ' : ''}${modeString(x.st.mode)} ${pad(x.st.nlink, 2)} ${pad(owner, 8)} ${pad(group, 8)} ${pad(size, 8, true)} ${fmtDate(x.st.mtimeMs)} ${name}\n`);
        }
      } else {
        for (const x of items) {
          const name = displayName(join(path, x.name), x.st, x.name);
          c.out(`${showInode ? pad(x.st.ino, 8, true) + ' ' : ''}${name}\n`);
        }
      }
      if (header) c.out('\n');
      if (recursive) {
        for (const x of items) {
          if (!x.st.isDirectory()) continue;
          listDir(join(path, x.name), true);
        }
      }
    };

    for (const operand of operands) {
      const p = ctxPath(c, operand);
      let st;
      try { st = c.vfs.stat(p, creds, { followFinal: false }); }
      catch (e) { exit = reportErr(c, `cannot access '${operand}': ${errnoText(e)}`, 2); continue; }
      let followed = st;
      if (st.isSymbolicLink()) {
        try { followed = c.vfs.stat(p, creds, { followFinal: true }); } catch { followed = st; }
      }
      if (followed.isDirectory() && !dirOnly && !st.isSymbolicLink()) listDir(p, operands.length > 1 || recursive);
      else {
        const name = displayName(p, st, operand);
        if (long) {
          const owner = numeric ? st.uid : (kernel.userByUid(st.uid)?.name || String(st.uid));
          const group = numeric ? st.gid : (kernel.groupByGid(st.gid)?.name || String(st.gid));
          const size = human ? humanSize(st.size) : String(st.size);
          c.out(`${showInode ? pad(st.ino, 8, true) + ' ' : ''}${modeString(st.mode)} ${pad(st.nlink, 2)} ${pad(owner, 8)} ${pad(group, 8)} ${pad(size, 8, true)} ${fmtDate(st.mtimeMs)} ${name}\n`);
        } else c.out(`${showInode ? pad(st.ino, 8, true) + ' ' : ''}${name}\n`);
      }
    }
    return exit;
  });

  reg(ctx, 'cat', 'concatenate files and print on standard output', async (c) => {
    const o = parseOpts(c.args, 'nbsAETv');
    const files = o._;
    let text = '';
    if (!files.length) text = await c.readText();
    else {
      for (const f of files) {
        try { text += new TextDecoder().decode(c.vfs.readFile(ctxPath(c, f), cred(c))); }
        catch (e) { return reportErr(c, `cat: ${f}: ${errnoText(e)}`); }
      }
    }
    if (o.n || o.b || o.s || o.A || o.E || o.T || o.v) {
      let lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      let n = 0;
      const out = [];
      for (let line of lines) {
        if (o.s && line === '' && out[out.length - 1] === '') continue;
        if (o.T || o.v) line = line.replace(/\t/g, '^I').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (ch) => '^' + String.fromCharCode(ch.charCodeAt(0) ^ 0x40));
        if (o.E) line += '$';
        if (o.b) { if (line !== '') { n++; line = pad(n, 6, true) + '\t' + line; } }
        else if (o.n) { n++; line = pad(n, 6, true) + '\t' + line; }
        out.push(line);
      }
      c.out(out.join('\n') + (out.length ? '\n' : ''));
    } else c.out(text);
    return 0;
  });

  reg(ctx, 'tac', 'concatenate and print files in reverse', async (c) => {
    let text = c.args.length ? c.args.map((f) => { try { return readTextFile(c, f); } catch { return ''; } }).join('') : await c.readText();
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    c.out(lines.reverse().join('\n') + (lines.length ? '\n' : ''));
    return 0;
  });

  reg(ctx, 'rev', 'reverse lines characterwise', async (c) => {
    let text = c.args.length ? (() => { try { return readTextFile(c, c.args[0]); } catch { return ''; } })() : await c.readText();
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    c.out(lines.map((l) => [...l].reverse().join('')).join('\n') + (lines.length ? '\n' : ''));
    return 0;
  });

  reg(ctx, 'nl', 'number lines of files', async (c) => {
    const o = parseOpts(c.args, 'b:n:w:s:v:i:', {
      body: 'body:', 'number-format': 'number-format:', width: 'width:', separator: 'separator:',
      'starting-line-number': 'starting-line-number:', 'line-increment': 'line-increment:',
    });
    const text = o._.length ? readTextFile(c, o._[0]) : await c.readText();
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const width = o.w ? Number(o.w) : 6;
    const sep = o.s ?? '\t';
    const fmt = o.n || 'rn';
    const body = o.b || 't';
    let num = o.v ? Number(o.v) : 1;
    const inc = o.i ? Number(o.i) : 1;
    const regex = body.startsWith('p') ? new RegExp(body.slice(1)) : null;
    const out = [];
    for (const l of lines) {
      let numbered;
      if (body === 'a') numbered = true;
      else if (body === 'n') numbered = false;
      else if (regex) numbered = regex.test(l);
      else numbered = l !== '';
      let label;
      if (numbered) {
        const s = String(num);
        num += inc;
        if (fmt === 'ln') label = s.padEnd(width);
        else if (fmt === 'rz') label = s.padStart(width, '0');
        else label = s.padStart(width);
      } else label = '';
      out.push((numbered ? label + sep : '') + l);
    }
    c.out(out.join('\n') + (out.length ? '\n' : ''));
    return 0;
  });

  reg(ctx, 'cp', 'copy files and directories', async (c) => {
    const o = parseOpts(c.args, 'rRfpnavt:T', { recursive: 'r', force: 'f', 'no-clobber': 'n', preserve: 'p', verbose: 'v', 'target-directory': 'target-directory:', 'no-target-directory': 'T', archive: 'a' });
    const recursive = !!(o.r || o.R || o.a);
    const preserve = !!(o.p || o.a);
    if (!o._.length) return reportErr(c, 'cp: missing file operand');
    let sources = o._.slice();
    let dest = o['target-directory'] || sources.pop();
    if (!dest) return reportErr(c, 'cp: missing destination file operand');
    if (!o['target-directory'] && !sources.length) return reportErr(c, 'cp: missing file operand');

    const copyOne = (src, dst) => {
      const st = c.vfs.stat(src, cred(c), { followFinal: false });
      if (st.isDirectory()) {
        if (!recursive) throw new Error('omitting directory');
        try { c.vfs.mkdir(dst, cred(c), st.mode & 0o777); } catch (e) { if (e.code !== 'EEXIST') throw e; }
        for (const [name, node] of c.vfs.readdirNodes(src, cred(c))) {
          if (name === '.' || name === '..') continue;
          copyOne(join(src, name), join(dst, name));
        }
        if (preserve) { try { c.vfs.chmod(dst, st.mode & 0o777, { uid: 0, gid: 0 }); } catch { /* ignore */ } }
      } else if (st.isSymbolicLink()) {
        let target;
        try { target = c.vfs.readlink(src, cred(c)); } catch { target = ''; }
        try { c.vfs.unlink(dst, cred(c)); } catch { /* ignore */ }
        c.vfs.symlink(target, dst, cred(c));
      } else {
        const data = c.vfs.readFile(src, cred(c));
        c.vfs.writeFile(dst, data, cred(c), { mode: preserve ? (st.mode & 0o777) : 0o666 });
        if (preserve) {
          try { c.vfs.chmod(dst, st.mode & 0o777, { uid: 0, gid: 0 }); c.vfs.utimes(dst, new Date(st.atimeMs), new Date(st.mtimeMs), cred(c)); } catch { /* ignore */ }
        }
      }
      if (o.v) c.out(`'${src}' -> '${dst}'\n`);
    };

    let exit = 0;
    for (const srcArg of sources) {
      const src = ctxPath(c, srcArg);
      let st;
      try { st = c.vfs.stat(src, cred(c)); }
      catch (e) { exit = reportErr(c, `cp: cannot stat '${srcArg}': ${errnoText(e)}`); continue; }
      let dst;
      const dstStat = tryStat(c, dest);
      if (dstStat?.isDirectory() && !o.T) dst = join(ctxPath(c, dest), base(src));
      else dst = ctxPath(c, dest);
      if (o.n && c.vfs.exists(dst, cred(c))) continue;
      if (o.f && !o.n) { try { c.vfs.unlink(dst, cred(c)); } catch { /* ignore */ } }
      try { copyOne(src, dst); }
      catch (e) { exit = reportErr(c, `cp: ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'mv', 'move (rename) files', async (c) => {
    const o = parseOpts(c.args, 'fnvt:T', { force: 'f', 'no-clobber': 'n', verbose: 'v', 'target-directory': 'target-directory:', 'no-target-directory': 'T' });
    let sources = o._.slice();
    const dest = o['target-directory'] || sources.pop();
    if (!dest || !sources.length) return reportErr(c, 'mv: missing destination file operand', 1);
    let exit = 0;
    for (const srcArg of sources) {
      const src = ctxPath(c, srcArg);
      let dst = ctxPath(c, dest);
      const dstStat = tryStat(c, dest);
      if (dstStat?.isDirectory()) dst = join(dst, base(src));
      if (o.n && c.vfs.exists(dst, cred(c))) continue;
      try {
        c.vfs.rename(src, dst, cred(c));
        if (o.v) c.out(`renamed '${srcArg}' -> '${dst}'\n`);
      } catch (e) { exit = reportErr(c, `mv: cannot move '${srcArg}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'rm', 'remove files or directories', async (c) => {
    const o = parseOpts(c.args, 'rRfvd', { recursive: 'r', force: 'f', verbose: 'v', directory: 'd' });
    if (!o._.length) return o.f ? 0 : reportErr(c, 'rm: missing operand');
    const rm = (p, argvName) => {
      let st;
      try { st = c.vfs.stat(p, cred(c), { followFinal: false }); }
      catch (e) { if (o.f) return; throw e; }
      if (st.isDirectory()) {
        if (!(o.r || o.R || o.d)) throw new Error('is a directory');
        if (o.r || o.R) {
          for (const [n] of c.vfs.readdirNodes(p, cred(c))) rm(join(p, n), p + '/' + n);
        }
        c.vfs.rmdir(p, cred(c));
      } else c.vfs.unlink(p, cred(c));
      if (o.v) c.out(`removed '${argvName}'\n`);
    };
    let exit = 0;
    for (const arg of o._) {
      if (arg === '/' && (o.r || o.R) && !o.f) { exit = reportErr(c, "rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe"); continue; }
      try { rm(ctxPath(c, arg), arg); }
      catch (e) { if (!o.f) exit = reportErr(c, `rm: cannot remove '${arg}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'mkdir', 'make directories', async (c) => {
    const o = parseOpts(c.args, 'pvm', { parents: 'p', verbose: 'v', mode: 'm' });
    if (!o._.length) return reportErr(c, 'mkdir: missing operand');
    const mode = o.m ? (parseInt(o.m, 8) || 0o755) : 0o777;
    let exit = 0;
    for (const dir of o._) {
      const p = ctxPath(c, dir);
      try {
        if (o.p) c.vfs.mkdirp(p, cred(c), mode);
        else c.vfs.mkdir(p, cred(c), mode);
        if (o.v) c.out(`mkdir: created directory '${dir}'\n`);
      } catch (e) { exit = reportErr(c, `mkdir: cannot create directory '${dir}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'rmdir', 'remove empty directories', async (c) => {
    const o = parseOpts(c.args, 'pv', { parents: 'p', verbose: 'v' });
    let exit = 0;
    for (const dir of o._) {
      const p = ctxPath(c, dir);
      try {
        c.vfs.rmdir(p, cred(c));
        if (o.v) c.out(`rmdir: removing directory, '${dir}'\n`);
        if (o.p) {
          let cur = p;
          for (;;) {
            cur = cur.slice(0, cur.lastIndexOf('/')) || '/';
            if (cur === '/') break;
            try { c.vfs.rmdir(cur, cred(c)); } catch { break; }
          }
        }
      } catch (e) { exit = reportErr(c, `rmdir: failed to remove '${dir}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'touch', 'change file timestamps', async (c) => {
    const o = parseOpts(c.args, 'amct:d:', { 'no-create': 'c', date: 'date:' });
    if (!o._.length) return reportErr(c, 'touch: missing file operand');
    let time = Date.now();
    if (o.t !== undefined && o.t !== true) {
      const s = String(o.t);
      const dot = s.indexOf('.');
      const sec = dot >= 0 ? Number(s.slice(dot + 1)) : 0;
      const rest = dot >= 0 ? s.slice(0, dot) : s;
      let year, month, day, hour, min;
      const now = new Date();
      if (rest.length === 12) {
        year = Number(rest.slice(0, 4)); month = Number(rest.slice(4, 6)) - 1;
        day = Number(rest.slice(6, 8)); hour = Number(rest.slice(8, 10)); min = Number(rest.slice(10, 12));
      } else if (rest.length === 10) {
        let yy = Number(rest.slice(0, 2)); year = yy < 69 ? 2000 + yy : 1900 + yy;
        month = Number(rest.slice(2, 4)) - 1; day = Number(rest.slice(4, 6));
        hour = Number(rest.slice(6, 8)); min = Number(rest.slice(8, 10));
      } else if (rest.length === 8) {
        year = now.getUTCFullYear(); month = Number(rest.slice(0, 2)) - 1;
        day = Number(rest.slice(2, 4)); hour = Number(rest.slice(4, 6)); min = Number(rest.slice(6, 8));
      } else return reportErr(c, `touch: invalid date format '${o.t}'`);
      time = Date.UTC(year, month, day, hour, min, sec);
    } else if (o.d) {
      const t = Date.parse(o.d);
      if (!Number.isNaN(t)) time = t;
      else return reportErr(c, `touch: invalid date format '${o.d}'`);
    }
    let exit = 0;
    for (const f of o._) {
      const p = ctxPath(c, f);
      if (!c.vfs.exists(p, cred(c))) {
        if (o.c) continue;
        try { c.vfs.writeFile(p, '', cred(c), { mode: 0o666 }); }
        catch (e) { exit = reportErr(c, `touch: cannot touch '${f}': ${errnoText(e)}`); continue; }
      }
      try {
        const st = c.vfs.stat(p, cred(c));
        c.vfs.utimes(p, o.m ? new Date(st.atimeMs) : new Date(time), o.a ? new Date(st.mtimeMs) : new Date(time), cred(c));
      } catch (e) { exit = reportErr(c, `touch: setting times of '${f}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'chmod', 'change file mode bits', async (c) => {
    const o = parseOpts(c.args, 'Rvcf', { recursive: 'R', verbose: 'v' });
    if (o._.length < 2) return reportErr(c, 'chmod: missing operand', 1);
    const modeArg = o._.shift();
    const apply = (p) => {
      const st = c.vfs.stat(p, cred(c));
      const mode = applySymbolic(st.mode, modeArg, st.isDirectory());
      c.vfs.chmod(p, mode, cred(c));
      if (o.v) c.out(`mode of '${p}' changed to ${mode.toString(8)}\n`);
    };
    const walk = (p) => {
      const st = c.vfs.stat(p, cred(c), { followFinal: false });
      try { apply(p); } catch (e) { if (!o.f) reportErr(c, `chmod: changing permissions of '${p}': ${errnoText(e)}`); }
      if (o.R && st.isDirectory()) { for (const [n] of c.vfs.readdirNodes(p, cred(c))) walk(join(p, n)); }
    };
    let exit = 0;
    for (const f of o._) { try { walk(ctxPath(c, f)); } catch (e) { exit = reportErr(c, `chmod: cannot access '${f}': ${errnoText(e)}`); } }
    return exit;
  });

  reg(ctx, 'chown', 'change file owner and group', async (c) => {
    const o = parseOpts(c.args, 'Rhv', { recursive: 'R' });
    if (o._.length < 2) return reportErr(c, 'chown: missing operand');
    const spec = o._.shift();
    const [userPart, groupPart] = spec.split(':');
    const uid = userPart ? (kernel.userByName(userPart)?.uid ?? (Number.isNaN(Number(userPart)) ? null : Number(userPart))) : null;
    const gid = groupPart ? (kernel.groupByName(groupPart)?.gid ?? (Number.isNaN(Number(groupPart)) ? null : Number(groupPart))) : null;
    if (userPart && uid === null) return reportErr(c, `chown: invalid user: '${userPart}'`);
    if (groupPart && gid === null) return reportErr(c, `chown: invalid group: '${groupPart}'`);
    const walk = (p) => {
      try {
        c.vfs.chown(p, uid, gid, cred(c));
        if (o.R) {
          const st = c.vfs.stat(p, cred(c), { followFinal: false });
          if (st.isDirectory()) for (const [n] of c.vfs.readdirNodes(p, cred(c))) walk(join(p, n));
        }
      } catch (e) { reportErr(c, `chown: changing ownership of '${p}': ${errnoText(e)}`); }
    };
    for (const f of o._) walk(ctxPath(c, f));
    return 0;
  });
  reg(ctx, 'chgrp', 'change group ownership', async (c) => {
    const o = parseOpts(c.args, 'Rhv', { recursive: 'R' });
    if (o._.length < 2) return reportErr(c, 'chgrp: missing operand');
    const spec = o._.shift();
    const gid = kernel.groupByName(spec)?.gid ?? (Number.isNaN(Number(spec)) ? null : Number(spec));
    if (gid === null) return reportErr(c, `chgrp: invalid group: '${spec}'`);
    let exit = 0;
    const walk = (p) => {
      try {
        c.vfs.chown(p, null, gid, cred(c));
        if (o.R) {
          const st = c.vfs.stat(p, cred(c), { followFinal: false });
          if (st.isDirectory()) for (const [n] of c.vfs.readdirNodes(p, cred(c))) walk(join(p, n));
        }
      } catch (e) { exit = reportErr(c, `chgrp: changing group of '${p}': ${errnoText(e)}`); }
    };
    for (const f of o._) walk(ctxPath(c, f));
    return exit;
  });

  reg(ctx, 'ln', 'make links between files', async (c) => {
    const o = parseOpts(c.args, 'sfvn', { symbolic: 's', force: 'f', verbose: 'v' });
    if (o._.length < 2) return reportErr(c, 'ln: missing file operand');
    const target = o._[0];
    const linkPath = ctxPath(c, o._[1]);
    try {
      if (o.f) { try { c.vfs.unlink(linkPath, cred(c)); } catch { /* ignore */ } }
      if (o.s) c.vfs.symlink(target, linkPath, cred(c));
      else c.vfs.link(ctxPath(c, target), linkPath, cred(c));
      if (o.v) c.out(`'${linkPath}' -> '${target}'\n`);
      return 0;
    } catch (e) { return reportErr(c, `ln: failed to create link '${o._[1]}': ${errnoText(e)}`); }
  });

  reg(ctx, 'unlink', 'call the unlink function', async (c) => {
    if (c.args.length !== 1) return reportErr(c, 'unlink: missing operand');
    try { c.vfs.unlink(ctxPath(c, c.args[0]), cred(c)); return 0; }
    catch (e) { return reportErr(c, `unlink: cannot unlink '${c.args[0]}': ${errnoText(e)}`); }
  });
  reg(ctx, 'link', 'call the link function', async (c) => {
    if (c.args.length !== 2) return reportErr(c, 'link: missing operand');
    try { c.vfs.link(ctxPath(c, c.args[0]), ctxPath(c, c.args[1]), cred(c)); return 0; }
    catch (e) { return reportErr(c, `link: cannot create link: ${errnoText(e)}`); }
  });

  reg(ctx, 'readlink', 'print resolved symbolic links', async (c) => {
    const o = parseOpts(c.args, 'fenm', { canonicalize: 'f', 'canonicalize-existing': 'e' });
    let exit = 0;
    for (const f of o._) {
      const p = ctxPath(c, f);
      try {
        if (o.f || o.e) c.out(c.vfs.realpath(p, cred(c)) + '\n');
        else c.out(c.vfs.readlink(p, cred(c)) + '\n');
      } catch (e) {
        if (o.e) exit = 1;
        else { exit = 1; if (!o.f) c.err(`readlink: ${f}: ${errnoText(e)}\n`); }
      }
    }
    return exit;
  });

  reg(ctx, 'realpath', 'print the resolved absolute file name', async (c) => {
    const o = parseOpts(c.args, '', { 'relative-to': 'relative-to:' });
    let exit = 0;
    for (const f of o._) {
      try { c.out(c.vfs.realpath(ctxPath(c, f), cred(c)) + '\n'); }
      catch (e) { exit = reportErr(c, `realpath: ${f}: ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'basename', 'strip directory and suffix from filenames', async (c) => {
    const o = parseOpts(c.args, 'a', { suffix: ':' });
    const args = o._.slice();
    const suffix = o.suffix || (args.length === 2 && !o.a ? args.pop() : '');
    let exit = 0;
    if (!args.length) return reportErr(c, 'basename: missing operand');
    for (let name of args) {
      name = name.replace(/\/+$/, '') || '/';
      let b = name === '/' ? '/' : name.split('/').pop();
      if (suffix && b !== suffix && b.endsWith(suffix)) b = b.slice(0, -suffix.length);
      c.out(b + '\n');
    }
    return exit;
  });

  reg(ctx, 'dirname', 'strip last component from file name', async (c) => {
    for (const name of c.args) {
      const cleaned = name.replace(/\/+$/, '');
      const idx = cleaned.lastIndexOf('/');
      let d = idx < 0 ? '.' : idx === 0 ? '/' : cleaned.slice(0, idx);
      if (d === '') d = '/';
      c.out(d + '\n');
    }
    return 0;
  });

  reg(ctx, 'stat', 'display file or file system status', async (c) => {
    const o = parseOpts(c.args, 'Lfc:t', { dereference: 'L', format: 'format:', 'file-system': 'f' });
    let exit = 0;
    for (const f of o._) {
      const p = ctxPath(c, f);
      try {
        const st = c.vfs.stat(p, cred(c), { followFinal: !!o.L });
        if (o.c) { c.out(statFormat(o.c, st, f, kernel) + '\n'); continue; }
        c.out(`  File: ${f}\n  Size: ${pad(st.size, 12)}Blocks: ${Math.ceil(st.size / 512)}       IO Block: 4096   regular file\n`);
        c.out(`Device: 1\tInode: ${st.ino}\tLinks: ${st.nlink}\n`);
        c.out(`Access: (${st.mode.toString(8).padStart(4, '0')}/${modeString(st.mode)})  Uid: (${pad(st.uid, 5)})   Gid: (${pad(st.gid, 5)})\n`);
        c.out(`Access: ${new Date(st.atimeMs).toISOString()}\nModify: ${new Date(st.mtimeMs).toISOString()}\nChange: ${new Date(st.ctimeMs).toISOString()}\n Birth: ${new Date(st.birthtimeMs).toISOString()}\n`);
      } catch (e) { exit = reportErr(c, `stat: cannot statx '${f}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(ctx, 'du', 'estimate file space usage', async (c) => {
    const o = parseOpts(c.args, 'ahsck', { all: 'a', summarize: 's', human: 'h', total: 'c', 'max-depth': 'maxdepth:' });
    const maxDepth = o['max-depth'] ? Number(o['max-depth']) : Infinity;
    let grand = 0, exit = 0;
    const walk = (p, depth) => {
      let st;
      try { st = c.vfs.stat(p, cred(c), { followFinal: false }); } catch (e) { exit = reportErr(c, `du: cannot access '${p}': ${errnoText(e)}`); return 0; }
      let size = st.isFile() ? st.size : 4096;
      if (st.isDirectory()) {
        for (const [n] of c.vfs.readdirNodes(p, cred(c))) size += walk(join(p, n), depth + 1);
      } else if (!o.a && depth > 0 && !o.s) return size;
      if (!o.s && depth <= maxDepth) c.out(`${humanSize(size)}\t${p === ctxPath(c, '.') ? '.' : p}\n`);
      return size;
    };
    for (const f of o._.length ? o._ : ['.']) {
      const p = ctxPath(c, f);
      const size = walk(p, 0);
      grand += size;
      if (o.s) c.out(`${humanSize(size)}\t${f}\n`);
    }
    if (o.c) c.out(`${humanSize(grand)}\ttotal\n`);
    return exit;
  });

  reg(ctx, 'df', 'report file system disk space usage', async (c) => {
    const o = parseOpts(c.args, 'ahiTP:', { human: 'h', inodes: 'i', all: 'a', type: 't:', print: 'P' });
    const human = (n) => (o.h ? humanSize(n) : String(Math.ceil(n / 1024)));
    const pct = (used, total) => (total ? `${Math.ceil((used / total) * 100)}%` : '-');
    let mounts = kernel.vfs.mountsList();
    if (!o.a) mounts = mounts.filter((m) => !/^(proc|sysfs|devtmpfs|devpts|securityfs|debugfs|cgroup2?)$/.test(m.fstype));
    if (o.t) {
      const types = String(o.t).split(',').map((s) => s.replace(/^no/, ''));
      mounts = mounts.filter((m) => {
        const neg = String(o.t).split(',').every((s) => s.startsWith('no'));
        return neg ? !types.includes(m.fstype) : types.includes(m.fstype);
      });
    }
    if (o._.length) {
      const picked = new Map();
      for (const p of o._) {
        const m = kernel.vfs.mountFor(p, c.cred());
        if (m) picked.set(m.target, m);
      }
      mounts = [...picked.values()];
    }
    c.out(o.P ? 'Filesystem     Type    1024-blocks    Used Available Capacity Mounted on\n'
      : 'Filesystem      Type  Size  Used Avail Use% Mounted on\n');
    for (const m of mounts) {
      let fs;
      try { fs = kernel.vfs.statfs(m.target, c.cred()); } catch { continue; }
      const total = fs.blocks * fs.bsize;
      const avail = fs.bfree * fs.bsize;
      const used = Math.max(0, total - avail);
      if (o.i) {
        c.out(`${(m.source || m.fstype).padEnd(14)} ${m.fstype.padEnd(5)} ${String(fs.files).padStart(10)} ${String(fs.files - fs.ffree).padStart(7)} ${String(fs.ffree).padStart(9)} ${pct(fs.files - fs.ffree, fs.files).padStart(4)} ${m.target}\n`);
      } else {
        c.out(`${(m.source || m.fstype).padEnd(14)} ${m.fstype.padEnd(5)} ${human(total).padStart(5)} ${human(used).padStart(5)} ${human(avail).padStart(5)} ${pct(used, total).padStart(4)} ${m.target}\n`);
      }
    }
    return 0;
  });

  reg(ctx, 'truncate', 'shrink or extend the size of a file', async (c) => {
    const o = parseOpts(c.args, 'cs:r:', { size: 'size:', reference: 'reference:' });
    if (!o.s && !o.r) return reportErr(c, 'truncate: you must specify either --size or --reference');
    const size = o.s ? parseSize(o.s.replace(/^[+]/, '')) : 0;
    for (const f of o._) {
      try {
        if (!c.vfs.exists(ctxPath(c, f), cred(c))) c.vfs.writeFile(ctxPath(c, f), '', cred(c), {});
        c.vfs.truncate(ctxPath(c, f), size, cred(c));
      } catch (e) { return reportErr(c, `truncate: cannot open '${f}' for writing: ${errnoText(e)}`); }
    }
    return 0;
  });

  reg(ctx, 'mktemp', 'create a temporary file or directory', async (c) => {
    const o = parseOpts(c.args, 'dqt:p:', { directory: 'd', quiet: 'q', tmpdir: 't', 'tmpdir-path': 'p' });
    let template = o._[0] || 'tmp.XXXXXX';
    let dir = '/tmp';
    if (o.p) dir = o.p;
    if (template.includes('/')) { const i = template.lastIndexOf('/'); dir = template.slice(0, i) || '/'; template = template.slice(i + 1); }
    let name;
    for (let attempt = 0; attempt < 100; attempt++) {
      name = makeTempName(c, template, dir);
      if (!c.vfs.exists(name, cred(c))) break;
    }
    try {
      if (o.d) c.vfs.mkdir(name, cred(c), 0o700);
      else c.vfs.writeFile(name, '', cred(c), { mode: 0o600 });
      c.out(name + '\n');
      return 0;
    } catch (e) { return reportErr(c, `mktemp: failed to create ${o.d ? 'directory' : 'file'}: ${errnoText(e)}`); }
  });

  reg(ctx, 'mkfifo', 'make FIFOs (named pipes)', async (c) => {
    const o = parseOpts(c.args, 'm:', { mode: 'mode:' });
    for (const f of o._) {
      const p = ctxPath(c, f);
      try {
        const r = c.vfs.resolve(p, cred(c), { allowMissingFinal: true });
        if (r.node) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
        const node = new Inode('fifo', (o.m ? parseInt(o.m, 8) : 0o666) & ~c.vfs.umask);
        node.uid = c.uid; node.gid = c.gid; node.parent = r.parent;
        r.parent.children.set(r.name, node);
      } catch (e) { return reportErr(c, `mkfifo: cannot create fifo '${f}': ${errnoText(e)}`); }
    }
    return 0;
  });

  reg(ctx, 'mknod', 'make block or character special files', async (c) => {
    const o = parseOpts(c.args, 'm:', { mode: 'mode:' });
    if (o._.length < 2) return reportErr(c, 'mknod: missing operand');
    const [name, type] = o._;
    const t = type === 'p' ? 'fifo' : type === 'b' ? 'blk' : 'chr';
    try {
      const r = c.vfs.resolve(ctxPath(c, name), cred(c), { allowMissingFinal: true });
      if (r.node) throw Object.assign(new Error('File exists'), { code: 'EEXIST' });
      const node = new Inode(t, (o.m ? parseInt(o.m, 8) : 0o666) & ~c.vfs.umask);
      node.parent = r.parent; node.uid = c.uid; node.gid = c.gid;
      r.parent.children.set(r.name, node);
      return 0;
    } catch (e) { return reportErr(c, `mknod: ${name}: ${errnoText(e)}`); }
  });

  reg(ctx, 'install', 'copy files and set attributes', async (c) => {
    const o = parseOpts(c.args, 'dDmvo', { directory: 'd', mode: 'm', verbose: 'v' });
    if (o.d) {
      for (const d of o._) {
        try { c.vfs.mkdirp(ctxPath(c, d), cred(c), o.m ? parseInt(o.m, 8) : 0o755); }
        catch (e) { return reportErr(c, `install: cannot create directory '${d}': ${errnoText(e)}`); }
      }
      return 0;
    }
    if (o._.length < 2) return reportErr(c, 'install: missing destination file operand');
    const dest = o._.pop();
    const destStat = tryStat(c, dest);
    for (const src of o._) {
      const target = destStat?.isDirectory() ? join(ctxPath(c, dest), base(src)) : ctxPath(c, dest);
      try {
        c.vfs.writeFile(target, c.vfs.readFile(ctxPath(c, src), cred(c)), cred(c), { mode: o.m ? parseInt(o.m, 8) : 0o755 });
        c.vfs.chmod(target, o.m ? parseInt(o.m, 8) : 0o755, cred(c));
        if (o.v) c.out(`'${src}' -> '${target}'\n`);
      } catch (e) { return reportErr(c, `install: ${errnoText(e)}`); }
    }
    return 0;
  });

  reg(ctx, 'sync', 'flush file system buffers', async () => 0);
  reg(ctx, 'fsync', 'synchronize a file with its storage device', async (c) => { for (const f of c.args) { try { c.vfs.stat(ctxPath(c, f), cred(c)); } catch { return 1; } } return 0; });

  // ---------- text basics ----------
  reg(ctx, 'head', 'output the first part of files', async (c) => {
    const o = parseOpts(c.args, 'n:c:qv', { lines: 'n', bytes: 'c', quiet: 'q', verbose: 'v' });
    const n = Number(o.n ?? 10);
    const files = o._;
    const inputs = files.length ? files.map((f) => ({ name: f, text: (() => { try { return readTextFile(c, f); } catch { return null; } })() })) : [{ name: '-', text: await c.readText() }];
    let exit = 0;
    for (let i = 0; i < inputs.length; i++) {
      const { name, text } = inputs[i];
      if (text === null) { exit = reportErr(c, `head: cannot open '${name}' for reading: No such file or directory`); continue; }
      if (files.length > 1) c.out(`==> ${name} <==\n`);
      if (o.c) c.out(new TextDecoder().decode(new TextEncoder().encode(text).slice(0, Number(o.c)))) ;
      else { const lines = text.split('\n'); const out = lines.slice(0, n).join('\n'); c.out(out + (lines.length > n || (n > 0 && !out.endsWith('\n')) ? '\n' : '')); }
      if (files.length > 1 && i < inputs.length - 1) c.out('\n');
    }
    return exit;
  });

  reg(ctx, 'tail', 'output the last part of files', async (c) => {
    const o = parseOpts(c.args, 'n:c:fqv', { lines: 'n', bytes: 'c', follow: 'f' });
    const n = Number(o.n ?? 10);
    const files = o._;
    const inputs = files.length ? files.map((f) => ({ name: f, text: (() => { try { return readTextFile(c, f); } catch { return null; } })() })) : [{ name: '-', text: await c.readText() }];
    let exit = 0;
    for (let i = 0; i < inputs.length; i++) {
      const { name, text } = inputs[i];
      if (text === null) { exit = reportErr(c, `tail: cannot open '${name}' for reading: No such file or directory`); continue; }
      if (files.length > 1) c.out(`==> ${name} <==\n`);
      if (o.c) c.out(new TextDecoder().decode(new TextEncoder().encode(text).slice(-Number(o.c))));
      else {
        let lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        c.out(lines.slice(-n).join('\n') + (lines.length ? '\n' : ''));
      }
      if (files.length > 1 && i < inputs.length - 1) c.out('\n');
    }
    return exit;
  });

  reg(ctx, 'wc', 'print newline, word, and byte counts', async (c) => {
    const o = parseOpts(c.args, 'lwcmL', { lines: 'l', words: 'w', bytes: 'c', chars: 'm', 'max-line-length': 'L' });
    const files = o._;
    const any = o.l || o.w || o.c || o.m || o.L;
    const show = { l: o.l || !any, w: o.w || !any, c: o.c || !any };
    const counts = (text) => ({
      l: (text.match(/\n/g) || []).length,
      w: (text.trim() ? text.trim().split(/\s+/).length : 0),
      c: new TextEncoder().encode(text).length,
      L: text.split('\n').reduce((m, l) => Math.max(m, [...l].length), 0),
    });
    let exit = 0;
    const inputs = files.length ? files : [null];
    let totals = { l: 0, w: 0, c: 0, L: 0 };
    for (const f of inputs) {
      let text;
      if (f === null) text = await c.readText();
      else { try { text = readTextFile(c, f); } catch { exit = reportErr(c, `wc: ${f}: No such file or directory`); continue; } }
      const n = counts(text);
      for (const k of Object.keys(totals)) totals[k] += n[k];
      const parts = [];
      if (o.l) parts.push(n.l);
      if (o.w) parts.push(n.w);
      if (o.c) parts.push(n.c);
      if (o.m) parts.push(n.c);
      if (o.L) parts.push(n.L);
      const padded = parts.length > 1 || files.length > 1;
      c.out(parts.map((x) => padded ? pad(x, 7, true) : String(x)).join(' ') + (f ? ` ${f}` : '') + '\n');
    }
    if (files.length > 1) {
      const parts = [];
      if (o.l) parts.push(totals.l);
      if (o.w) parts.push(totals.w);
      if (o.c || o.m) parts.push(o.m ? totals.c : totals.c);
      if (o.L) parts.push(totals.L);
      c.out(parts.map((x) => pad(x, 7, true)).join(' ') + ' total\n');
    }
    return exit;
  });

  reg(ctx, 'seq', 'print a sequence of numbers', async (c) => {
    const o = parseOpts(c.args, 's:w:f:', { separator: 'separator:', format: 'format:' });
    let nums = o._.map(Number);
    let first = 1, step = 1, last;
    if (nums.length === 1) last = nums[0];
    else if (nums.length === 2) { first = nums[0]; last = nums[1]; }
    else if (nums.length >= 3) { first = nums[0]; step = nums[1]; last = nums[2]; }
    else return reportErr(c, 'seq: missing operand');
    if (step === 0) return reportErr(c, 'seq: invalid zero increment value');
    const sep = o.s ?? '\n';
    const parts = [];
    let guard = 0;
    for (let v = first; step > 0 ? v <= last + 1e-9 : v >= last - 1e-9; v += step) {
      if (++guard > 1_000_000) break;
      parts.push(o.f ? printfFormat(o.f, v) : String(Number(v.toFixed(10))));
    }
    c.out(parts.join(sep) + (parts.length ? '\n' : ''));
    return 0;
  });

  reg(ctx, 'yes', 'output a string repeatedly', async (c) => {
    const text = (c.args.length ? c.args.join(' ') : 'y') + '\n';
    for (let i = 0; i < 1_000_000; i++) {
      if (!c.stdout.write(text)) break;
    }
    return 0;
  });

  reg(ctx, 'shuf', 'generate random permutations', async (c) => {
    const o = parseOpts(c.args, 'n:er', { headcount: 'headcount:', echo: 'e' });
    let lines = o.e ? [c.args.filter((a) => !a.startsWith('-')).join(' ')] : (o._.length ? readTextFile(c, o._[0]).split('\n') : (await c.readText()).split('\n'));
    if (lines[lines.length - 1] === '') lines.pop();
    for (let i = lines.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [lines[i], lines[j]] = [lines[j], lines[i]]; }
    if (o.n) lines = lines.slice(0, Number(o.n));
    c.out(lines.join('\n') + (lines.length ? '\n' : ''));
    return 0;
  });

  reg(ctx, 'factor', 'factor numbers', async (c) => {
    const nums = c.args.length ? c.args : (await c.readText()).trim().split(/\s+/).filter(Boolean);
    for (const s of nums) {
      let n = Math.abs(Number(s));
      if (!Number.isInteger(n)) { c.err(`factor: '${s}' is not a valid positive integer\n`); continue; }
      const fs = [];
      for (let d = 2; d * d <= n; d++) while (n % d === 0) { fs.push(d); n /= d; }
      if (n > 1) fs.push(n);
      c.out(`${s}:${fs.length ? ' ' + fs.join(' ') : ''}\n`);
    }
    return 0;
  });

  reg(ctx, 'numfmt', 'convert numbers to human-readable form', async (c) => {
    const o = parseOpts(c.args, 'd:', { 'to': 'to:', from: 'from:' });
    const nums = o._;
    for (const s of nums) c.out(humanSize(Number(s)) + '\n');
    return 0;
  });

  reg(ctx, 'expr', 'evaluate expressions', async (c) => {
    try {
      const res = evalExprArgs(c.args);
      c.out(String(res) + '\n');
      return res === 0 || res === '' || res === '0' ? 1 : 0;
    } catch (e) { return reportErr(c, `expr: ${e.message}`); }
  });

  reg(ctx, 'date', 'print or set the system date and time', async (c) => {
    const o = parseOpts(c.args, 'uRIs:d:r:', { utc: 'u', rfc2822: 'R', 'iso-8601': 'I', date: 'd', reference: 'r' });
    let t = Date.now();
    if (o.d) { const parsed = Date.parse(o.d); if (Number.isNaN(parsed)) return reportErr(c, `date: invalid date '${o.d}'`); t = parsed; }
    const d = new Date(t);
    const useUTC = !!o.u;
    if (o.R) { c.out(d.toUTCString() + '\n'); return 0; }
    if (o.I) { c.out(d.toISOString().replace('.000Z', '+00:00') + '\n'); return 0; }
    const fmt = o._[0];
    if (fmt && fmt.startsWith('+')) { c.out(strftime(fmt.slice(1), d, useUTC) + '\n'); return 0; }
    c.out(d.toUTCString().replace('GMT', 'UTC') + '\n');
    return 0;
  });

  reg(ctx, 'cal', 'display a calendar', async (c) => {
    const now = new Date();
    const month = c.args[0] ? Number(c.args[0]) - 1 : now.getUTCMonth();
    const year = c.args[1] ? Number(c.args[1]) : now.getUTCFullYear();
    c.out(calendar(month, year) + '\n');
    return 0;
  });

  reg(ctx, 'clear', 'clear the terminal screen (no TTY)', async (c) => { c.out('\x1b[2J\x1b[H'); return 0; });
}

/* ------------------------------ helpers ------------------------------ */

function applySymbolic(mode, spec, isDir) {
  if (/^[0-7]+$/.test(spec)) return parseInt(spec, 8);
  let perm = mode & 0o7777;
  for (const clause of spec.split(',')) {
    const m = clause.match(/^([ugoa]*)([+\-=])([rwxXstugo]*)$/);
    if (!m) continue;
    let who = m[1] || 'a';
    if (who === 'a') who = 'ugo';
    const op = m[2];
    let bits = 0;
    for (const p of m[3]) {
      for (const w of who) {
        if (p === 'r') bits |= w === 'u' ? 0o400 : w === 'g' ? 0o40 : 0o4;
        else if (p === 'w') bits |= w === 'u' ? 0o200 : w === 'g' ? 0o20 : 0o2;
        else if (p === 'x' || (p === 'X' && isDir)) bits |= w === 'u' ? 0o100 : w === 'g' ? 0o10 : 0o1;
        else if (p === 's' && w === 'u') bits |= 0o4000;
        else if (p === 's' && w === 'g') bits |= 0o2000;
        else if (p === 't') bits |= 0o1000;
        else if (p === 'u') bits |= ((mode >> 6) & 7) * (w === 'u' ? 0o100 : w === 'g' ? 0o10 : 1);
        else if (p === 'g') bits |= ((mode >> 3) & 7) * (w === 'u' ? 0o100 : w === 'g' ? 0o10 : 1);
        else if (p === 'o') bits |= (mode & 7) * (w === 'u' ? 0o100 : w === 'g' ? 0o10 : 1);
      }
    }
    let mask = 0;
    if (who.includes('u')) mask |= 0o4700;
    if (who.includes('g')) mask |= 0o2070;
    if (who.includes('o')) mask |= 0o1007;
    if (op === '+') perm |= bits;
    else if (op === '-') perm &= ~bits;
    else perm = (perm & ~mask) | (bits & mask);
  }
  return perm;
}

function statFormat(format, st, name, kernel) {
  const mode = st.mode;
  return format.replace(/%([a-zA-Z%])/g, (m, c) => {
    switch (c) {
      case 'n': return name;
      case 'N': return `'${name}'`;
      case 's': return String(st.size);
      case 'F': return st.isDirectory() ? 'directory' : st.isSymbolicLink() ? 'symbolic link' : 'regular file';
      case 'a': return (mode & 0o7777).toString(8);
      case 'A': return modeString(mode);
      case 'f': return (mode & 0o170000).toString(16);
      case 'u': return String(st.uid);
      case 'g': return String(st.gid);
      case 'U': return kernel.userByUid(st.uid)?.name || 'UNKNOWN';
      case 'G': return kernel.groupByGid(st.gid)?.name || 'UNKNOWN';
      case 'i': return String(st.ino);
      case 'h': return String(st.nlink);
      case 'd': return '1';
      case 't': return '0';
      case 'T': return '0';
      case 'Y': return String(Math.floor(st.mtimeMs / 1000));
      case 'y': return new Date(st.mtimeMs).toISOString().replace('T', ' ').replace('Z', ' +0000');
      case 'X': return String(Math.floor(st.atimeMs / 1000));
      case 'x': return new Date(st.atimeMs).toISOString().replace('T', ' ').replace('Z', ' +0000');
      case 'Z': return String(Math.floor(st.ctimeMs / 1000));
      case 'z': return new Date(st.ctimeMs).toISOString().replace('T', ' ').replace('Z', ' +0000');
      case 'b': return String(Math.ceil(st.size / 512));
      case 'B': return '512';
      case '%': return '%';
      default: return m;
    }
  }).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function printfFormat(fmt, value) {
  return fmt.replace(/%[0-9.]*[dfse]/g, (m) => {
    const n = Number(value);
    if (m.includes('f')) return n.toFixed(Number(m.match(/\.(\d+)/)?.[1] || 6));
    if (m.includes('e')) return n.toExponential();
    return String(n);
  });
}

function strftime(fmt, d, utc) {
  const g = (m) => (utc ? d['getUTC' + m]() : d['get' + m]());
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const p2 = (n) => String(n).padStart(2, '0');
  return fmt.replace(/%([a-zA-Z%])/g, (m, c) => {
    switch (c) {
      case 'Y': return String(g('FullYear'));
      case 'y': return p2(g('FullYear') % 100);
      case 'm': return p2(g('Month') + 1);
      case 'd': return p2(g('Date'));
      case 'e': return String(g('Date')).padStart(2, ' ');
      case 'H': return p2(g('Hours'));
      case 'I': return p2(g('Hours') % 12 || 12);
      case 'M': return p2(g('Minutes'));
      case 'S': return p2(g('Seconds'));
      case 'p': return g('Hours') < 12 ? 'AM' : 'PM';
      case 'a': return days[g('Day')].slice(0, 3);
      case 'A': return days[g('Day')];
      case 'b': case 'h': return months[g('Month')].slice(0, 3);
      case 'B': return months[g('Month')];
      case 'j': {
        const start = Date.UTC(g('FullYear'), 0, 1);
        const cur = Date.UTC(g('FullYear'), g('Month'), g('Date'));
        return String(Math.floor((cur - start) / 86400000) + 1).padStart(3, '0');
      }
      case 's': return String(Math.floor(d.getTime() / 1000));
      case 'N': return String(d.getMilliseconds() * 1e6).padStart(9, '0');
      case 'F': return `${g('FullYear')}-${p2(g('Month') + 1)}-${p2(g('Date'))}`;
      case 'T': return `${p2(g('Hours'))}:${p2(g('Minutes'))}:${p2(g('Seconds'))}`;
      case 'R': return `${p2(g('Hours'))}:${p2(g('Minutes'))}`;
      case 'D': return `${p2(g('Month') + 1)}/${p2(g('Date'))}/${p2(g('FullYear') % 100)}`;
      case 'Z': return utc ? 'UTC' : 'UTC';
      case 'z': return '+0000';
      case 'n': return '\n';
      case 't': return '\t';
      case '%': return '%';
      default: return '%' + c;
    }
  });
}

function calendar(month, year) {
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const first = new Date(Date.UTC(year, month, 1));
  const startDay = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  let out = `   ${names[month]} ${year}\nSu Mo Tu We Th Fr Sa\n`;
  let line = '   '.repeat(startDay);
  for (let day = 1; day <= daysInMonth; day++) {
    line += String(day).padStart(2) + ' ';
    if ((startDay + day) % 7 === 0) { out += line.trimEnd() + '\n'; line = ''; }
  }
  if (line) out += line.trimEnd() + '\n';
  return out;
}

function evalExprArgs(args) {
  let i = 0;
  const peek = () => args[i];
  const primary = () => {
    const t = args[i++];
    if (t === '(') { const v = orExpr(); if (args[i] !== ')') throw new Error("syntax error: missing ')'"); i++; return v; }
    if (t === '!') return primary() ? 0 : 1;
    const n = Number(t);
    return Number.isNaN(n) ? t : n;
  };
  const mul = () => {
    let v = primary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = args[i++]; const r = primary();
      v = op === '*' ? v * r : op === '/' ? Math.trunc(v / r) : v % r;
    }
    return v;
  };
  const add = () => {
    let v = mul();
    while (peek() === '+' || peek() === '-') { const op = args[i++]; const r = mul(); v = op === '+' ? v + r : v - r; }
    return v;
  };
  const cmp = () => {
    let v = add();
    while (['=', '==', '!=', '<', '<=', '>', '>='].includes(peek())) {
      const op = args[i++]; const r = add();
      v = op === '=' || op === '==' ? (v == r ? 1 : 0) : op === '!=' ? (v != r ? 1 : 0)
        : op === '<' ? (v < r ? 1 : 0) : op === '<=' ? (v <= r ? 1 : 0) : op === '>' ? (v > r ? 1 : 0) : (v >= r ? 1 : 0);
    }
    return v;
  };
  const andExpr = () => { let v = cmp(); while (peek() === '&') { i++; const r = cmp(); v = v && r ? v : 0; } return v; };
  const orExpr = () => { let v = andExpr(); while (peek() === '|') { i++; const r = andExpr(); v = v || r ? v : 0; } return v; };
  const v = orExpr();
  if (i !== args.length) throw new Error('syntax error: unexpected argument');
  return v;
}
