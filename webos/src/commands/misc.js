/* Miscellaneous userland commands: shells, file inspectors, paging, network,
   package-manager and toolchain placeholders, encodings and assorted tools. */

import { parseOpts, resolvePath, errnoText, tryStat, humanSize, parseSize } from './util.js';
import { ShellExit } from '../shell/errors.js';

const TEXT = new TextEncoder();
const TD = new TextDecoder();

function reg(kernel, name, summary, run) {
  kernel.registerCommand(name, { summary, run });
}

function reportErr(c, msg, code = 1) {
  c.err(msg.endsWith('\n') ? msg : msg + '\n');
  return code;
}

function limitation(c, name, reason) {
  return reportErr(c, `${name}: ${reason}`, 127);
}

function readFileText(c, p) {
  return TD.decode(c.vfs.readFile(resolvePath(c, p), c.cred()));
}

function writeFileText(c, p, text) {
  c.vfs.writeFile(resolvePath(c, p), text, c.cred());
}

/* ------------------------------- shells ------------------------------- */

function shellCommand(kernel, name, display) {
  reg(kernel, name, `${display} shell`, async (c) => {
    const o = parseOpts(c.args, 'c:seixnvuo:', {});
    if (o.v) {
      c.out(`${display} (WebOS shell) version 5.2.21(1)-release\n`);
      return 0;
    }
    const clone = c.shell.clone();
    clone.uid = c.uid; clone.gid = c.gid; clone.groups = c.groups;
    if (o.e) clone.opts.errexit = true;
    if (o.x) clone.opts.xtrace = true;
    if (o.n) clone.opts.noexec = true;
    if (o.u) clone.opts.nounset = true;
    const io = { stdin: c.stdin, stdout: c.stdout, stderr: c.stderr, proc: c.proc };
    try {
      if (o.c !== undefined) {
        clone.positional = o._.slice();
        clone.argv0 = name;
        return await clone.execSource(o.c, io);
      }
      const script = o._[0];
      if (script) {
        const args = o._.slice(1);
        return await clone.runScript(resolvePath(c, script), args, io, c.env);
      }
      if (o.s || !o.i) {
        const src = await c.readText();
        if (!src.trim() && o.i) {
          c.err(`${name}: interactive shells require a TTY; stdin is empty\n`);
          return 1;
        }
        return await clone.execSource(src, io);
      }
      c.err(`${name}: interactive shells require a TTY, which this environment does not provide\n`);
      return 1;
    } catch (e) {
      if (e instanceof ShellExit) return e.code;
      throw e;
    }
  });
}

/* ---------------------------- file inspection ---------------------------- */

function fileKind(bytes, path) {
  const b = bytes;
  const asc = (s) => String.fromCharCode(...s);
  if (b.length === 0) return 'empty';
  if (b.length >= 4 && b[0] === 0x7f && asc(b.slice(1, 4)) === 'ELF') return 'ELF executable';
  if (b.length >= 2 && b[0] === 0x23 && b[1] === 0x21) return 'script text executable';
  if (b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b) return 'gzip compressed data';
  if (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5) && (b[3] === 4 || b[3] === 6)) return 'Zip archive data';
  if (b.length >= 8 && asc(b.slice(0, 8)) === '\x89PNG\r\n\x1a\n') return 'PNG image data';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'JPEG image data';
  if (b.length >= 4 && asc(b.slice(0, 4)) === '%PDF') return 'PDF document';
  if (b.length >= 5 && asc(b.slice(0, 5)) === 'BZh91') return 'bzip2 compressed data';
  if (b.length >= 6 && asc(b.slice(0, 6)) === '\xfd7zXZ\x00') return 'XZ compressed data';
  if (b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd) return 'Zstandard compressed data';
  if (b.length >= 262 && asc(b.slice(257, 262)) === 'ustar') return 'POSIX tar archive';
  const text = TD.decode(b.slice(0, 4096));
  if (/^\s*[[{]/.test(text)) {
    try { JSON.parse(TD.decode(b)); return 'JSON text data'; } catch { /* not json */ }
  }
  if (/^#!/.test(text)) return 'script text executable';
  if (/[\x00-\x08\x0e-\x1f]/.test(text)) return 'data';
  if (path && /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(path)) return 'image data';
  return 'ASCII text';
}

/* -------------------------------- modal -------------------------------- */

function registerShells(kernel) {
  shellCommand(kernel, 'sh', 'POSIX sh');
  shellCommand(kernel, 'bash', 'GNU bash');
  shellCommand(kernel, 'dash', 'Debian ash');
  shellCommand(kernel, 'zsh', 'Z shell (subset)');
}

export function registerMiscCommands(kernel) {
  registerShells(kernel);
  const c0 = { kernel };

  /* ----------------------------- file utils ----------------------------- */

  reg(kernel, 'file', 'determine file type', async (c) => {
    const o = parseOpts(c.args, 'biL', { brief: 'b', mime: 'mime', dereference: 'L' });
    if (!o._.length) return reportErr(c, 'file: missing file operand');
    const brief = !!o.b;
    let exit = 0;
    for (const f of o._) {
      const p = resolvePath(c, f);
      try {
        const st = c.vfs.stat(p, c.cred(), { followFinal: !!o.L });
        if (st.isDirectory()) { if (!brief) c.out(`${f}: directory\n`); else c.out('directory\n'); continue; }
        if (st.isSymbolicLink()) {
          const t = c.vfs.readlink(p, c.cred());
          if (!brief) c.out(`${f}: symbolic link to ${t}\n`); else c.out('symbolic link\n');
          continue;
        }
        if (st.isFIFO()) { if (!brief) c.out(`${f}: fifo (named pipe)\n`); else c.out('fifo\n'); continue; }
        if (st.isCharacterDevice() || st.isBlockDevice()) {
          if (!brief) c.out(`${f}: character special\n`); else c.out('character special\n');
          continue;
        }
        const bytes = c.vfs.readFile(p, c.cred());
        const kind = fileKind(bytes, f);
        if (o.mime) {
          const mime = kind.includes('ELF') ? 'application/x-executable'
            : kind.includes('gzip') ? 'application/gzip'
              : kind.includes('Zip') ? 'application/zip'
                : kind.includes('PNG') ? 'image/png'
                  : kind.includes('JPEG') ? 'image/jpeg'
                    : kind.includes('PDF') ? 'application/pdf'
                      : kind.includes('JSON') ? 'application/json'
                        : kind === 'empty' ? 'inode/x-empty' : 'text/plain';
          c.out(brief ? `${mime}\n` : `${f}: ${mime}\n`);
        } else c.out(brief ? `${kind}\n` : `${f}: ${kind}\n`);
      } catch (e) { exit = reportErr(c, `file: cannot open '${f}': ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(kernel, 'tree', 'list contents of directories in a tree-like format', async (c) => {
    const o = parseOpts(c.args, 'adfL:hs', { all: 'a', dirs: 'd', full: 'f', level: 'level:', human: 'h', 'no-report': 'noreport' });
    const root = o._[0] || '.';
    const maxDepth = o.level ? Number(o.level) : Infinity;
    const dirsOnly = !!o.d;
    let dirs = 0, files = 0;
    const lines = [];
    const walk = (p, prefix, depth) => {
      let entries;
      try { entries = [...c.vfs.readdirNodes(p, c.cred())]; }
      catch (e) { c.err(`tree: ${errnoText(e)}\n`); return; }
      entries = entries.filter(([n, node]) => {
        if (!o.a && n.startsWith('.')) return false;
        if (dirsOnly && !c.vfs.statObj(node).isDirectory()) return false;
        return true;
      }).sort((a, b) => a[0].localeCompare(b[0], 'en'));
      entries.forEach(([n, node], idx) => {
        const last = idx === entries.length - 1;
        const st = c.vfs.statObj(node);
        const full = `${p === '/' ? '' : p}/${n}`;
        let label = o.full ? full : n;
        if (o.h && st.size) label += `  [${humanSize(st.size)}]`;
        lines.push(`${prefix}${last ? '└── ' : '├── '}${label}`);
        if (st.isDirectory()) {
          dirs++;
          if (depth + 1 < maxDepth) walk(full === '' ? '/' + n : full, prefix + (last ? '    ' : '│   '), depth + 1);
        } else files++;
      });
    };
    let st;
    try { st = c.vfs.stat(resolvePath(c, root), c.cred()); }
    catch (e) { return reportErr(c, `tree: ${root}: ${errnoText(e)}`); }
    if (!st.isDirectory()) { c.out(`${root}\n`); return 0; }
    const abs = resolvePath(c, root);
    c.out(`${abs}\n`);
    walk(abs, '', 0);
    for (const l of lines) c.out(l + '\n');
    if (!o.noreport) c.out(`\n${dirs} directories, ${files} files\n`);
    return 0;
  });

  reg(kernel, 'less', 'page through text (no TTY: passes through)', async (c) => {
    const o = parseOpts(c.args, 'N:');
    if (o._.length) {
      let exit = 0;
      for (const f of o._) {
        try { c.out(readFileText(c, f)); } catch (e) { exit = reportErr(c, `less: ${f}: ${errnoText(e)}`); }
      }
      return exit;
    }
    c.out(await c.readText());
    return 0;
  });

  reg(kernel, 'more', 'page through text (no TTY: passes through)', async (c) => {
    if (c.args.length) {
      let exit = 0;
      for (const f of c.args) {
        try { c.out(readFileText(c, f)); } catch (e) { exit = reportErr(c, `more: ${f}: ${errnoText(e)}`); }
      }
      return exit;
    }
    c.out(await c.readText());
    return 0;
  });

  reg(kernel, 'man', 'display manual pages (generated from command summaries)', async (c) => {
    const o = parseOpts(c.args, 'kafw', { whatis: 'w', apropos: 'k', all: 'a' });
    if (o.w || o.k) {
      const term = o._[0] || '';
      const hits = [...kernel.commands.entries()].filter(([n, d]) => n.includes(term) || (d.summary || '').toLowerCase().includes(term.toLowerCase()));
      for (const [n, d] of hits) c.out(`${n} - ${d.summary || '(no description)'}\n`);
      return hits.length ? 0 : 1;
    }
    const name = (o._[0] || '').replace(/\(\d\)$/, '');
    if (!name) return reportErr(c, 'What manual page do you want?');
    const def = kernel.commands.get(name);
    if (!def) return reportErr(c, `No manual entry for ${name}`);
    const upper = name.toUpperCase();
    c.out(`${upper}(1)                   WebOS User Commands                   ${upper}(1)\n\n`);
    c.out(`NAME\n    ${name} - ${def.summary || 'WebOS command'}\n\n`);
    c.out(`SYNOPSIS\n    ${def.usage || name + ' [OPTION]... [FILE]...'}\n\n`);
    c.out(`DESCRIPTION\n    ${def.summary || 'No description available.'}\n`);
    c.out(`    This command is implemented in JavaScript and runs inside the WebOS\n    virtual kernel. Files are accessed through the in-memory VFS.\n\n`);
    c.out(`SEE ALSO\n    help(1), ls(1), sh(1)\n`);
    return 0;
  });
  reg(kernel, 'info', 'read Info documents (delegates to man)', async (c) => {
    const def = kernel.commands.get(c.args[0] || '');
    if (!def) return reportErr(c, `info: No menu item '${c.args[0] || ''}' in node 'Top'`);
    c.out(`${c.args[0]} - ${def.summary}\n\nUse 'man ${c.args[0]}' for the manual page.\n`);
    return 0;
  });
  reg(kernel, 'help', 'list available commands', async (c) => {
    const names = [...kernel.commands.keys()].sort();
    if (c.args.length) {
      const n = c.args[0];
      const d = kernel.commands.get(n);
      if (!d) return reportErr(c, `help: no help topics match '${n}'`);
      c.out(`${n}: ${d.summary}\n`);
      return 0;
    }
    c.out('WebOS shell commands\n\n');
    for (const n of names) c.out(`  ${n.padEnd(16)} ${kernel.commands.get(n).summary || ''}\n`);
    return 0;
  });

  /* -------------------------------- dd --------------------------------- */

  reg(kernel, 'dd', 'convert and copy a file', async (c) => {
    const kv = {};
    for (const a of c.args) {
      const i = a.indexOf('=');
      if (i > 0) kv[a.slice(0, i)] = a.slice(i + 1);
      else kv._ = (kv._ || '') + a;
    }
    const sizeOf = (s, def) => (s ? parseSize(s) : def);
    const bs = sizeOf(kv.bs, 512);
    const count = kv.count !== undefined ? Number(kv.count) : Infinity;
    const skip = sizeOf(kv.skip, 0);
    const seek = sizeOf(kv.seek, 0);
    let input = new Uint8Array(0);
    if (kv.if) {
      try { input = c.vfs.readFile(resolvePath(c, kv.if), c.cred()); }
      catch (e) { return reportErr(c, `dd: failed to open '${kv.if}': ${errnoText(e)}`); }
    } else input = await c.readBytes();
    const slice = input.subarray(Math.min(skip, input.length));
    const take = Number.isFinite(count) ? Math.min(slice.length, count * bs) : slice.length;
    const data = slice.subarray(0, take);
    if (kv.of) {
      const p = resolvePath(c, kv.of);
      try {
        const st = tryStat(c, p);
        const outBytes = seek > 0 ? new Uint8Array(seek + data.length) : data;
        if (st && seek > 0) {
          const old = c.vfs.readFile(p, c.cred());
          if (seek + data.length <= old.length) {
            const merged = old.slice();
            merged.set(data, seek);
            c.vfs.writeFile(p, merged, c.cred());
            return ddReport(c, kv, data.length);
          }
        }
        if (seek > 0) outBytes.set(data, seek);
        c.vfs.writeFile(p, outBytes, c.cred());
      } catch (e) { return reportErr(c, `dd: failed to open '${kv.of}': ${errnoText(e)}`); }
    } else c.stdout.write(data);
    return ddReport(c, kv, data.length);
  });

  reg(kernel, 'shred', 'overwrite a file to hide its contents', async (c) => {
    const o = parseOpts(c.args, 'n:szufv', { iterations: 'n:', size: 's:', zero: 'z', remove: 'u', force: 'f', verbose: 'v' });
    if (!o._.length) return reportErr(c, 'shred: missing file operand');
    let exit = 0;
    for (const f of o._) {
      const p = resolvePath(c, f);
      try {
        const st = c.vfs.stat(p, c.cred());
        let size = st.size;
        if (o.s) size = parseSize(o.s);
        else if (size === 0) size = 4096;
        const rounds = o.n ? Number(o.n) : 3;
        for (let r = 0; r < rounds; r++) {
          const buf = new Uint8Array(Math.min(size, 1 << 22));
          if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(buf);
          else for (let i = 0; i < buf.length; i++) buf[i] = (Math.random() * 256) | 0;
          c.vfs.writeFile(p, buf, c.cred());
        }
        if (o.z) c.vfs.writeFile(p, new Uint8Array(size), c.cred());
        if (o.u) c.vfs.unlink(p, c.cred());
        if (o.v) c.out(`shred: ${f}: passed\n`);
      } catch (e) { exit = reportErr(c, `shred: ${f}: ${errnoText(e)}`); }
    }
    return exit;
  });

  reg(kernel, 'fallocate', 'preallocate or deallocate space to a file', async (c) => {
    const o = parseOpts(c.args, 'l:o:n', { length: 'l:', offset: 'o:', keep: 'k' });
    if (o._.length !== 1) return reportErr(c, 'fallocate: no filename specified');
    if (o.n) return 0;
    const p = resolvePath(c, o._[0]);
    try {
      const size = o.l ? parseSize(o.l) : 0;
      const off = o.o ? parseSize(o.o) : 0;
      const st = tryStat(c, p);
      const old = st ? c.vfs.readFile(p, c.cred()) : new Uint8Array(0);
      const total = Math.max(old.length, off + size);
      const buf = new Uint8Array(total);
      buf.set(old);
      if (!st) c.vfs.writeFile(p, buf, c.cred());
      else c.vfs.truncate(p, total, c.cred());
      return 0;
    } catch (e) { return reportErr(c, `fallocate: ${o._[0]}: ${errnoText(e)}`); }
  });

  /* ------------------------------- terminal ------------------------------ */

  reg(kernel, 'stty', 'change and print terminal line settings', async (c) => {
    if (!c.args.length || c.args.includes('-a') || c.args.includes('--all')) {
      c.out('speed 38400 baud; rows 24; columns 80; line = 0;\n');
      c.out('intr = ^C; quit = ^\\; erase = ^?; kill = ^U; eof = ^D; eol = <undef>;\n');
      c.out('-parenb -parodd cs8 -hupcl -cstopb cread -clocal -crtscts\n');
      c.out('-ignbrk brkint -ignpar -parmrk -inpck -istrip -inlcr -igncr icrnl ixon -ixoff\n');
      c.out('isig icanon iexten echo echoe echok -echonl -noflsh -xcase -tostop -echoprt\n');
      return 0;
    }
    c.err('stty: standard input is not a terminal\n');
    return 1;
  });

  reg(kernel, 'tput', 'initialize a terminal or query terminfo', async (c) => {
    const cmd = c.args[0];
    const caps = {
      clear: '\x1b[H\x1b[2J', reset: '\x1bc', bold: '\x1b[1m', sgr0: '\x1b[0m',
      smso: '\x1b[7m', rmso: '\x1b[0m', smul: '\x1b[4m', rmul: '\x1b[0m',
      setaf: null, setab: null, cup: null, cols: null, lines: null,
    };
    if (cmd === 'cols') { c.out('80\n'); return 0; }
    if (cmd === 'lines') { c.out('24\n'); return 0; }
    if (cmd === 'setaf' || cmd === 'setab') {
      const n = Number(c.args[1] || 0) || 0;
      c.out(`\x1b[${cmd === 'setaf' ? 38 : 48};5;${n}m`);
      return 0;
    }
    if (cmd === 'cup') { c.out(`\x1b[${Number(c.args[1] || 1)};${Number(c.args[2] || 1)}H`); return 0; }
    if (cmd in caps && caps[cmd] != null) { c.out(caps[cmd]); return 0; }
    if (cmd === 'longname') { c.out('WebOS pseudo-terminal\n'); return 0; }
    return reportErr(c, `tput: unknown terminfo capability '${cmd}'`, 2);
  });

  reg(kernel, 'reset', 'reset the terminal (emits escape sequence)', async (c) => {
    c.out('\x1bc');
    return 0;
  });

  reg(kernel, 'logger', 'make entries in the system log', async (c) => {
    const o = parseOpts(c.args, 'st:p:u:', { tag: 't:', priority: 'p:', socket: 'u:' });
    const tag = o.t || 'user';
    const pri = o.p || 'user.notice';
    const msg = o._.length ? o._.join(' ') : (await c.readText()).trim();
    const line = `${new Date().toISOString()} ${c.kernel.hostname} ${tag}: ${msg}\n`;
    try {
      const p = '/var/log/syslog';
      const old = tryStat(c, p) ? readFileText(c, p) : '';
      writeFileText(c, p, old + line);
    } catch { /* logging must not fail */ }
    if (o.s) c.err(line);
    return 0;
  });

  reg(kernel, 'wall', 'write a message to all users', async (c) => {
    const msg = c.args.length ? c.args.join(' ') : await c.readText();
    c.err(`wall: cannot broadcast: this environment has no logged-in TTY sessions\n`);
    if (msg.trim()) c.err(`(message was: ${msg.trim()})\n`);
    return 1;
  });
  reg(kernel, 'write', 'send a message to another user', async (c) => {
    return reportErr(c, 'write: no TTY sessions are available (the WebOS API has no terminal devices)');
  });
  reg(kernel, 'mesg', 'control write access to your terminal', async (c) => {
    return reportErr(c, 'mesg: standard input is not a terminal');
  });

  /* ------------------------------- encoding ------------------------------ */

  reg(kernel, 'locale', 'print locale information', async (c) => {
    if (c.args.includes('-a') || c.args.includes('--all-locales')) {
      c.out('C\nC.utf8\nC.UTF-8\nen_US.utf8\nen_US.UTF-8\nPOSIX\n');
      return 0;
    }
    const l = c.env.LC_ALL || c.env.LANG || 'C.UTF-8';
    c.out(`LANG=${c.env.LANG || l}\nLC_CTYPE="${l}"\nLC_NUMERIC="${l}"\nLC_TIME="${l}"\nLC_COLLATE="${l}"\nLC_MONETARY="${l}"\nLC_MESSAGES="${l}"\nLC_PAPER="${l}"\nLC_NAME="${l}"\nLC_ADDRESS="${l}"\nLC_TELEPHONE="${l}"\nLC_MEASUREMENT="${l}"\nLC_IDENTIFICATION="${l}"\nLC_ALL=\n`);
    return 0;
  });
  reg(kernel, 'localedef', 'compile locale definition files', async (c) => {
    return reportErr(c, 'localedef: locale compilation is not supported in the browser sandbox');
  });

  reg(kernel, 'iconv', 'convert text from one character encoding to another', async (c) => {
    const o = parseOpts(c.args, 'f:t:lco:', { from: 'f:', to: 't:', list: 'l', output: 'o:' });
    if (o.l) {
      c.out('UTF-8 UTF-16 UTF-16LE UTF-16BE UTF-32 UTF-32LE UTF-32BE ISO-8859-1 ASCII WINDOWS-1252\n');
      return 0;
    }
    const from = (o.f || 'UTF-8').toUpperCase();
    const to = (o.t || 'UTF-8').toUpperCase();
    const decodeMap = { 'UTF-8': 'utf-8', UTF8: 'utf-8', ASCII: 'ascii', 'ISO-8859-1': 'latin1', LATIN1: 'latin1', 'WINDOWS-1252': 'windows-1252', CP1252: 'windows-1252', 'UTF-16': 'utf-16le', 'UTF-16LE': 'utf-16le', 'UTF-16BE': 'utf-16be' };
    const fromLabel = decodeMap[from];
    if (!fromLabel) return reportErr(c, `iconv: conversion from ${from} is not supported`);
    let input = o._.length ? readFileText(c, o._[0]) : await c.readText();
    let text;
    try {
      if (from === 'UTF-8') text = input;
      else {
        const bytes = o._.length ? c.vfs.readFile(resolvePath(c, o._[0]), c.cred()) : TEXT.encode(input);
        text = new TextDecoder(fromLabel).decode(bytes);
      }
    } catch (e) { return reportErr(c, `iconv: conversion failed: ${e.message}`); }
    let out;
    if (['UTF-8', 'UTF8', 'ASCII'].includes(to)) {
      out = to === 'ASCII' ? text.replace(/[^\x00-\x7f]/g, '?') : text;
    } else if (['ISO-8859-1', 'LATIN1', 'WINDOWS-1252', 'CP1252'].includes(to)) {
      const buf = new Uint8Array(text.length);
      for (let i = 0; i < text.length; i++) {
        const cp = text.codePointAt(i);
        buf[i] = cp <= 0xff ? cp : 0x3f;
      }
      if (o.o) { c.vfs.writeFile(resolvePath(c, o.o), buf, c.cred()); return 0; }
      c.stdout.write(buf);
      return 0;
    } else if (to === 'UTF-16' || to === 'UTF-16LE' || to === 'UTF-16BE') {
      const buf = new Uint8Array(text.length * 2);
      for (let i = 0; i < text.length; i++) {
        const u = text.charCodeAt(i);
        if (to === 'UTF-16BE') { buf[i * 2] = u >> 8; buf[i * 2 + 1] = u & 0xff; }
        else { buf[i * 2] = u & 0xff; buf[i * 2 + 1] = u >> 8; }
      }
      if (o.o) { c.vfs.writeFile(resolvePath(c, o.o), buf, c.cred()); return 0; }
      c.stdout.write(buf);
      return 0;
    } else return reportErr(c, `iconv: conversion to ${to} is not supported`);
    if (o.o) { writeFileText(c, o.o, out); return 0; }
    c.out(out);
    return 0;
  });

  function dosConvert(kernel, name, toUnix) {
    reg(kernel, name, toUnix ? 'convert DOS line endings to Unix' : 'convert Unix line endings to DOS', async (c) => {
      const o = parseOpts(c.args, 'bqkc', { quiet: 'q', keepdate: 'k', 'newfile': 'n', 'oldfile': 'o', 'stdout': 'c' });
      if (!o._.length) return reportErr(c, `${name}: missing file operand`);
      let exit = 0;
      for (const f of o._) {
        const p = resolvePath(c, f);
        try {
          let text = readFileText(c, p);
          text = toUnix ? text.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : text.replace(/\r?\n/g, '\r\n');
          if (o.c) c.out(text);
          else writeFileText(c, p, text);
          if (!o.q) c.out(`${name}: converted '${f}'\n`);
        } catch (e) { exit = reportErr(c, `${name}: ${f}: ${errnoText(e)}`); }
      }
      return exit;
    });
  }
  dosConvert(kernel, 'dos2unix', true);
  dosConvert(kernel, 'unix2dos', false);

  reg(kernel, 'xxd', 'make a hexdump or do the reverse', async (c) => {
    const o = parseOpts(c.args, 'l:s:c:prudg:o:i', {
      length: 'l:', seek: 's:', cols: 'c:', plain: 'p', revert: 'r', uppercase: 'u',
      group: 'g:', offset: 'o:', include: 'i',
    });
    const p = o._[0];
    let bytes;
    try { bytes = p ? c.vfs.readFile(resolvePath(c, p), c.cred()) : await c.readBytes(); }
    catch (e) { return reportErr(c, `xxd: ${p}: ${errnoText(e)}`); }
    if (o.r) {
      const text = TD.decode(bytes);
      const out = [];
      for (const line of text.split('\n')) {
        const m = line.match(/^(?:[0-9a-fA-F]+:\s*)?((?:[0-9a-fA-F]{2,4}\s*)+)/);
        if (!m) continue;
        const hex = m[1].replace(/\s+/g, '');
        for (let i = 0; i + 1 < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
      }
      c.stdout.write(new Uint8Array(out));
      return 0;
    }
    const start = o.s ? (String(o.s).startsWith('0x') ? parseInt(o.s, 16) : parseInt(o.s, 10)) : 0;
    const len = o.l ? parseInt(o.l, 10) : bytes.length;
    const cols = o.c ? parseInt(o.c, 10) : 16;
    const slice = bytes.subarray(Math.max(0, start), Math.max(0, start) + len);
    if (o.p) {
      for (let i = 0; i < slice.length; i++) c.out(slice[i].toString(16).padStart(2, '0'));
      c.out('\n');
      return 0;
    }
    for (let off = 0; off < slice.length; off += cols) {
      const chunk = slice.subarray(off, off + cols);
      const addr = (start + off).toString(16).padStart(8, '0');
      let hex = '', asc = '';
      for (let i = 0; i < cols; i++) {
        if (i < chunk.length) { const h = chunk[i].toString(16).padStart(2, '0'); hex += (o.u ? h.toUpperCase() : h) + (i % 2 === 1 ? ' ' : ''); }
        else hex += '   ';
        if (i < chunk.length) { const ch = chunk[i]; asc += ch >= 32 && ch < 127 ? String.fromCharCode(ch) : '.'; }
        else asc += ' ';
      }
      c.out(`${o.include ? '  ' : ''}${addr}: ${hex} ${asc}\n`);
    }
    return 0;
  });

  reg(kernel, 'pr', 'paginate text for printing', async (c) => {
    const o = parseOpts(c.args, 'h:l:w:dnft', { header: 'h:', length: 'l:', width: 'w:', double: 'd', number: 'n', form: 'f', truncate: 't' });
    const files = o._.length ? o._ : [null];
    const width = o.w ? Number(o.w) : 72;
    const pageLen = o.l ? Number(o.l) : 66;
    let all = '';
    for (const f of files) {
      try { all += f ? readFileText(c, f) : await c.readText(); }
      catch (e) { return reportErr(c, `pr: ${f}: ${errnoText(e)}`); }
    }
    const lines = all.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    const body = Math.max(1, pageLen - 5);
    const pages = Math.max(1, Math.ceil(lines.length / body));
    for (let pg = 0; pg < pages; pg++) {
      if (!o.t) {
        const d = new Date();
        const hdr = o.h ?? (files[0] || '');
        c.out(`\n\n${d.toDateString()} ${String(pg + 1).padStart(2)} ${hdr}\n\n`);
        c.out('\n\n');
      }
      for (let i = 0; i < body; i++) {
        const idx = pg * body + i;
        if (idx >= lines.length) break;
        let line = o.truncate ? lines[idx].slice(0, width) : lines[idx];
        if (o.number) line = String(idx + 1).padStart(5) + '\t' + line;
        c.out(line + '\n');
        if (o.d) c.out('\n');
      }
      if (o.f) c.out('\f');
    }
    return 0;
  });

  /* ------------------------------ networking ----------------------------- */

  async function fetchUrl(c, url, opts = {}) {
    if (typeof globalThis.fetch !== 'function') {
      return { error: 'network access is unavailable: this host has no fetch() implementation' };
    }
    try {
      const res = await globalThis.fetch(url, opts);
      return { res };
    } catch (e) {
      return { error: `network request failed (${e.message}); the browser sandbox blocks raw sockets and most cross-origin requests` };
    }
  }

  reg(kernel, 'curl', 'transfer data from or to a server (fetch-based)', async (c) => {
    const o = parseOpts(c.args, 'o:OsSLX:H:d:iIfkw:', {
      output: 'o:', remote: 'O', silent: 's', 'show-error': 'S', location: 'L',
      request: 'X:', header: 'H:', data: 'd:', include: 'i', head: 'I', fail: 'f',
      insecure: 'k', writeout: 'w:',
    });
    const url = o._[0];
    if (!url) return reportErr(c, 'curl: no URL specified', 2);
    if (!/^https?:\/\//.test(url)) return reportErr(c, `curl: (3) URL rejected: ${url}`);
    const headers = {};
    const hs = Array.isArray(o.H) ? o.H : o.H ? [o.H] : [];
    for (const h of hs) { const i = h.indexOf(':'); if (i > 0) headers[h.slice(0, i).trim()] = h.slice(i + 1).trim(); }
    const method = o.X || (o.I ? 'HEAD' : o.d !== undefined ? 'POST' : 'GET');
    const r = await fetchUrl(c, url, { method, headers, body: o.d, redirect: o.L ? 'follow' : 'manual' });
    if (r.error) return reportErr(c, `curl: (7) ${r.error}`);
    const res = r.res;
    if (o.i || o.I) {
      c.out(`HTTP/${res.type === 'opaque' ? '1.1' : '1.1'} ${res.status} ${res.statusText}\n`);
      for (const [k, v] of res.headers) c.out(`${k}: ${v}\n`);
      c.out('\n');
    }
    if (o.I) return res.ok ? 0 : 22;
    const text = await res.text();
    if (o.w) c.out(o.w.replace('%{http_code}', String(res.status)).replace('%{size_download}', String(text.length)));
    if (o.o) {
      const p = resolvePath(c, o.o);
      try { c.vfs.writeFile(p, text, c.cred()); }
      catch (e) { return reportErr(c, `curl: Failed to open ${o.o}: ${errnoText(e)}`); }
      return res.ok ? 0 : 22;
    }
    if (o.O) {
      const name = url.split('/').filter(Boolean).pop() || 'index.html';
      try { writeFileText(c, name, text); } catch (e) { return reportErr(c, `curl: ${errnoText(e)}`); }
      return res.ok ? 0 : 22;
    }
    c.out(text);
    return res.ok || !o.f ? 0 : 22;
  });

  reg(kernel, 'wget', 'retrieve files via HTTP(S) (fetch-based)', async (c) => {
    const o = parseOpts(c.args, 'O:qcv', { output: 'O:', quiet: 'q', 'no-clobber': 'n', verbose: 'v' });
    const url = o._[0];
    if (!url) return reportErr(c, 'wget: missing URL', 2);
    const r = await fetchUrl(c, url);
    if (r.error) return reportErr(c, `wget: ${r.error}`, 4);
    const res = r.res;
    if (!res.ok) return reportErr(c, `wget: server returned error ${res.status} ${res.statusText}`, 8);
    const data = new Uint8Array(await res.arrayBuffer());
    const name = o.O || url.split('/').filter(Boolean).pop()?.split('?')[0] || 'index.html';
    if (o.O === '-') { c.stdout.write(data); return 0; }
    try {
      c.vfs.writeFile(resolvePath(c, name), data, c.cred());
      if (!o.q) c.err(`saved '${name}' [${data.length} bytes]\n`);
      return 0;
    } catch (e) { return reportErr(c, `wget: ${name}: ${errnoText(e)}`, 3); }
  });

  reg(kernel, 'ping', 'send ICMP ECHO_REQUEST (loopback simulated)', async (c) => {
    const o = parseOpts(c.args, 'c:i:W:s:q46', { count: 'c:', interval: 'i:', timeout: 'W:', quiet: 'q' });
    const host = o._[0];
    if (!host) return reportErr(c, 'ping: usage error: Destination address required', 2);
    const count = o.c ? Number(o.c) : 4;
    const loop = ['localhost', '127.0.0.1', '::1', c.kernel.hostname].includes(host);
    if (!loop) {
      return reportErr(c, `ping: ${host}: Network is unreachable (the browser sandbox has no raw ICMP sockets)`);
    }
    if (!o.q) c.out(`PING ${host} (127.0.0.1) 56(84) bytes of data.\n`);
    for (let i = 0; i < count; i++) {
      if (!o.q) c.out(`64 bytes from 127.0.0.1: icmp_seq=${i + 1} ttl=64 time=0.0${Math.floor(Math.random() * 9) + 1} ms\n`);
    }
    c.out(`\n--- ${host} ping statistics ---\n${count} packets transmitted, ${count} received, 0% packet loss, time ${Math.max(1, count - 1) * 1000}ms\n`);
    c.out('rtt min/avg/max/mdev = 0.04/0.06/0.09/0.01 ms (simulated loopback)\n');
    return 0;
  });

  reg(kernel, 'ip', 'show / manipulate routing, network devices, interfaces', async (c) => {
    const args = c.args.filter((a) => !a.startsWith('-'));
    const obj = args[0] || 'addr';
    if (obj === 'addr' || obj === 'address' || obj === 'a') {
      c.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN group default qlen 1000\n');
      c.out('    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n');
      c.out('    inet 127.0.0.1/8 scope host lo\n       valid_lft forever preferred_lft forever\n');
      c.out('    inet6 ::1/128 scope host\n       valid_lft forever preferred_lft forever\n');
      return 0;
    }
    if (obj === 'link' || obj === 'l') {
      c.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 qdisc noqueue state UNKNOWN mode DEFAULT group default qlen 1000\n    link/loopback 00:00:00:00:00:00 brd 00:00:00:00:00:00\n');
      return 0;
    }
    if (obj === 'route' || obj === 'r') {
      c.out('127.0.0.0/8 dev lo proto kernel scope link src 127.0.0.1\n');
      return 0;
    }
    if (obj === 'neigh' || obj === 'n') { c.out(''); return 0; }
    if (['add', 'del', 'set', 'flush'].includes(args[1])) {
      return reportErr(c, 'ip: RTNETLINK answers: Operation not permitted (no network namespace in the sandbox)');
    }
    return reportErr(c, `ip: unknown object '${obj}'`, 2);
  });

  reg(kernel, 'ifconfig', 'configure a network interface (read-only)', async (c) => {
    c.out('lo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n');
    c.out('        inet 127.0.0.1  netmask 255.0.0.0\n');
    c.out('        inet6 ::1  prefixlen 128  scopeid 0x10<host>\n');
    c.out('        loop  txqueuelen 1000  (Local Loopback)\n');
    c.out('        RX packets 0  bytes 0 (0.0 B)\n        TX packets 0  bytes 0 (0.0 B)\n');
    if (c.args.length) c.err('ifconfig: changing interface state is not permitted in the sandbox\n');
    return 0;
  });
  reg(kernel, 'route', 'show / manipulate the IP routing table', async (c) => {
    c.out('Kernel IP routing table\nDestination     Gateway         Genmask         Flags Metric Ref    Use Iface\n');
    c.out('127.0.0.0       0.0.0.0         255.0.0.0       U     0      0        0 lo\n');
    return 0;
  });
  reg(kernel, 'arp', 'manipulate the ARP cache', async (c) => {
    if (c.args.includes('-n') || !c.args.length) c.out('Address                  HWtype  HWaddress           Flags Mask            Iface\n');
    return 0;
  });
  reg(kernel, 'netstat', 'print network connections, routing tables, statistics', async (c) => {
    const listening = c.args.includes('-l');
    if (c.args.includes('-r')) { c.out('Kernel IP routing table\nDestination     Gateway         Genmask         Flags   MSS Window  irtt Iface\n127.0.0.0       0.0.0.0         255.0.0.0       U         0 0          0 lo\n'); return 0; }
    if (listening) { c.out('Active Internet connections (only servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State\n'); return 0; }
    c.out('Active Internet connections (w/o servers)\nProto Recv-Q Send-Q Local Address           Foreign Address         State\n');
    c.out('Active UNIX domain sockets (w/o servers)\nProto RefCnt Flags       Type       State         I-Node   Path\n');
    return 0;
  });
  reg(kernel, 'ss', 'another utility to investigate sockets', async (c) => {
    if (c.args.includes('-l')) { c.out('State  Recv-Q Send-Q Local Address:Port Peer Address:Port\n'); return 0; }
    c.out('Netid State  Recv-Q Send-Q Local Address:Port  Peer Address:Port\n');
    return 0;
  });
  reg(kernel, 'dig', 'DNS lookup utility', async (c) => {
    const host = c.args.find((a) => !a.startsWith('+') && !a.startsWith('-'));
    if (!host) return reportErr(c, 'dig: missing host', 2);
    if (host === 'localhost') {
      c.out(';; ANSWER SECTION:\nlocalhost.\t0\tIN\tA\t127.0.0.1\n');
      return 0;
    }
    return reportErr(c, `;; communications error to resolver: DNS resolution requires raw UDP sockets, unavailable in the browser sandbox`);
  });
  reg(kernel, 'nslookup', 'query Internet name servers interactively', async (c) => {
    const host = c.args[0];
    if (!host) return reportErr(c, 'nslookup: missing host');
    if (host === 'localhost' || host === c.kernel.hostname) {
      c.out(`Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\nName:\t${host}\nAddress: 127.0.0.1\n`);
      return 0;
    }
    return reportErr(c, '** server can\'t find ' + host + ': SERVFAIL (no raw DNS sockets in the browser sandbox)');
  });
  reg(kernel, 'host', 'DNS lookup utility', async (c) => {
    const h = c.args[0];
    if (!h) return reportErr(c, 'Usage: host [-aCdlnrsTwv] [-c class] [-N ndots] [-t type] name [server]', 1);
    if (h === 'localhost') { c.out('localhost has address 127.0.0.1\n'); return 0; }
    return reportErr(c, `Host ${h} not found: 3(NXDOMAIN) (DNS unavailable in the browser sandbox)`);
  });
  reg(kernel, 'traceroute', 'trace the route to a host', async (c) => {
    return reportErr(c, 'traceroute: raw sockets are not available in the browser sandbox');
  });
  reg(kernel, 'iptables', 'administration tool for IPv4 packet filtering', async (c) => {
    return reportErr(c, 'iptables: Permission denied (netfilter is a kernel facility and is not simulated)', 4);
  });
  for (const n of ['nc', 'ncat', 'telnet', 'ssh', 'scp', 'sftp', 'rsync', 'ftp']) {
    reg(kernel, n, 'network client (unavailable)', async (c) => limitation(c, n, 'raw TCP/UDP sockets are not available in the browser sandbox; only fetch()-based HTTP client commands (curl/wget) work'));
  }
  reg(kernel, 'lsof', 'list open files', async (c) => {
    const o = parseOpts(c.args, 'p:u:i:n', { pid: 'p:', user: 'u:', 'no-dns': 'n' });
    c.out('COMMAND     PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n');
    const procs = o.p ? [c.kernel.getProcess(Number(o.p))].filter(Boolean) : [...c.kernel.procs.values()];
    for (const p of procs) {
      const user = c.kernel.userByUid(p.uid)?.name || String(p.uid);
      let fds = [];
      try { fds = [...c.vfs.readdirNodes(`/proc/${p.pid}/fd`, { uid: 0, gid: 0 })].map(([n]) => n); } catch { fds = ['0', '1', '2']; }
      for (const fd of ['0', '1', '2', ...fds.filter((x) => !['0', '1', '2'].includes(x))]) {
        let target = '';
        try { target = c.vfs.readlink(`/proc/${p.pid}/fd/${fd}`, { uid: 0, gid: 0 }); } catch { target = 'unknown'; }
        c.out(`${(p.name || 'node').padEnd(10)} ${String(p.pid).padStart(5)} ${user.padEnd(6)} ${String(fd).padStart(3)}${fd === '0' || fd === '1' || fd === '2' ? 'u' : 'r'}  CHR  0,0      0t0  ${target}\n`);
      }
    }
    return 0;
  });
  reg(kernel, 'fuser', 'identify processes using files or sockets', async (c) => {
    const o = parseOpts(c.args, 'kumsv', { kill: 'k', 'mount': 'm', user: 'u', silent: 's', verbose: 'v' });
    if (!o._.length) return reportErr(c, 'fuser: missing file operand');
    let found = false;
    for (const f of o._) {
      const p = resolvePath(c, f);
      let target;
      try { target = c.vfs.realpath(p, c.cred()); } catch { target = p; }
      for (const proc of c.kernel.procs.values()) {
        let fds = [];
        try { fds = [...c.vfs.readdirNodes(`/proc/${proc.pid}/fd`, { uid: 0, gid: 0 })]; } catch { continue; }
        for (const [fd] of fds) {
          let l = '';
          try { l = c.vfs.readlink(`/proc/${proc.pid}/fd/${fd}`, { uid: 0, gid: 0 }); } catch { /* ignore */ }
          if (l === target) {
            found = true;
            const user = c.kernel.userByUid(proc.uid)?.name || String(proc.uid);
            c.out(`${p}:${fd}${o.u ? '(' + user + ')' : ''}`);
            if (o.k) { try { c.kernel.kill(proc.pid, 'SIGKILL'); } catch { /* ignore */ } }
          }
        }
      }
    }
    if (found) c.out('\n');
    return found ? 0 : 1;
  });

  /* --------------------------- package managers -------------------------- */

  for (const pm of ['apt', 'apt-get', 'aptitude', 'yum', 'dnf', 'pacman', 'apk', 'zypper', 'snap']) {
    reg(kernel, pm, 'package manager (offline sandbox)', async (c) => {
      if (c.args.some((a) => ['list', '--list', '-l', '-Q', 'list-installed'].includes(a))) {
        c.out('Desired=Unknown/Install/Remove/Purge/Hold\n||/ Name           Version      Architecture Description\n+++-==============-============-============-=================================\nii  webos-core     1.0.0        all          WebOS virtual kernel\nii  node-webos     22.0.0       all          Node.js compatible runtime (JS)\n');
        return 0;
      }
      if (c.args.some((a) => ['update', 'upgrade', 'install', 'remove', 'purge', 'search'].includes(a))) {
        return reportErr(c, `${pm}: unable to access package repositories: the browser sandbox has no system package database or network access to distro mirrors`, 100);
      }
      c.out(`${pm}: WebOS package manager shim (no real package database)\n`);
      return 0;
    });
  }
  reg(kernel, 'dpkg', 'Debian package manager', async (c) => {
    if (c.args.includes('-l') || c.args.includes('--list')) {
      c.out('Desired=Unknown/Install/Remove/Purge/Hold\n||/ Name           Version      Architecture Description\n+++-==============-============-============-=================================\nii  webos-core     1.0.0        all          WebOS virtual kernel\n');
      return 0;
    }
    if (c.args.includes('-i') || c.args.includes('--install')) return reportErr(c, 'dpkg: cannot install packages: .deb archives require maintainer scripts and a native root filesystem', 2);
    if (c.args.includes('-L')) return reportErr(c, `dpkg-query: package '${c.args[c.args.indexOf('-L') + 1] || ''}' is not installed`, 1);
    return reportErr(c, 'dpkg: error: package operations are not supported in the browser sandbox', 2);
  });

  /* ---------------------------- toolchain limits ------------------------- */

  const toolLimits = {
    gcc: 'cannot execute native toolchains in the browser sandbox (no ELF loader, no system headers)',
    cc: 'cannot execute native toolchains in the browser sandbox (no ELF loader, no system headers)',
    clang: 'cannot execute native toolchains in the browser sandbox (no ELF loader, no system headers)',
    g: 'no C compiler is available in the browser sandbox',
    'g++': 'cannot execute native toolchains in the browser sandbox',
    python: 'no Python interpreter is embedded; only JavaScript runs in this environment',
    python3: 'no Python interpreter is embedded; only JavaScript runs in this environment',
    perl: 'no Perl interpreter is embedded; only JavaScript runs in this environment',
    ruby: 'no Ruby interpreter is embedded; only JavaScript runs in this environment',
    php: 'no PHP interpreter is embedded; only JavaScript runs in this environment',
    java: 'no JVM is embedded; only JavaScript runs in this environment',
    lua: 'no Lua interpreter is embedded; only JavaScript runs in this environment',
    wasmtime: 'no WASM runtime is exposed (the project intentionally avoids WASM)',
    ld: 'no native linker is available in the browser sandbox',
    as: 'no native assembler is available in the browser sandbox',
    objdump: 'cannot disassemble ELF files: no native binary parser is available',
    readelf: 'cannot read ELF files: no native binary parser is available',
    nm: 'cannot inspect native symbols: no ELF parser is available',
    ldd: 'cannot inspect dynamic libraries: no ELF parser or native loader is available',
    strace: 'ptrace is not available in the browser sandbox',
    ltrace: 'ptrace is not available in the browser sandbox',
    gdb: 'ptrace/debug registers are not available in the browser sandbox',
    valgrind: 'no native code execution, so Valgrind cannot run',
    perf: 'hardware performance counters are not exposed to the browser',
    'systemd-analyze': 'systemd is not running; timings are unavailable (systemctl is a simulation)',
  };
  for (const [n, reason] of Object.entries(toolLimits)) {
    reg(kernel, n, 'unavailable tool', async (c) => limitation(c, n, reason));
  }

  reg(kernel, 'make', 'GNU make (simple Makefile interpreter)', async (c) => {
    const o = parseOpts(c.args, 'f:nj:B:C:', { file: 'f:', 'no-execute': 'n', jobs: 'j:', directory: 'C:' });
    let cwd = o.C ? resolvePath(c, o.C) : c.cwd;
    const file = o.f || 'Makefile';
    const path = (cwd === '/' ? '' : cwd) + '/' + file;
    let text;
    try { text = TD.decode(c.vfs.readFile(path, c.cred())); }
    catch { return reportErr(c, `make: ${file}: No such file or directory`, 2); }
    const vars = { ...c.env };
    const targets = new Map();
    let current = null;
    for (const raw of text.split('\n')) {
      if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
      const assign = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*([:+?]?=)\s*(.*)$/);
      if (assign && !raw.startsWith('\t')) { vars[assign[1]] = assign[3]; continue; }
      const rule = raw.match(/^([^:=\t]+):\s*(.*)$/);
      if (rule) {
        current = rule[1].trim().split(/\s+/)[0];
        targets.set(current, { deps: rule[2].trim() ? rule[2].trim().split(/\s+/) : [], recipe: [] });
        continue;
      }
      if (raw.startsWith('\t') && current) targets.get(current).recipe.push(raw.slice(1));
    }
    const expand = (s, target, deps) => s
      .replace(/\$\(([A-Za-z_][A-Za-z0-9_]*)\)/g, (m, v) => vars[v] ?? '')
      .replace(/\$@/g, target).replace(/\$\^/g, deps.join(' '));
    const done = new Set();
    const runTarget = async (name, stack = []) => {
      if (done.has(name)) return 0;
      if (stack.includes(name)) { c.err(`make: Circular ${name} <- ${stack.join(' <- ')} dependency dropped.\n`); return 0; }
      const t = targets.get(name);
      if (!t) {
        const st = tryStat(c, (cwd === '/' ? '' : cwd) + '/' + name);
        if (st) return 0;
        c.err(`make: *** No rule to make target '${name}'.  Stop.\n`);
        return 2;
      }
      for (const d of t.deps) {
        const code = await runTarget(d, [...stack, name]);
        if (code !== 0) return code;
      }
      for (const line of t.recipe) {
        const cmd = expand(line, name, t.deps);
        if (!cmd) continue;
        if (o.n) { c.out(cmd + '\n'); continue; }
        const sh = c.shell.clone();
        sh.cwd = cwd;
        const res = sh.startSession(cmd, { proc: c.proc, stdin: null, stdout: c.stdout, stderr: c.stderr });
        const r = await res.done;
        if (r.code) return r.code;
      }
      done.add(name);
      return 0;
    };
    const goals = o._.length ? o._ : (targets.has('all') ? ['all'] : [...targets.keys()].slice(0, 1));
    for (const g of goals) { const code = await runTarget(g); if (code) return code; }
    return 0;
  });

  /* --------------------------- partitioning bits ------------------------- */

  reg(kernel, 'chroot', 'run command or shell with special root directory', async (c) => {
    return reportErr(c, 'chroot: cannot change root directory: requires CAP_SYS_CHROOT and real filesystem namespaces, which the browser sandbox does not provide', 125);
  });
  reg(kernel, 'unshare', 'run program with some namespaces unshared', async (c) => {
    return reportErr(c, 'unshare: unshare failed: Operation not permitted (namespaces are not simulated)', 1);
  });
  reg(kernel, 'nsenter', 'run program with namespaces of other processes', async (c) => {
    return reportErr(c, 'nsenter: cannot open /proc/1/ns/mnt: No such file or directory (namespaces are not simulated)', 1);
  });
  reg(kernel, 'lsns', 'list namespaces', async (c) => {
    c.out('        NS TYPE   NPROCS   PID USER COMMAND\n');
    return 0;
  });
  reg(kernel, 'hostnamectl', 'control the system hostname', async (c) => {
    const action = c.args[0];
    if (action === 'set-hostname') {
      if (c.uid !== 0) return reportErr(c, 'hostnamectl: Access denied (requires root)');
      const name = c.args[1];
      if (!name) return reportErr(c, 'hostnamectl: missing hostname');
      c.kernel.hostname = name;
      return 0;
    }
    c.out(` Static hostname: ${c.kernel.hostname}\n       Icon name: computer-vm\n         Chassis: vm\nOperating System: WebOS (browser)\n          Kernel: Linux 6.6.0-webos\n    Architecture: x86-64\n`);
    return 0;
  });
}

function ddReport(c, kv, bytes) {
  if (kv.status === 'none') return 0;
  const bs = kv.bs ? parseSize(kv.bs) : 512;
  const blocks = Math.ceil(bytes / bs) || 0;
  c.err(`${blocks}+0 records in\n${blocks}+0 records out\n${bytes} bytes copied\n`);
  return 0;
}
