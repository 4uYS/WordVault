/* Shell builtins. */

import { decode } from '../kernel/io.js';
import { CommandError, ShellExit, ShellReturn, ShellBreak, ShellContinue } from './errors.js';
import { evaluateTest } from './test-expr.js';
import { evalArithmetic } from './expand.js';
import { SIGNALS, signalNumber, signalName } from '../kernel/process.js';

const ERRNO_TEXT = {
  ENOENT: 'No such file or directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted',
  ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', ELOOP: 'Too many levels of symbolic links',
  ENOSPC: 'No space left on device', EBADF: 'Bad file descriptor', EROFS: 'Read-only file system',
};
export function errnoText(e) {
  if (!e) return 'Unknown error';
  const base = ERRNO_TEXT[e.code] || e.code || e.message;
  return base;
}

function needArgs(argv, min, usage) {
  if (argv.length < min + 1) throw new CommandError(usage || 'missing argument', 2, { usage: true });
}
function shellQuote(s) {
  if (s === '') return "''";
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
function unquoteWord(s) {
  if (s.length >= 2 && ((s[0] === "'" && s.at(-1) === "'") || (s[0] === '"' && s.at(-1) === '"'))) return s.slice(1, -1);
  return s;
}
function parseAssign(arg) {
  const m = arg.match(/^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/s);
  return m ? { name: m[1], append: m[2] === '+', value: m[3] } : null;
}

async function takeLine(source, delim = '\n') {
  if (!source._lineState) source._lineState = { buf: '', eof: false };
  const st = source._lineState;
  for (;;) {
    const idx = st.buf.indexOf(delim);
    if (idx >= 0) {
      const line = st.buf.slice(0, idx);
      st.buf = st.buf.slice(idx + delim.length);
      return line;
    }
    if (st.eof) {
      if (st.buf.length) { const line = st.buf; st.buf = ''; return line; }
      return null;
    }
    const chunk = await source.read();
    if (chunk === null) { st.eof = true; continue; }
    st.buf += decode(chunk);
  }
}

function echoEscapes(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== '\\') { out += s[i]; continue; }
    const n = s[i + 1];
    if (n === undefined) { out += '\\'; break; }
    if (n === 'c') return { text: out, stop: true };
    const simple = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
    if (n in simple) { out += simple[n]; i++; continue; }
    if (n === '0') {
      let m = s.slice(i + 2, i + 5).match(/^[0-7]{0,3}/)[0];
      out += String.fromCharCode(parseInt(m || '0', 8));
      i += 1 + m.length; continue;
    }
    if (n === 'x') {
      const m = s.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/);
      if (m) { out += String.fromCharCode(parseInt(m[0], 16)); i += 1 + m[0].length; } else { out += '\\x'; i++; }
      continue;
    }
    if (n === 'u' || n === 'U') {
      const len = n === 'u' ? 4 : 8;
      const m = s.slice(i + 2, i + 2 + len).match(new RegExp(`^[0-9a-fA-F]{1,${len}}`));
      if (m) { out += String.fromCodePoint(parseInt(m[0], 16)); i += 1 + m[0].length; } else { out += '\\' + n; i++; }
      continue;
    }
    out += '\\' + n;
    i++;
  }
  return { text: out, stop: false };
}

function formatPrintf(shell, format, args, out) {
  let ai = 0;
  let res = '';
  const nextArg = () => (args.length ? args[ai++ % args.length] : '');
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c === '\\') {
      const esc = echoEscapes(format.slice(i, i + 10));
      const consumed = esc.text.length ? 0 : 0;
      // decode a single escape sequence precisely
      const n = format[i + 1];
      if (n === 'n') { res += '\n'; i++; continue; }
      if (n === 't') { res += '\t'; i++; continue; }
      if (n === 'r') { res += '\r'; i++; continue; }
      if (n === '\\') { res += '\\'; i++; continue; }
      if (n === '0') {
        const m = format.slice(i + 2, i + 5).match(/^[0-7]{0,3}/)[0];
        res += String.fromCharCode(parseInt(m || '0', 8));
        i += 1 + m.length; continue;
      }
      if (n === 'x') {
        const m = format.slice(i + 2, i + 4).match(/^[0-9a-fA-F]{1,2}/);
        if (m) { res += String.fromCharCode(parseInt(m[0], 16)); i += 1 + m[0].length; continue; }
      }
      res += '\\' + (n ?? '');
      i++;
      continue;
    }
    if (c !== '%') { res += c; continue; }
    if (format[i + 1] === '%') { res += '%'; i++; continue; }
    let j = i + 1;
    let flags = '';
    while ('-+ 0#'.includes(format[j])) { flags += format[j]; j++; }
    let width = '';
    while (/[0-9]/.test(format[j])) { width += format[j]; j++; }
    let prec = null;
    if (format[j] === '.') {
      j++;
      let p = '';
      while (/[0-9]/.test(format[j])) { p += format[j]; j++; }
      prec = p === '' ? 0 : Number(p);
    }
    const spec = format[j];
    if (!spec) { res += '%'; break; }
    i = j;
    const arg = nextArg();
    let text = '';
    let numeric = false;
    switch (spec) {
      case 's': text = String(arg); break;
      case 'b': { const e = echoEscapes(String(arg)); text = e.text; break; }
      case 'c': text = String(arg).slice(0, 1); break;
      case 'd': case 'i': { text = String(Math.trunc(Number(arg) || 0)); numeric = true; break; }
      case 'u': { text = String((Math.trunc(Number(arg) || 0)) >>> 0); numeric = true; break; }
      case 'o': { text = (Math.trunc(Number(arg) || 0)).toString(8); numeric = true; break; }
      case 'x': { text = (Math.trunc(Number(arg) || 0)).toString(16); numeric = true; break; }
      case 'X': { text = (Math.trunc(Number(arg) || 0)).toString(16).toUpperCase(); numeric = true; break; }
      case 'f': case 'F': case 'e': case 'E': case 'g': case 'G': {
        const n = Number(arg) || 0;
        if (spec === 'f' || spec === 'F') text = n.toFixed(prec ?? 6);
        else if (spec === 'e' || spec === 'E') text = n.toExponential(prec ?? 6);
        else text = String(n);
        if (spec === 'E' || spec === 'G') text = text.toUpperCase();
        numeric = true;
        break;
      }
      case 'q': text = shellQuote(String(arg)); break;
      default: text = '%' + spec;
    }
    if (numeric && prec != null && spec !== 'f' && spec !== 'e' && spec !== 'E') {
      const neg = text.startsWith('-');
      const digits = neg ? text.slice(1) : text;
      text = (neg ? '-' : '') + digits.padStart(prec, '0');
    } else if (!numeric && prec != null) text = text.slice(0, prec);
    if (width) {
      const w = Number(width);
      if (text.length < w) {
        const pad = (flags.includes('0') && numeric && !flags.includes('-')) ? '0' : ' ';
        if (flags.includes('-')) text = text.padEnd(w, ' ');
        else if (pad === '0' && /^[-+]?/.test(text)) {
          const sign = /^[-+]/.test(text) ? text[0] : '';
          const body = sign ? text.slice(1) : text;
          text = sign + body.padStart(w - sign.length, '0');
        } else text = text.padStart(w, pad);
      }
    }
    res += text;
  }
  out.write(res);
}

/* ------------------------------ builtins ------------------------------ */

export const BUILTINS = {};

function reg(name, fn, summary) { BUILTINS[name] = fn; fn.summary = summary; }

reg(':', async () => 0, 'no-op');
reg('true', async () => 0, 'return success');
reg('false', async () => 1, 'return failure');

reg('echo', async (shell, argv) => {
  let newline = true, interpret = false;
  let i = 1;
  for (; i < argv.length; i++) {
    if (argv[i] === '-n') { newline = false; continue; }
    if (argv[i] === '-e') { interpret = true; continue; }
    if (argv[i] === '-E') { interpret = false; continue; }
    if (/^-[neE]+$/.test(argv[i])) {
      if (argv[i].includes('n')) newline = false;
      if (argv[i].includes('e')) interpret = true;
      if (argv[i].includes('E')) interpret = false;
      continue;
    }
    break;
  }
  let text = argv.slice(i).join(' ');
  if (interpret) {
    const e = echoEscapes(text);
    text = e.text;
    if (e.stop) newline = false;
  }
  shell._io.stdout.write(text + (newline ? '\n' : ''));
  return 0;
}, 'display a line of text');

reg('printf', async (shell, argv) => {
  if (argv.length < 2) throw new CommandError('usage: printf FORMAT [ARGUMENT]...', 2, { usage: true });
  formatPrintf(shell, argv[1], argv.slice(2), shell._io.stdout);
  return 0;
}, 'format and print data');

reg('pwd', async (shell, argv) => {
  const physical = argv.includes('-P');
  let dir = shell.cwd;
  if (physical) {
    try { dir = shell.kernel.vfs.realpath(shell.cwd, shell.cred()); } catch { /* ignore */ }
  }
  shell._io.stdout.write(dir + '\n');
  return 0;
}, 'print working directory');

reg('cd', async (shell, argv) => {
  let target = argv[1];
  if (target === undefined) target = shell.home;
  let print = false;
  if (target === '-') { target = shell.oldpwd; print = true; }
  if (target === '') target = shell.home;
  const path = target.startsWith('/') ? target : `${shell.cwd}/${target}`;
  try {
    const st = shell.kernel.vfs.stat(path, shell.cred());
    if (!st.isDirectory()) throw new CommandError(`${target}: Not a directory`, 1);
  } catch (e) {
    if (e instanceof CommandError) throw e;
    throw new CommandError(`cd: ${target}: ${errnoText(e)}`, 1);
  }
  shell.oldpwd = shell.cwd;
  shell.cwd = shell.kernel.vfs.realpath(path, shell.cred());
  shell.setVar('OLDPWD', shell.oldpwd);
  shell.setVar('PWD', shell.cwd);
  if (shell._io?.proc) shell._io.proc.cwd = shell.cwd;
  if (print) shell._io.stdout.write(shell.cwd + '\n');
  return 0;
}, 'change the working directory');

reg('exit', async (shell, argv) => {
  let code = shell.status;
  if (argv[1] !== undefined) {
    const n = Number(argv[1]);
    if (!Number.isFinite(n)) throw new CommandError(`${argv[1]}: numeric argument required`, 2);
    code = n & 255;
  }
  throw new ShellExit(code);
}, 'exit the shell');

reg('logout', async () => { throw new ShellExit(0); }, 'exit a login shell');

reg('return', async (shell, argv) => {
  const code = argv[1] === undefined ? shell.status : Number(argv[1]) || 0;
  throw new ShellReturn(code & 255);
}, 'return from a function');

reg('break', async (shell, argv) => {
  throw new ShellBreak(Math.max(1, Number(argv[1]) || 1));
}, 'exit a loop');
reg('continue', async (shell, argv) => {
  throw new ShellContinue(Math.max(1, Number(argv[1]) || 1));
}, 'resume next loop iteration');

reg('shift', async (shell, argv) => {
  const n = argv[1] === undefined ? 1 : Number(argv[1]);
  if (!Number.isInteger(n) || n < 0) throw new CommandError(`${argv[1]}: numeric argument required`, 2);
  shell.positional = shell.positional.slice(n);
  return 0;
}, 'shift positional parameters');

reg('export', async (shell, argv) => {
  if (argv.length === 1 || argv[1] === '-p') {
    let out = '';
    for (const name of [...shell.exports].sort()) out += `declare -x ${name}="${shell.getVar(name) ?? ''}"\n`;
    shell._io.stdout.write(out);
    return 0;
  }
  let unexport = false;
  for (const arg of argv.slice(1)) {
    if (arg === '-n') { unexport = true; continue; }
    if (arg === '-f') continue;
    const a = parseAssign(arg);
    if (a) {
      const val = a.append ? (shell.getVar(a.name) || '') + a.value : a.value;
      shell.setVar(a.name, val);
      if (!unexport) shell.exports.add(a.name);
      else shell.exports.delete(a.name);
    } else {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(arg)) throw new CommandError(`\`${arg}': not a valid identifier`, 1);
      if (!unexport) shell.exports.add(arg);
      else shell.exports.delete(arg);
    }
  }
  return 0;
}, 'set export attribute for shell variables');

reg('unset', async (shell, argv) => {
  let func = false;
  for (const arg of argv.slice(1)) {
    if (arg === '-f') { func = true; continue; }
    if (arg === '-v') { func = false; continue; }
    if (func) shell.functions.delete(arg);
    else shell.unsetVar(arg);
  }
  return 0;
}, 'unset values of shell variables');

reg('set', async (shell, argv) => {
  if (argv.length === 1) {
    const names = shell.varNames().sort();
    let out = '';
    for (const n of names) out += `${n}=${shellQuote(shell.getVar(n) ?? '')}\n`;
    shell._io.stdout.write(out);
    return 0;
  }
  let i = 1;
  const opts = { errexit: 'e', nounset: 'u', xtrace: 'x', noclobber: 'C', noglob: 'f', allexport: 'a', noexec: 'n', verbose: 'v', monitor: 'm' };
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { i++; break; }
    if (a === '-o' || a === '+o') {
      const enable = a === '-o';
      const name = argv[i + 1];
      if (!name) {
        let out = '';
        for (const k of Object.keys(shell.opts)) out += `${k}\t${shell.opts[k] ? 'on' : 'off'}\n`;
        shell._io.stdout.write(out);
        return 0;
      }
      if (name === 'pipefail') shell.opts.pipefail = enable;
      else if (name in shell.opts) shell.opts[name] = enable;
      else throw new CommandError(`${name}: invalid option name`, 2);
      i++;
      continue;
    }
    const m = a.match(/^([+-])([a-zA-Z]+)$/);
    if (m) {
      const enable = m[1] === '-';
      for (const ch of m[2]) {
        const key = Object.keys(opts).find((k) => opts[k] === ch);
        if (!key) throw new CommandError(`${ch}: invalid option`, 2);
        shell.opts[key] = enable;
      }
      continue;
    }
    break;
  }
  shell.positional = argv.slice(i);
  return 0;
}, 'set shell options and positional parameters');

reg('shopt', async (shell, argv) => {
  const opts = ['expand_aliases', 'nullglob', 'globstar', 'nocaseglob', 'dotglob', 'lastpipe', 'huponexit', 'histappend'];
  let mode = null;
  const names = [];
  for (const a of argv.slice(1)) {
    if (a === '-s') mode = true;
    else if (a === '-u') mode = false;
    else if (a === '-p') continue;
    else if (!a.startsWith('-')) names.push(a);
  }
  if (!names.length) {
    let out = '';
    for (const o of opts) out += `${o}\t${shell.opts[o] ? 'on' : 'off'}\n`;
    shell._io.stdout.write(out);
    return 0;
  }
  for (const n of names) {
    if (n === 'expand_aliases') continue;
    if (n in shell.opts) shell.opts[n] = mode ?? true;
    else if (mode != null) throw new CommandError(`${n}: invalid shell option name`, 1);
  }
  return 0;
}, 'toggle shell options');

reg('alias', async (shell, argv) => {
  if (argv.length === 1) {
    let out = '';
    for (const [k, v] of [...shell.aliases].sort()) out += `alias ${k}='${v}'\n`;
    shell._io.stdout.write(out);
    return 0;
  }
  for (const a of argv.slice(1)) {
    const eq = a.indexOf('=');
    if (eq < 0) {
      if (shell.aliases.has(a)) shell._io.stdout.write(`alias ${a}='${shell.aliases.get(a)}'\n`);
      else return 1;
    } else {
      shell.aliases.set(a.slice(0, eq), a.slice(eq + 1).replace(/^(['"])(.*)\1$/s, '$2'));
    }
  }
  return 0;
}, 'define or display aliases');

reg('unalias', async (shell, argv) => {
  if (argv[1] === '-a') { shell.aliases.clear(); return 0; }
  for (const a of argv.slice(1)) shell.aliases.delete(a);
  return 0;
}, 'remove alias definitions');

reg('source', async (shell, argv) => {
  const file = argv[1];
  if (!file) throw new CommandError('filename argument required', 2, { usage: true });
  let path = file;
  if (!file.includes('/')) {
    const PATH = (shell.getVar('PATH') || '').split(':');
    const found = PATH.map((d) => `${d}/${file}`).find((p) => shell.kernel.vfs.exists(p, shell.cred()));
    if (found) path = found;
  } else if (!file.startsWith('/')) path = `${shell.cwd}/${file}`;
  let text;
  try { text = decode(shell.kernel.vfs.readFile(path, shell.cred())); }
  catch (e) { throw new CommandError(`${file}: ${errnoText(e)}`, 1); }
  const saved = shell.positional;
  shell.positional = argv.slice(2);
  try {
    return await shell.execSource(text, { ...shell._io });
  } catch (e) {
    if (e instanceof ShellExit) throw e;
    if (e?.name === 'ShellReturn') return e.code;
    throw e;
  } finally { shell.positional = saved; }
}, 'execute commands from a file in the current shell');

BUILTINS['.'] = BUILTINS.source;

reg('eval', async (shell, argv) => {
  return shell.execSource(argv.slice(1).join(' '), { ...shell._io });
}, 'evaluate arguments as shell commands');

reg('exec', async (shell, argv) => {
  if (argv.length === 1) return 0;
  const code = await runWords(shell, argv.slice(1), shell._io, true);
  throw new ShellExit(code);
}, 'replace the shell with a command');

reg('read', async (shell, argv) => {
  let raw = false, silent = false, array = false;
  let prompt = '', nchars = null, delim = '\n';
  let timeout = null;
  let i = 1;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-r') { raw = true; continue; }
    if (a === '-s') { silent = true; continue; }
    if (a === '-a') { array = true; i++; continue; }
    if (a === '-p') { prompt = argv[++i] || ''; continue; }
    if (a === '-n' || a === '-N') { nchars = Number(argv[++i]) || 0; continue; }
    if (a === '-d') { delim = argv[++i] ?? '\n'; if (delim === '') delim = '\0'; continue; }
    if (a === '-t') { timeout = Number(argv[++i]) || 0; continue; }
    break;
  }
  if (prompt) shell._io.stderr.write(prompt);
  const names = argv.slice(i);
  const stdin = shell._io.stdin;
  let line;
  const doRead = async () => {
    if (nchars != null) {
      if (!stdin._charState) stdin._charState = { buf: '', eof: false };
      while (stdin._charState.buf.length < nchars && !stdin._charState.eof) {
        const c = await stdin.read();
        if (c === null) stdin._charState.eof = true; else stdin._charState.buf += decode(c);
      }
      const out = stdin._charState.buf.slice(0, nchars);
      stdin._charState.buf = stdin._charState.buf.slice(nchars);
      return out;
    }
    return takeLine(stdin, delim);
  };
  if (timeout) {
    line = await Promise.race([
      doRead(),
      new Promise((r) => setTimeout(() => r(Symbol.for('timeout')), timeout * 1000)),
    ]);
    if (line === Symbol.for('timeout')) return 1;
  } else line = await doRead();
  if (line === null) return 1;
  if (!raw) {
    while (line.endsWith('\\') && !line.endsWith('\\\\')) {
      const next = await takeLine(stdin, delim);
      if (next === null) break;
      line = line.slice(0, -1) + next;
    }
    line = line.replace(/\\(.)/g, '$1');
  }
  const ifs = shell.getVar('IFS') ?? ' \t\n';
  const fields = line.split(new RegExp(`[${ifs.replace(/[\\\]^]/g, '\\$&')}]+`)).filter((s, idx, arr) => s !== '' || arr.length === 1);
  if (array) {
    shell.setVar(names[0] || 'MAPFILE', line);
  } else if (!names.length) {
    shell.setVar('REPLY', line);
  } else {
    for (let k = 0; k < names.length; k++) {
      if (k === names.length - 1) shell.setVar(names[k], fields.slice(k).join(' '));
      else shell.setVar(names[k], fields[k] ?? '');
    }
  }
  if (silent && shell._io.stdout) { /* tty echo not emulated */ }
  return 0;
}, 'read a line from standard input');

reg('mapfile', async (shell, argv) => {
  let name = 'MAPFILE', count = 0;
  const args = argv.slice(1).filter((a) => !a.startsWith('-'));
  if (args.length) name = args[0];
  const lines = [];
  for (;;) {
    const line = await takeLine(shell._io.stdin, '\n');
    if (line === null) break;
    lines.push(line);
    count++;
  }
  // Arrays are emulated as NUL/newline separated scalars.
  shell.setVar(name, lines.join('\n'));
  shell.setVar(`${name}_COUNT`, String(count));
  return 0;
}, 'read lines into an array variable (scalar emulation)');
BUILTINS.readarray = BUILTINS.mapfile;

reg('test', async (shell, argv) => {
  try {
    return evaluateTest(argv.slice(1), shell) ? 0 : 1;
  } catch (e) {
    shell._io.stderr.write(`test: ${e.message}\n`);
    return 2;
  }
}, 'evaluate conditional expression');
reg('[', async (shell, argv) => {
  if (argv[argv.length - 1] !== ']') {
    shell._io.stderr.write("[: missing `]'\n");
    return 2;
  }
  try {
    return evaluateTest(argv.slice(1, -1), shell) ? 0 : 1;
  } catch (e) {
    shell._io.stderr.write(`[: ${e.message}\n`);
    return 2;
  }
}, 'evaluate conditional expression');

reg('let', async (shell, argv) => {
  let last = 0;
  for (const expr of argv.slice(1)) last = evalArithmetic(expr, shell);
  return last === 0 ? 1 : 0;
}, 'evaluate arithmetic expressions');

reg('umask', async (shell, argv) => {
  if (argv.length === 1 || argv[1] === '-S') {
    const m = shell.umask ?? shell.kernel.vfs.umask;
    shell._io.stdout.write('0' + m.toString(8).padStart(3, '0') + '\n');
    return 0;
  }
  const v = parseInt(argv[1], 8);
  if (Number.isNaN(v)) throw new CommandError(`invalid symbolic mode operator: ${argv[1]}`, 1);
  shell.umask = v & 0o777;
  shell.kernel.vfs.umask = shell.umask;
  return 0;
}, 'set file mode creation mask');

reg('jobs', async (shell, argv) => {
  const long = argv.includes('-l');
  let out = '';
  shell.jobs.forEach((j, idx) => {
    const mark = j.state === 'Done' ? ' ' : '+';
    out += `[${idx + 1}]${mark} ${j.state.padEnd(8)} ${long ? j.pid + ' ' : ''}${j.cmd}\n`;
  });
  shell._io.stdout.write(out);
  return 0;
}, 'list background jobs');

reg('wait', async (shell, argv) => {
  const targets = argv.slice(1);
  let code = 0;
  if (!targets.length) {
    for (const j of shell.jobs) { code = await j.done; }
    return code;
  }
  for (const t of targets) {
    if (t.startsWith('%')) {
      const j = shell.jobs[Number(t.slice(1)) - 1];
      if (j) code = await j.done;
    } else {
      const pid = Number(t);
      const p = shell.kernel.getProcess(pid);
      if (!p) continue;
      if (p.state !== 'Z') await new Promise((res) => p.onExit(res));
      code = p.exitCode ?? 0;
    }
  }
  return code;
}, 'wait for background jobs');

reg('kill', async (shell, argv) => {
  let sig = 'SIGTERM';
  let list = false;
  const targets = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-l') { list = true; continue; }
    if (a === '-s') { sig = argv[++i]; continue; }
    if (a.startsWith('-') && a.length > 1) { sig = a.slice(1); continue; }
    targets.push(a);
  }
  if (list) {
    shell._io.stdout.write(Object.keys(SIGNALS).map((s) => s.slice(3)).join(' ') + '\n');
    return 0;
  }
  let code = 0;
  for (const t of targets) {
    if (t.startsWith('%')) {
      const j = shell.jobs[Number(t.slice(1)) - 1];
      if (j) { j.proc.kill(sig); continue; }
      code = 1; continue;
    }
    const pid = Number(t);
    try { shell.kernel.kill(pid, sig); }
    catch { shell._io.stderr.write(`kill: (${t}) - No such process\n`); code = 1; }
  }
  return code;
}, 'send a signal to a process');

reg('fg', async (shell, argv) => {
  const idx = argv[1] ? Number(argv[1].replace('%', '')) - 1 : shell.jobs.length - 1;
  const j = shell.jobs[idx];
  if (!j) { shell._io.stderr.write('fg: no current job\n'); return 1; }
  shell._io.stdout.write(j.cmd + '\n');
  return await j.done;
}, 'resume a job in the foreground');

reg('bg', async (shell, argv) => {
  const idx = argv[1] ? Number(argv[1].replace('%', '')) - 1 : shell.jobs.length - 1;
  const j = shell.jobs[idx];
  if (!j) { shell._io.stderr.write('bg: no current job\n'); return 1; }
  j.state = 'Running';
  shell._io.stdout.write(`[${idx + 1}]+ ${j.cmd} &\n`);
  return 0;
}, 'resume a job in the background');

reg('disown', async (shell, argv) => {
  if (argv.includes('-a')) shell.jobs.length = 0;
  else {
    const idx = argv[1] ? Number(argv[1].replace('%', '')) - 1 : shell.jobs.length - 1;
    if (idx >= 0) shell.jobs.splice(idx, 1);
  }
  return 0;
}, 'remove jobs from the job table');

reg('trap', async (shell, argv) => {
  if (argv.length === 1 || argv[1] === '-p' || argv[1] === '-l') {
    if (argv[1] === '-l') { shell._io.stdout.write(Object.keys(SIGNALS).map((s) => s.slice(3)).join('\n') + '\n'); return 0; }
    let out = '';
    for (const [k, v] of shell.traps) out += `trap -- '${v}' ${k}\n`;
    shell._io.stdout.write(out);
    return 0;
  }
  const action = argv[1] === '-' ? '' : argv[1];
  for (const sig of argv.slice(2)) {
    const key = sig.toUpperCase().replace(/^SIG/, '');
    if (key === 'EXIT' || key === '0') { if (action) shell.traps.set('EXIT', action); else shell.traps.delete('EXIT'); }
    else if (SIGNALS['SIG' + key]) { if (action) shell.traps.set(key, action); else shell.traps.delete(key); }
    else { shell._io.stderr.write(`trap: ${sig}: invalid signal specification\n`); return 1; }
  }
  return 0;
}, 'set signal handlers');

reg('type', async (shell, argv) => {
  const t = argv.includes('-t');
  const all = argv.includes('-a');
  const names = argv.slice(1).filter((a) => !a.startsWith('-'));
  let code = 0;
  for (const n of names) {
    const kinds = [];
    if (shell.aliases.has(n)) kinds.push(['alias', `alias ${n}='${shell.aliases.get(n)}'`]);
    if (shell.functions.has(n)) kinds.push(['function', n + ' is a function']);
    if (BUILTINS[n]) kinds.push(['builtin', `${n} is a shell builtin`]);
    if (shell.kernel.commands.has(n)) kinds.push(['file', `${n} is ${findCommandPath(shell, n) || '/bin/' + n}`]);
    if (!kinds.length && n.includes('/')) {
      const p = n.startsWith('/') ? n : `${shell.cwd}/${n}`;
      if (shell.kernel.vfs.exists(p, shell.cred())) kinds.push(['file', `${n} is ${p}`]);
    }
    if (!kinds.length) { shell._io.stderr.write(`type: ${n}: not found\n`); code = 1; continue; }
    const shown = all ? kinds : [kinds[0]];
    for (const [kind, text] of shown) shell._io.stdout.write(t ? kind + '\n' : text + '\n');
  }
  return code;
}, 'display how a name would be interpreted');

function findCommandPath(shell, name) {
  const PATH = (shell.getVar('PATH') || '').split(':');
  for (const d of PATH) {
    const p = `${d}/${name}`;
    if (shell.kernel.vfs.exists(p, shell.cred())) return p;
  }
  return null;
}

reg('command', async (shell, argv) => {
  if (argv[1] === '-v' || argv[1] === '-V') {
    let code = 0;
    for (const n of argv.slice(2)) {
      if (shell.aliases.has(n)) shell._io.stdout.write((argv[1] === '-v' ? n : `${n} is an alias for ${shell.aliases.get(n)}`) + '\n');
      else if (shell.functions.has(n)) shell._io.stdout.write((argv[1] === '-v' ? n : `${n} is a function`) + '\n');
      else if (BUILTINS[n]) shell._io.stdout.write((argv[1] === '-v' ? n : `${n} is a shell builtin`) + '\n');
      else {
        const p = findCommandPath(shell, n);
        if (p) shell._io.stdout.write((argv[1] === '-v' ? p : `${n} is ${p}`) + '\n');
        else { code = 1; if (argv[1] === '-V') shell._io.stderr.write(`command: ${n}: not found\n`); }
      }
    }
    return code;
  }
  const rest = argv[1] === '--' ? argv.slice(2) : argv.slice(1);
  if (!rest.length) return 0;
  const saved = shell.functions.get(rest[0]);
  shell.functions.delete(rest[0]);
  try { return await runWords(shell, rest, shell._io, false); }
  finally { if (saved) shell.functions.set(rest[0], saved); }
}, 'execute a command bypassing shell functions');

reg('builtin', async (shell, argv) => {
  const name = argv[1];
  if (!name || !BUILTINS[name]) { shell._io.stderr.write(`builtin: ${name || ''}: not a shell builtin\n`); return 1; }
  return BUILTINS[name](shell, argv.slice(1), shell._io);
}, 'run a shell builtin');

reg('local', async (shell, argv) => {
  if (!shell.scopes.length) throw new CommandError('local: can only be used in a function', 1);
  const scope = shell.scopes[shell.scopes.length - 1];
  for (const a of argv.slice(1)) {
    const m = parseAssign(a);
    if (m) {
      const val = m.append ? (shell.getVar(m.name) || '') + m.value : m.value;
      scope.locals.set(m.name, val);
    } else scope.locals.set(a, shell.getVar(a) ?? '');
  }
  return 0;
}, 'declare local variables');

reg('declare', async (shell, argv) => {
  let exportFlag = false, readonlyFlag = false, print = false;
  const assigns = [];
  for (const a of argv.slice(1)) {
    if (a === '-x') exportFlag = true;
    else if (a === '-r') readonlyFlag = true;
    else if (a === '-p') print = true;
    else if (a.startsWith('-')) continue;
    else assigns.push(a);
  }
  if (!assigns.length || print) {
    let out = '';
    for (const n of shell.varNames().sort()) out += `declare -- ${n}="${shell.getVar(n)}"\n`;
    shell._io.stdout.write(out);
    return 0;
  }
  for (const a of assigns) {
    const m = parseAssign(a);
    const name = m ? m.name : a;
    if (m) shell.setVar(name, m.value);
    if (exportFlag) shell.exports.add(name);
    if (readonlyFlag) (shell.readonly ??= new Set()).add(name);
    if (!m && !shell.hasVar(name)) shell.setVar(name, '');
  }
  return 0;
}, 'declare variables and attributes');
BUILTINS.typeset = BUILTINS.declare;

reg('readonly', async (shell, argv) => {
  shell.readonly ??= new Set();
  for (const a of argv.slice(1)) {
    const m = parseAssign(a);
    if (m) shell.setVar(m.name, m.value);
    shell.readonly.add(m ? m.name : a);
  }
  return 0;
}, 'mark shell variables as readonly');

reg('getopts', async (shell, argv) => {
  const [, optstring, varName, ...explicit] = argv;
  if (!optstring || !varName) throw new CommandError('usage: getopts optstring name [args]', 2, { usage: true });
  const params = explicit.length ? explicit : shell.positional;
  shell._getoptsState ??= { index: 0, sub: 0 };
  const st = shell._getoptsState;
  st.index = Number(shell.getVar('OPTIND') || 1) - 1;
  let silent = false;
  let spec = optstring;
  if (spec.startsWith(':')) { silent = true; spec = spec.slice(1); }
  for (;;) {
    if (st.index >= params.length) { shell.setVar('OPTIND', String(params.length + 1)); return 1; }
    const arg = params[st.index];
    if (!arg.startsWith('-') || arg === '-') { shell.setVar('OPTIND', String(st.index + 1)); return 1; }
    if (arg === '--') { st.index++; shell.setVar('OPTIND', String(st.index + 1)); return 1; }
    const ch = arg[st.sub + 1];
    if (ch === undefined) { st.index++; st.sub = 0; shell.setVar('OPTIND', String(st.index + 1)); continue; }
    st.sub++;
    shell.setVar(varName, ch);
    const pos = spec.indexOf(ch);
    if (pos < 0) {
      shell.setVar('OPTARG', '');
      if (!silent) shell.setVar(varName, '?');
      if (silent) shell.setVar('OPTARG', ch);
      if (st.sub + 1 >= arg.length) { st.index++; st.sub = 0; }
      shell.setVar('OPTIND', String(st.index + 1));
      return silent ? 0 : 0;
    }
    if (spec[pos + 1] === ':') {
      let val;
      if (st.sub + 1 < arg.length) { val = arg.slice(st.sub + 1); st.index++; st.sub = 0; }
      else if (st.index + 1 < params.length) { val = params[st.index + 1]; st.index += 2; st.sub = 0; }
      else {
        st.index++; st.sub = 0;
        if (silent) { shell.setVar('OPTARG', ch); shell.setVar(varName, ':'); }
        else { shell.setVar('OPTARG', ''); shell.setVar(varName, '?'); }
        shell.setVar('OPTIND', String(st.index + 1));
        return 0;
      }
      shell.setVar('OPTARG', val);
      shell.setVar('OPTIND', String(st.index + 1));
      return 0;
    }
    shell.setVar('OPTARG', '');
    if (st.sub + 1 >= arg.length) { st.index++; st.sub = 0; }
    shell.setVar('OPTIND', String(st.index + 1));
    return 0;
  }
}, 'parse positional parameters');

reg('pushd', async (shell, argv) => {
  shell.dirStack ??= [];
  const dir = argv[1] || shell.home;
  const old = shell.cwd;
  try { shell.kernel.vfs.stat(dir.startsWith('/') ? dir : `${shell.cwd}/${dir}`, shell.cred()); }
  catch { shell._io.stderr.write(`pushd: ${dir}: No such file or directory\n`); return 1; }
  shell.dirStack.unshift(old);
  shell.cwd = shell.kernel.vfs.realpath(dir.startsWith('/') ? dir : `${shell.cwd}/${dir}`, shell.cred());
  shell._io.stdout.write([...shell.dirStack, shell.cwd].join(' ') + '\n');
  return 0;
}, 'save directory and change to another');
reg('popd', async (shell) => {
  if (!shell.dirStack?.length) { shell._io.stderr.write('popd: directory stack empty\n'); return 1; }
  shell.cwd = shell.dirStack.shift();
  shell._io.stdout.write([...shell.dirStack, shell.cwd].join(' ') + '\n');
  return 0;
}, 'remove directory from stack and change');
reg('dirs', async (shell, argv) => {
  const stack = shell.dirStack || [];
  const all = argv.includes('-p') || argv.includes('-v');
  shell._io.stdout.write([shell.cwd, ...stack].join('\n') + '\n');
  return 0;
}, 'display directory stack');

reg('hash', async () => 0, 'remember command locations');
reg('help', async (shell, argv) => {
  const names = argv.length > 1 ? argv.slice(1) : Object.keys(BUILTINS).sort();
  let out = '';
  for (const n of names) {
    if (BUILTINS[n]) out += `${n}\t${BUILTINS[n].summary || ''}\n`;
  }
  shell._io.stdout.write(out);
  return 0;
}, 'display information about builtins');
reg('times', async (shell) => {
  shell._io.stdout.write('0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n');
  return 0;
}, 'display process times');
reg('ulimit', async (shell, argv) => {
  if (argv.includes('-a')) {
    shell._io.stdout.write('core file size          (blocks, -c) unlimited\nopen files              (-n) 1048576\nmax user processes      (-u) unlimited\nvirtual memory          (kbytes, -v) unlimited\n');
    return 0;
  }
  shell._io.stdout.write('unlimited\n');
  return 0;
}, 'show resource limits');
reg('history', async () => 0, 'display command history (not recorded)');
reg('suspend', async () => 0, 'suspend shell execution (not supported)');

async function runWords(shell, words, io, bypassFunctions) {
  const ast = {
    type: 'simple',
    words: words.map((w) => ({ parts: [{ t: 'lit', v: w, q: true }], raw: w, quoted: true })),
    assigns: [], redirs: [],
  };
  const saved = bypassFunctions ? shell.functions.get(words[0]) : null;
  if (saved) shell.functions.delete(words[0]);
  try { return await shell.execCommand(ast, io); }
  finally { if (saved) shell.functions.set(words[0], saved); }
}
