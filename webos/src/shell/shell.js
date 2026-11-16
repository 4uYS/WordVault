/* Shell executor: pipelines, redirections, control flow, functions, jobs. */

import { parse, parseQuotedBody } from './parser.js';
import { Expander, ExpansionError, globToRegex } from './expand.js';
import {
  Channel, Source, Sink, sourceFromBytes, sourceFromChannel, sinkFromChannel,
  sinkFromHandle, sourceFromHandle, sinkNull, readText, readAll, decode, toBytes,
} from '../kernel/io.js';
import { O, ErrnoError } from '../kernel/vfs.js';
import { CommandError, ShellExit, ShellReturn, ShellBreak, ShellContinue } from './errors.js';
import { BUILTINS } from './builtins.js';

const OUTFILE = O.WRONLY | O.CREAT;
const MAX_LOOP = 1_000_000;

export class Shell {
  constructor(kernel, opts = {}) {
    this.kernel = kernel;
    this.user = opts.user || 'user';
    const cred = kernel.credentialFor(this.user);
    this.uid = cred.uid; this.gid = cred.gid; this.groups = cred.groups;
    this.home = opts.home || cred.home;
    this.cwd = opts.cwd || this.home;
    this.argv0 = opts.argv0 || 'sh';
    this.positional = (opts.args || []).slice();
    this.aliases = new Map();
    this.functions = new Map();
    this.jobs = [];
    this.nextJob = 1;
    this.scopes = [];
    this.traps = new Map();
    this.status = 0;
    this.lastBg = null;
    this.pid = 0;
    this.ifS = ' \t\n';
    this.opts = {
      errexit: false, nounset: false, xtrace: false, pipefail: false, noclobber: false,
      allexport: false, noglob: false, nullglob: false, globstar: false, verbose: false,
      noexec: false, monitor: !!opts.interactive, interactive: !!opts.interactive,
      ...(opts.options || {}),
    };
    this.vars = new Map();
    this.exports = new Set();
    const env = opts.env || {};
    for (const [k, v] of Object.entries(env)) { this.vars.set(k, String(v)); this.exports.add(k); }
    const defaults = {
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      HOME: this.home, USER: cred.user.name, LOGNAME: cred.user.name,
      SHELL: '/bin/sh', TERM: 'xterm-256color', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8',
      PWD: this.cwd, OLDPWD: this.cwd, SHLVL: '1', HOSTNAME: kernel.hostname,
      IFS: ' \t\n', PS1: '\\u@\\h:\\w\\$ ', PS2: '> ', PS4: '+ ',
    };
    this.oldpwd = this.cwd;
    for (const [k, v] of Object.entries(defaults)) {
      if (!this.vars.has(k)) { this.vars.set(k, v); this.exports.add(k); }
    }
    this.expander = new Expander(this);
    this._io = null;
    this.aborted = false;
  }

  cred() { return { uid: this.uid, gid: this.gid, groups: this.groups, cwd: this.cwd }; }
  getVar(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].locals.has(name)) return this.scopes[i].locals.get(name);
    }
    return this.vars.get(name);
  }
  hasVar(name) { return this.getVar(name) !== undefined; }
  setVar(name, value) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].locals.has(name)) { this.scopes[i].locals.set(name, String(value)); return; }
    }
    this.vars.set(name, String(value));
    if (this.opts.allexport) this.exports.add(name);
  }
  unsetVar(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].locals.has(name)) { this.scopes[i].locals.delete(name); return; }
    this.vars.delete(name); this.exports.delete(name);
  }
  varNames() { return [...this.vars.keys()]; }
  optionFlags() {
    const m = { errexit: 'e', nounset: 'u', xtrace: 'x', pipefail: '', noclobber: 'C', noglob: 'f', allexport: 'a', noexec: 'n', monitor: 'm', verbose: 'v' };
    let s = 'hB';
    for (const [k, v] of Object.entries(m)) if (this.opts[k] && v) s += v;
    return s;
  }

  exportEnv(extra = {}) {
    const env = {};
    for (const [k, v] of this.vars) if (this.exports.has(k) || k === 'PWD' || k === 'SHLVL') env[k] = v;
    env.HOME = this.home;
    env.USER = this.kernel.userByUid(this.uid)?.name || 'user';
    env.LOGNAME = env.USER;
    env.PWD = this.cwd;
    env.OLDPWD = this.oldpwd || this.cwd;
    env.HOSTNAME = this.kernel.hostname;
    return { ...env, ...extra };
  }

  writeStderr(text) {
    if (!text) return;
    if (this._io?.stderr) this._io.stderr.write(text);
  }

  /** Execute a command line, collecting output. */
  async run(src, opts = {}) {
    return this.exec(src, opts);
  }

  async exec(src, opts = {}) {
    const session = this.startSession(src, opts);
    return session.done;
  }

  startSession(src, opts = {}) {
    const outCh = new Channel();
    const errCh = new Channel();
    const stdout = opts.stdout || sinkFromChannel(outCh);
    const stderr = opts.stderr || sinkFromChannel(errCh);
    let stdin;
    if (opts.stdin instanceof Source) stdin = opts.stdin;
    else if (opts.stdin instanceof Channel) stdin = sourceFromChannel(opts.stdin);
    else if (opts.stdin != null) stdin = sourceFromBytes(opts.stdin);
    else stdin = sourceFromBytes('');
    const proc = opts.proc || this.kernel.spawnProcess({
      argv: [this.argv0], name: opts.name || 'sh', uid: this.uid, gid: this.gid,
      groups: this.groups, cwd: this.cwd, env: this.exportEnv(), ppid: opts.ppid ?? 1,
    });
    this.pid = proc.pid;
    const shell = opts.fresh ? this.clone() : this;
    shell.pid = proc.pid;
    const io = { stdin, stdout, stderr, proc };
    const done = (async () => {
      let code = 0;
      let outText, errText;
      try {
        code = await shell.execSource(src, io);
      } catch (e) {
        if (e instanceof ShellExit) code = e.code;
        else if (e instanceof ShellReturn) code = e.code;
        else if (e instanceof ExpansionError) { stderr.write(`sh: ${e.message}\n`); code = 1; }
        else if (e?.name === 'ShellSyntaxError') { stderr.write(`sh: ${e.message}\n`); code = 2; }
        else if (e instanceof CommandError) { stderr.write(`sh: ${e.message}\n`); code = e.code; }
        else { stderr.write(`sh: internal error: ${e?.stack || e}\n`); code = 1; }
      }
      try { await shell.runExitTrap(io); } catch { /* ignore */ }
      outCh.end(); errCh.end();
      proc.setExit(code);
      this.status = code;
      if (!opts.stdout) outText = decode(await outCh.collect());
      if (!opts.stderr) errText = decode(await errCh.collect());
      this.kernel.reap(proc);
      return { code, stdout: outText, stderr: errText, pid: proc.pid };
    })();
    return { pid: proc.pid, stdout: outCh, stderr: errCh, done };
  }

  async runExitTrap(io) {
    const t = this.traps.get('EXIT');
    if (!t) return;
    this.traps.delete('EXIT');
    try { await this.execSource(t, { ...io, stdin: sourceFromBytes('') }); } catch { /* ignore */ }
  }

  async execSource(src, io) {
    const prev = this._io;
    this._io = io;
    try {
      const ast = parse(src);
      if (this.opts.verbose) io.stderr.write(src.endsWith('\n') ? src : src + '\n');
      return await this.execList(ast, io);
    } finally {
      this._io = prev;
    }
  }

  async execList(list, io) {
    let code = 0;
    for (const item of list.items) {
      if (this.procAborted(io)) throw new ShellExit(137);
      if (item.async) {
        this.startBackground(item.node, io);
        code = 0;
      } else {
        code = await this.execAndOr(item.node, io, { suppress: false });
        this.status = code;
      }
    }
    return code;
  }

  procAborted(io) {
    if (io?.proc?.abort?.signal?.aborted) { this.aborted = true; return true; }
    return false;
  }

  async execAndOr(node, io, { suppress = false } = {}) {
    let code = await this.execPipeline(node.first, io, { suppress: suppress || node.rest.length > 0 });
    for (const r of node.rest) {
      if (r.op === '&&') {
        if (code === 0) code = await this.execPipeline(r.node, io, { suppress: false });
      } else {
        if (code !== 0) code = await this.execPipeline(r.node, io, { suppress: false });
      }
      this.status = code;
    }
    if (code !== 0 && this.opts.errexit && !suppress) throw new ShellExit(code);
    return code;
  }

  async execPipeline(node, io, { suppress = false } = {}) {
    let code;
    if (node.cmds.length === 1) {
      code = await this.execCommand(node.cmds[0], io);
    } else {
      code = await this.runPipeline(node, io);
    }
    if (node.negate) code = code === 0 ? 1 : 0;
    this.status = code;
    if (code !== 0 && this.opts.errexit && !suppress && !node.negate) throw new ShellExit(code);
    return code;
  }

  async runPipeline(node, io) {
    const n = node.cmds.length;
    const pipes = Array.from({ length: n - 1 }, () => new Channel());
    const tasks = node.cmds.map((cmd, i) => {
      const shell = this.clone();
      shell.pid = io.proc.pid;
      let stdin;
      if (i === 0) stdin = io.stdin;
      else stdin = sourceFromChannel(pipes[i - 1]);
      const stdout = i === n - 1 ? io.stdout : sinkFromChannel(pipes[i]);
      const stderr = i === n - 1 ? io.stderr : io.stderr;
      const stageIO = { stdin, stdout, stderr, proc: io.proc };
      return (async () => {
        let code = 0;
        try {
          code = await shell.execCommand(cmd, stageIO);
        } catch (e) {
          if (e instanceof ShellExit) code = e.code;
          else if (e instanceof CommandError) { stderr.write(`${cmdName(cmd)}: ${e.message}\n`); code = e.code; }
          else if (!(e instanceof ShellReturn || e instanceof ShellBreak || e instanceof ShellContinue)) {
            stderr.write(`sh: ${e?.message || e}\n`); code = 1;
          }
        } finally {
          if (i > 0) pipes[i - 1].closeRead();
          if (i < n - 1) pipes[i].end();
        }
        return code;
      })();
    });
    const codes = await Promise.all(tasks);
    let code = codes[codes.length - 1] ?? 0;
    if (this.opts.pipefail) {
      const bad = codes.find((c) => c !== 0);
      if (bad !== undefined) code = bad;
    }
    return code;
  }

  async execCommand(node, io) {
    const prev = this._io;
    this._io = io;
    try {
      return await this._execCommand(node, io);
    } finally {
      this._io = prev;
    }
  }

  async _execCommand(node, io) {
    switch (node.type) {
      case 'simple': return this.execSimple(node, io);
      case 'group': {
        const r = await this.applyRedirs(node.redirs, io);
        try {
          if (node.subshell) return await this.clone().execList(node.body, r.io);
          return await this.execList(node.body, r.io);
        } finally { r.cleanup(); }
      }
      case 'if': {
        const r = await this.applyRedirs(node.redirs, io);
        try {
          for (const clause of node.clauses) {
            const c = await this.execList(clause.cond, r.io);
            if (c === 0) return await this.execList(clause.body, r.io);
          }
          if (node.elseBody) return await this.execList(node.elseBody, r.io);
          return 0;
        } finally { r.cleanup(); }
      }
      case 'for': {
        const r = await this.applyRedirs(node.redirs, io);
        try {
          let values;
          if (node.words === null) values = this.positional.slice();
          else values = await this.expander.expandWords(node.words);
          let code = 0;
          for (const v of values) {
            this.setVar(node.name, v);
            try { code = await this.execList(node.body, r.io); }
            catch (e) {
              if (e instanceof ShellBreak) { if (e.levels > 1) { e.levels--; throw e; } break; }
              if (e instanceof ShellContinue) { if (e.levels > 1) { e.levels--; throw e; } continue; }
              throw e;
            }
            this.status = code;
          }
          return 0;
        } finally { r.cleanup(); }
      }
      case 'while': {
        const r = await this.applyRedirs(node.redirs, io);
        try {
          let code = 0, iterations = 0;
          for (;;) {
            if (++iterations > MAX_LOOP) throw new CommandError('while: iteration limit exceeded');
            const c = await this.execList(node.cond, r.io);
            const go = node.until ? c !== 0 : c === 0;
            if (!go) break;
            try { code = await this.execList(node.body, r.io); }
            catch (e) {
              if (e instanceof ShellBreak) { if (e.levels > 1) { e.levels--; throw e; } break; }
              if (e instanceof ShellContinue) { if (e.levels > 1) { e.levels--; throw e; } continue; }
              throw e;
            }
          }
          return 0;
        } finally { r.cleanup(); }
      }
      case 'case': {
        const r = await this.applyRedirs(node.redirs, io);
        try {
          const word = await this.expander.expandString(node.word);
          let code = 0;
          let matched = false;
          for (let i = 0; i < node.cases.length; i++) {
            const c = node.cases[i];
            let hit = matched && c.terminator !== ';;';
            if (!hit) {
              for (const p of c.patterns) {
                const pat = await this.expander.expandString(p);
                if (globToRegex(pat, { pathMode: false }).test(word)) { hit = true; break; }
              }
            }
            if (hit) {
              code = await this.execList(c.body, r.io);
              matched = true;
              if (c.terminator === ';;') break;
              if (c.terminator === ';&') continue;
            }
          }
          return code;
        } finally { r.cleanup(); }
      }
      case 'funcdef': {
        this.functions.set(node.name, { body: node.body });
        return 0;
      }
      case 'time': {
        const t0 = Date.now();
        const code = await this.execPipeline(node.cmd, io, { suppress: true });
        const ms = Date.now() - t0;
        io.stderr.write(`real\t${(ms / 1000).toFixed(3)}s\nuser\t0.000s\nsys\t0.000s\n`);
        return code;
      }
      default:
        throw new CommandError(`unsupported syntax node ${node.type}`);
    }
  }

  async execSimple(node, io) {
    const { io: nio, cleanup } = await this.applyRedirs(node.redirs, io);
    const shell = this;
    try {
      const assigns = [];
      for (const a of node.assigns) {
        const v = await this.expander.expandString(a.value);
        assigns.push({ name: a.name, append: a.append, value: v });
      }
      let argv = await this.expander.expandWords(node.words);
      if (this.opts.noglob) argv = argv.map((s) => s);
      if (!argv.length) {
        for (const a of assigns) {
          if (a.append) this.setVar(a.name, (this.getVar(a.name) || '') + a.value);
          else this.setVar(a.name, a.value);
        }
        return 0;
      }
      // alias expansion
      let guard = 0;
      while (this.aliases.has(argv[0]) && guard++ < 16) {
        const toks = this.aliases.get(argv[0]).trim().split(/\s+/).filter(Boolean);
        argv = [...toks, ...argv.slice(1)];
      }
      if (this.opts.xtrace) nio.stderr.write(this.vars.get('PS4') + argv.join(' ') + '\n');
      const name = argv[0];
      const env = this.exportEnv(Object.fromEntries(assigns.map((a) => [a.name, a.value])));
      env._ = name;
      if (this.functions.has(name)) return await this.callFunction(name, argv.slice(1), nio, env);
      const builtin = BUILTINS[name];
      if (builtin) {
        const prevIo = this._io;
        this._io = nio;
        try {
          return await builtin(this, argv, nio);
        } catch (e) {
          if (e instanceof CommandError) {
            if (e.message) nio.stderr.write(e.usage ? `${name}: ${e.message}\n` : `${e.message}\n`);
            return e.code;
          }
          if (e instanceof ShellExit || e instanceof ShellReturn || e instanceof ShellBreak || e instanceof ShellContinue) throw e;
          if (e instanceof ExpansionError) { nio.stderr.write(`${name}: ${e.message}\n`); return 1; }
          nio.stderr.write(`${name}: ${e?.message || e}\n`);
          return 1;
        } finally {
          this._io = prevIo;
        }
      }
      // external / registered command or script
      if (name.includes('/')) {
        const target = normalizeRel(this.cwd, name);
        const st = (() => { try { return this.kernel.vfs.stat(target, this.cred()); } catch { return null; } })();
        if (st && st.isFile()) {
          if (!(st.mode & 0o111)) { nio.stderr.write(`sh: ${name}: Permission denied\n`); return 126; }
          return await this.runScript(target, argv.slice(1), nio, env);
        }
        nio.stderr.write(`sh: ${name}: No such file or directory\n`);
        return 127;
      }
      const def = this.kernel.commands.get(name);
      if (!def) {
        nio.stderr.write(`sh: ${name}: command not found\n`);
        return 127;
      }
      const ctx = this.makeCommandContext(name, argv, env, nio, def);
      try {
        const code = await def.run(ctx);
        return typeof code === 'number' ? code : 0;
      } catch (e) {
        if (e instanceof CommandError) {
          if (e.message) nio.stderr.write(e.prefix === false ? `${e.message}\n` : `${name}: ${e.message}\n`);
          return e.code;
        }
        if (e instanceof ShellExit) throw e;
        if (e?.code && e?.syscall) { nio.stderr.write(`${name}: ${e.message}\n`); return 1; }
        nio.stderr.write(`${name}: ${e?.message || e}\n`);
        return 1;
      }
    } finally {
      cleanup();
    }
  }

  makeCommandContext(name, argv, env, io, def) {
    const shell = this;
    const ctx = {
      name, argv, args: argv.slice(1), env,
      kernel: this.kernel, vfs: this.kernel.vfs, shell,
      expander: this.expander, def,
      cwd: this.cwd, uid: this.uid, gid: this.gid, groups: this.groups,
      home: this.home, proc: io.proc,
      stdin: io.stdin, stdout: io.stdout, stderr: io.stderr,
      out: (s) => io.stdout.write(s),
      err: (s) => io.stderr.write(s),
      readText: async () => readText(io.stdin),
      readBytes: async () => readAll(io.stdin),
      fail: (msg, code = 1) => { throw new CommandError(msg, code); },
      cred: () => this.cred(),
      cmdsub: (src) => this.runSubshell(src),
      expand: (text) => this.expander.expandString({ parts: [{ t: 'lit', v: text, q: false }] }),
      spawn: (src, opts) => this.clone().startSession(src, opts),
    };
    return ctx;
  }

  async callFunction(name, args, io, env) {
    const fn = this.functions.get(name);
    const savedPos = this.positional;
    const savedArgv0 = this.argv0;
    this.positional = args;
    this.argv0 = name;
    const scope = { locals: new Map() };
    this.scopes.push(scope);
    let code = 0;
    try {
      code = await this.execCommand(fn.body, io);
    } catch (e) {
      if (e instanceof ShellReturn) code = e.code;
      else throw e;
    } finally {
      this.scopes.pop();
      this.positional = savedPos;
      this.argv0 = savedArgv0;
    }
    return code;
  }

  async runScript(path, args, io, env) {
    const data = this.kernel.vfs.readFile(path, this.cred());
    const text = decode(data);
    if (data[0] === 0x7f && data[1] === 0x45) {
      io.stderr.write(`sh: ${path}: cannot execute binary file: Exec format error\n`);
      return 126;
    }
    let body = text, interpreter = null;
    if (text.startsWith('#!')) {
      const line = text.slice(2).split('\n')[0].trim();
      const parts = line.split(/\s+/);
      interpreter = parts[0].split('/').pop();
      if (interpreter === 'env') {
        const cmd = parts.slice(1).find((p) => !p.startsWith('-'));
        if (cmd) interpreter = cmd.split('/').pop();
      }
      body = text.slice(text.indexOf('\n') + 1);
      if (interpreter === 'node' || interpreter === 'nodejs') {
        if (!this.kernel.nodeRuntime) {
          io.stderr.write(`sh: ${path}: node runtime not installed\n`);
          return 127;
        }
        return this.kernel.nodeRuntime.runFile(path, args, io, env);
      }
    }
    const clone = this.clone();
    clone.argv0 = path;
    clone.positional = args.slice();
    const res = await clone.startSession(body, {
      stdin: io.stdin, stdout: io.stdout, stderr: io.stderr,
      argv0: path, args, ppid: io.proc.pid, env,
    });
    const r = await res.done;
    return r.code;
  }

  async applyRedirs(redirs, io) {
    if (!redirs || !redirs.length) return { io, cleanup: () => {} };
    const nio = { ...io };
    const cleanups = [];
    const opened = [];
    const closeAll = () => {
      for (const h of opened) { try { h.close(); } catch { /* noop */ } }
    };
    try {
      for (const r of redirs) {
        if (r.type === 'heredoc') {
          let text = r.body;
          if (r.expand) {
            const parts = parseQuotedBody(text);
            text = await this.expander.expandString({ parts });
          }
          if (r.fd === 0) nio.stdin = sourceFromBytes(text);
          continue;
        }
        if (r.type === 'herestring') {
          const text = await this.expander.expandString(r.word) + '\n';
          if (r.fd === 0) nio.stdin = sourceFromBytes(text);
          continue;
        }
        if (r.type === 'dup') {
          const t = String(r.target).trim();
          if (t === '-') {
            if (r.dir === 'in') nio.stdin = sourceFromBytes('');
            else nio[r.fd === 2 ? 'stderr' : 'stdout'] = sinkNull();
            continue;
          }
          if (r.dir === 'in') {
            if (t === '0') { /* same */ }
            else if (t === '1') nio.stdin = sourceFromChannel(new Channel());
            else if (t === '2') nio.stdin = sourceFromChannel(new Channel());
            else throw new CommandError(`${t}: bad file descriptor`);
          } else {
            if (t === '1') nio[r.fd === 2 ? 'stderr' : 'stdout'] = nio.stdout;
            else if (t === '2') nio[r.fd === 2 ? 'stderr' : 'stdout'] = nio.stderr;
            else if (t === '0') nio[r.fd === 2 ? 'stderr' : 'stdout'] = sinkNull();
            else throw new CommandError(`${t}: bad file descriptor`);
          }
          continue;
        }
        const path = await this.expandRedirectTarget(r.path);
        if (r.fd === 0 || r.flags === 'read' || r.flags === 'rdwr') {
          if (path === '/dev/stdin') { /* inherit */ continue; }
          if (path === '/dev/stdout') { nio.stdin = sourceFromChannel(new Channel()); continue; }
          const flags = r.flags === 'rdwr' ? O.RDWR | O.CREAT : O.RDONLY;
          const h = this.kernel.vfs.open(path, flags, this.cred());
          opened.push(h);
          nio.stdin = sourceFromHandle(h);
          if (r.flags !== 'rdwr') continue;
        }
        const isAppend = r.flags === 'append';
        if (path === '/dev/stdout') { nio.stdout = nio.stdout; nio[r.fd === 2 ? 'stderr' : 'stdout'] = nio.stdout; continue; }
        if (path === '/dev/stderr') { nio[r.fd === 2 ? 'stderr' : 'stdout'] = nio.stderr; continue; }
        if (this.opts.noclobber && !isAppend && r.flags === 'trunc') {
          if (this.kernel.vfs.exists(path, this.cred())) throw new CommandError(`${path}: cannot overwrite existing file`);
        }
        const flags = O.WRONLY | O.CREAT | (isAppend ? O.APPEND : O.TRUNC);
        const h = this.kernel.vfs.open(path, flags, this.cred());
        opened.push(h);
        const sink = sinkFromHandle(h, { autoClose: false });
        if (r.both) { nio.stdout = sink; nio.stderr = sink; }
        else if (r.fd === 2) nio.stderr = sink;
        else nio.stdout = sink;
      }
    } catch (e) {
      closeAll();
      throw e;
    }
    return { io: nio, cleanup: closeAll };
  }

  async expandRedirectTarget(word) {
    const fields = await this.expander.expandWord(word);
    if (!fields.length) throw new CommandError('ambiguous redirect');
    if (fields.length > 1) throw new CommandError('ambiguous redirect');
    return fields[0];
  }

  startBackground(node, io) {
    const clone = this.clone();
    const proc = this.kernel.spawnProcess({
      argv: ['sh', '-c', 'background job'], name: 'sh', uid: this.uid, gid: this.gid,
      groups: this.groups, cwd: this.cwd, env: this.exportEnv(), ppid: io.proc?.pid ?? 1,
      background: true,
    });
    clone.pid = proc.pid;
    const job = {
      id: this.nextJob++, pid: proc.pid, state: 'Running', cmd: 'background job', proc,
      done: null, shell: clone,
    };
    this.lastBg = proc.pid;
    this.jobs.push(job);
    job.done = (async () => {
      let code = 0;
      try {
        code = await clone.execAndOr(node, {
          stdin: sourceFromBytes(''), stdout: io.stdout, stderr: io.stderr, proc,
        }, { suppress: true });
      } catch (e) {
        if (e instanceof ShellExit || e instanceof ShellReturn) code = e.code;
        else code = 1;
      }
      proc.setExit(code);
      job.state = 'Done';
      job.code = code;
      return code;
    })();
    return job;
  }

  clone() {
    const s = new Shell(this.kernel, {
      user: this.kernel.userByUid(this.uid)?.name || 'user',
      cwd: this.cwd, argv0: this.argv0, args: this.positional.slice(), home: this.home,
      env: {}, options: { ...this.opts },
    });
    s.vars = new Map(this.vars);
    s.exports = new Set(this.exports);
    s.aliases = new Map(this.aliases);
    s.functions = new Map(this.functions);
    s.oldpwd = this.oldpwd;
    s.status = this.status;
    s.lastBg = this.lastBg;
    s.jobs = this.jobs;
    s.nextJob = this.nextJob;
    s.traps = new Map(this.traps);
    s.ifS = this.ifS;
    s.pid = this.pid;
    return s;
  }

  async runSubshell(src) {
    const clone = this.clone();
    const result = await clone.exec(src, { fresh: false });
    return { code: result.code, stdout: result.stdout || '', stderr: result.stderr || '' };
  }
}

function cmdName(node) {
  if (node.type === 'simple' && node.words.length) {
    const w = node.words[0];
    return w.raw || 'sh';
  }
  return node.type;
}

function normalizeRel(cwd, p) {
  if (p.startsWith('/')) return p;
  const parts = (cwd + '/' + p).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return '/' + out.join('/');
}
