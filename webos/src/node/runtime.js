/*
 * WebOS Node.js-compatible runtime (pure JavaScript, browser safe).
 *
 * createNodeRuntime(kernel) returns a runtime that can execute CommonJS and
 * ESM sources from the virtual filesystem, and installs `node`, `nodejs`,
 * `npm` and `npx` shell commands.
 */

import { Buffer } from './buffer.js';
import { createPath } from './path.js';
import { createOs } from './os.js';
import { EventEmitter } from './events.js';
import * as eventsNamespace from './events.js';
import * as utilNamespace from './util.js';
import * as streamNamespace from './stream.js';
import * as cryptoNamespace from './crypto.js';
import * as zlibNamespace from './zlib.js';
import * as bufferNamespace from './buffer.js';
import assertModule from './assert.js';
import { createFs } from './fs.js';
import { createVm } from './vm.js';
import { createWorkerThreads } from './worker.js';
import { createChildProcess } from './child.js';
import { createHttpModules, net, tls, dgram, dnsModule } from './net.js';
import { createLoader, Module, transformESM } from './loader.js';
import * as misc from './misc.js';
import {
  createInterface as createReadlineInterface,
  promises as readlinePromises,
  emitKeypressEvents,
  Interface as ReadlineInterface,
} from './readline.js';
import { Shell } from '../shell/shell.js';

class ExitSignal extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.name = 'ExitSignal';
    this.code = typeof code === 'number' ? code : 0;
  }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

class Timeout {
  constructor(id, kind) {
    this._id = id;
    this._kind = kind;
  }
  ref() { return this; }
  unref() { return this; }
  hasRef() { return true; }
  refresh() { return this; }
  close() { return this; }
  [Symbol.toPrimitive]() { return this._id; }
}

export function createNodeRuntime(kernel) {
  const runtime = {
    kernel,
    vfs: kernel.vfs,
    currentProcess: null,
    currentConsole: null,
    mainModule: null,
    workerContext: null,
    activeTimers: new Set(),
    hostTimers: new Map(),
    exitCode: 0,
    globalObject: null,
    builtins: new Map(),
    builtinNames: [],
    loader: null,
    installed: false,
  };

  const path = createPath(() => runtime.currentProcess?.cwd?.() || '/');
  const os = createOs(kernel, () => runtime.currentProcess);
  const fs = createFs(kernel, () => runtime.currentProcess);
  const httpModules = createHttpModules();
  const workerThreads = createWorkerThreads({
    runFile: (p, a, io, env, opts) => runtime.runFile(p, a, io, env, opts),
    runCode: (code, opts) => runtime.runCode(code, opts),
    getContext: () => runtime.workerContext,
  });
  const childProcess = createChildProcess(runtime);
  const vmModule = createVm((sandbox) => runtime.makeGlobals('[eval]', false, sandbox));

  const bufferBuiltin = {
    Buffer,
    SlowBuffer: bufferNamespace.SlowBuffer,
    kMaxLength: bufferNamespace.kMaxLength,
    INSPECT_MAX_BYTES: bufferNamespace.INSPECT_MAX_BYTES,
    transcode: bufferNamespace.transcode,
    constants: { MAX_LENGTH: 0x7fffffff, MAX_STRING_LENGTH: 0x1fffffe8 },
    isUtf8: () => true,
  };

  const util = utilNamespace.util;

  const streamPromises = {
    pipeline: (...args) => {
      const { pipeline } = streamNamespace;
      return new Promise((resolve, reject) => {
        try { pipeline(...args, (err) => (err ? reject(err) : resolve())); } catch (e) { reject(e); }
      });
    },
    finished: (stream) => new Promise((resolve, reject) => {
      streamNamespace.finished(stream, (err) => (err ? reject(err) : resolve()));
    }),
  };

  const moduleBuiltin = {
    Module,
    builtinModules: [],
    isBuiltin: (name) => runtime.isBuiltin(name),
    createRequire: (filename) => runtime.loader.createRequireFrom(filename),
    syncBuiltinESMExports: () => {},
    findSourceMap: () => undefined,
    register: () => { throw new Error('module.register() is not supported in the browser sandbox'); },
    _cache: null,
    _load: (request, parent) => runtime.loader.require(request, parent?.filename, parent?.path || runtime.cwdDir()),
  };
  Module.createRequire = moduleBuiltin.createRequire;
  Module.builtinModules = moduleBuiltin.builtinModules;

  const readlineBuiltin = {
    createInterface: createReadlineInterface,
    Interface: ReadlineInterface,
    emitKeypressEvents,
    promises: readlinePromises,
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
  };

  const builtins = runtime.builtins;
  builtins.set('fs', fs);
  builtins.set('fs/promises', fs.promises);
  builtins.set('path', path);
  builtins.set('path/posix', path);
  builtins.set('path/win32', path);
  builtins.set('os', os);
  builtins.set('events', eventsNamespace);
  builtins.set('stream', streamNamespace);
  builtins.set('stream/promises', streamPromises);
  builtins.set('stream/web', {
    ReadableStream: globalThis.ReadableStream,
    WritableStream: globalThis.WritableStream,
    TransformStream: globalThis.TransformStream,
    ByteLengthQueuingStrategy: globalThis.ByteLengthQueuingStrategy,
    CountQueuingStrategy: globalThis.CountQueuingStrategy,
  });
  builtins.set('util', util);
  builtins.set('util/types', utilNamespace.types);
  builtins.set('assert', assertModule);
  builtins.set('assert/strict', assertModule.strict || assertModule);
  builtins.set('buffer', bufferBuiltin);
  builtins.set('crypto', cryptoNamespace);
  builtins.set('zlib', zlibNamespace);
  builtins.set('url', misc.urlModule);
  builtins.set('querystring', misc.querystring);
  builtins.set('tty', misc.tty);
  builtins.set('string_decoder', { StringDecoder: misc.StringDecoder });
  builtins.set('punycode', misc.punycode);
  builtins.set('domain', misc.domain);
  builtins.set('perf_hooks', misc.perf_hooks);
  builtins.set('timers', misc.timers);
  builtins.set('timers/promises', misc.timersPromises);
  builtins.set('vm', vmModule);
  builtins.set('worker_threads', workerThreads);
  builtins.set('readline', readlineBuiltin);
  builtins.set('readline/promises', readlinePromises);
  builtins.set('module', moduleBuiltin);
  builtins.set('constants', misc.constants);
  builtins.set('http', httpModules.http);
  builtins.set('https', httpModules.https);
  builtins.set('net', net);
  builtins.set('tls', tls);
  builtins.set('dgram', dgram);
  builtins.set('dns', dnsModule);
  builtins.set('dns/promises', dnsModule.promises);
  builtins.set('child_process', childProcess);
  builtins.set('process', null);
  builtins.set('console', null);

  runtime.builtinNames = [...builtins.keys()];
  moduleBuiltin.builtinModules = runtime.builtinNames;

  runtime.globalObject = Object.create(globalThis);
  const wire = (name, getter) => {
    try {
      Object.defineProperty(runtime.globalObject, name, { get: getter, configurable: true, enumerable: true });
    } catch { /* ignore */ }
  };
  wire('process', () => runtime.currentProcess);
  wire('console', () => runtime.currentConsole);
  wire('Buffer', () => Buffer);
  wire('global', () => runtime.globalObject);
  wire('globalThis', () => runtime.globalObject);

  runtime.isBuiltin = (name) => {
    const bare = String(name).startsWith('node:') ? String(name).slice(5) : String(name);
    return builtins.has(bare) || bare === 'process' || bare === 'console';
  };

  runtime.getBuiltin = (name) => {
    const bare = String(name).startsWith('node:') ? String(name).slice(5) : String(name);
    if (bare === 'process') return runtime.currentProcess;
    if (bare === 'console') return runtime.currentConsole;
    return builtins.get(bare);
  };

  /* ------------------------------ process state ------------------------------ */

  runtime.cred = () => {
    const p = runtime.currentProcess;
    return {
      uid: p?.uid ?? 1000,
      gid: p?.gid ?? 1000,
      groups: p?.groups || [p?.gid ?? 1000],
      cwd: p?.cwd?.() || '/home/user',
    };
  };

  runtime.cwdDir = () => runtime.currentProcess?.cwd?.() || '/home/user';
  runtime.setCwdDir = (dir) => { if (runtime.currentProcess) runtime.currentProcess.chdir(dir); };

  runtime.readFileText = (filename) => {
    const bytes = runtime.vfs.readFile(filename, runtime.cred());
    return Buffer.from(bytes).toString('utf8');
  };

  runtime._reportError = (proc, e) => {
    if (proc.listenerCount('uncaughtException') > 0) {
      try { proc.emit('uncaughtException', e); return; } catch { /* fall through */ }
    }
    const text = e instanceof Error ? (e.stack || `${e.name}: ${e.message}`) : String(e);
    try { proc.stderr.write(`${text}\n`); } catch { /* ignore */ }
  };

  runtime._handleAsyncError = (proc, e) => {
    if (e instanceof ExitSignal) {
      proc.exitCode = e.code;
      runtime._clearAllTimers();
      return;
    }
    runtime._reportError(proc, e);
  };

  /* ------------------------------- timers ------------------------------- */

  runtime._setTimer = (proc, fn, ms, args, kind) => {
    const hostFn = kind === 'interval' ? setInterval : setTimeout;
    const id = hostFn(() => {
      if (kind !== 'interval') {
        const t = runtime.hostTimers.get(id);
        if (t) { runtime.hostTimers.delete(id); runtime.activeTimers.delete(t); }
      }
      try { fn(...args); } catch (e) { runtime._handleAsyncError(proc, e); }
    }, Math.max(0, Number(ms) || 0));
    const timer = new Timeout(id, kind);
    runtime.hostTimers.set(id, timer);
    runtime.activeTimers.add(timer);
    return timer;
  };

  runtime._setImmediate = (proc, fn, args) => {
    const id = setImmediate(() => {
      const t = runtime.hostTimers.get(id);
      if (t) { runtime.hostTimers.delete(id); runtime.activeTimers.delete(t); }
      try { fn(...args); } catch (e) { runtime._handleAsyncError(proc, e); }
    });
    const timer = new Timeout(id, 'immediate');
    runtime.hostTimers.set(id, timer);
    runtime.activeTimers.add(timer);
    return timer;
  };

  runtime._clearTimer = (timer) => {
    if (timer === null || timer === undefined) return;
    const t = typeof timer === 'object' ? timer : runtime.hostTimers.get(timer);
    const id = typeof timer === 'object' ? timer._id : timer;
    if (!id && id !== 0) return;
    if (t && t._kind === 'interval') clearInterval(id);
    else if (t && t._kind === 'immediate') clearImmediate(id);
    else clearTimeout(id);
    if (t) { runtime.activeTimers.delete(t); runtime.hostTimers.delete(id); }
  };

  runtime._clearAllTimers = () => {
    for (const t of [...runtime.activeTimers]) {
      if (t._kind === 'interval') clearInterval(t._id);
      else if (t._kind === 'immediate') clearImmediate(t._id);
      else clearTimeout(t._id);
    }
    runtime.activeTimers.clear();
    runtime.hostTimers.clear();
  };

  /** Track non-timer async work (stdin pumps, child sessions) so runs settle. */
  runtime._pendingAsync = new Set();
  runtime._trackAsync = (promise) => {
    const p = Promise.resolve(promise);
    runtime._pendingAsync.add(p);
    p.then(() => runtime._pendingAsync.delete(p), () => runtime._pendingAsync.delete(p));
    return promise;
  };

  runtime._drainTimers = async (proc, maxMs = 3000) => {
    const start = Date.now();
    // Let queued microtasks schedule their work before checking for it.
    await new Promise((r) => setTimeout(r, 0));
    const hasPending = () => runtime.activeTimers.size > 0 || runtime._pendingAsync.size > 0;
    while (hasPending() && Date.now() - start < maxMs) {
      await new Promise((r) => setTimeout(r, 1));
    }
  };

  /* ------------------------------- console ------------------------------- */

  runtime._createConsole = (io) => {
    const util = utilNamespace.util;
    let indent = 0;
    const counts = new Map();
    const timers = new Map();
    const sinkFor = (isErr) => (isErr ? io?.stderr : io?.stdout);
    const write = (text, isErr = false) => {
      const sink = sinkFor(isErr);
      const pad = indent > 0 ? ' '.repeat(indent) : '';
      const body = String(text).split('\n').map((l, i, arr) => (i === arr.length - 1 && l === '' ? '' : pad + l)).join('\n');
      const out = body.endsWith('\n') ? body : body + '\n';
      try { sink?.write(out); } catch { /* ignore */ }
    };
    const fmt = (args) => (args.length ? util.format(...args) : '');
    const con = {
      log: (...a) => write(fmt(a)),
      info: (...a) => write(fmt(a)),
      debug: (...a) => write(fmt(a)),
      warn: (...a) => write(fmt(a), true),
      error: (...a) => write(fmt(a), true),
      trace: (...a) => {
        const stack = new Error().stack?.split('\n').slice(2).join('\n') || '';
        write(`Trace${a.length ? ': ' + fmt(a) : ''}\n${stack}`, true);
      },
      dir: (obj, opts) => write(util.inspect(obj, typeof opts === 'number' ? { depth: opts } : opts)),
      table: (data) => {
        if (data && typeof data === 'object') {
          for (const [k, v] of Object.entries(data)) write(`${k}: ${util.inspect(v)}`);
        } else write(util.inspect(data));
      },
      assert: (cond, ...a) => { if (!cond) write(`Assertion failed${a.length ? ': ' + fmt(a) : ''}`, true); },
      count: (label = 'default') => {
        const n = (counts.get(label) || 0) + 1;
        counts.set(label, n);
        write(`${label}: ${n}`);
      },
      countReset: (label = 'default') => counts.delete(label),
      time: (label = 'default') => timers.set(label, Date.now()),
      timeEnd: (label = 'default') => {
        const start = timers.get(label);
        if (start === undefined) { write(`Warning: No such label '${label}' for console.timeEnd()`, true); return; }
        timers.delete(label);
        write(`${label}: ${Date.now() - start}ms`);
      },
      timeLog: (label = 'default', ...a) => {
        const start = timers.get(label);
        if (start !== undefined) write(`${label}: ${Date.now() - start}ms${a.length ? ' ' + fmt(a) : ''}`);
      },
      group: (...a) => { if (a.length) write(fmt(a)); indent += 2; },
      groupCollapsed: (...a) => con.group(...a),
      groupEnd: () => { indent = Math.max(0, indent - 2); },
      clear: () => {},
      dirxml: (...a) => write(fmt(a)),
      profile: () => {},
      profileEnd: () => {},
      timeStamp: () => {},
    };
    return con;
  };

  /* ------------------------------- process ------------------------------- */

  runtime._createProcess = (spec = {}) => {
    const proc = new EventEmitter();
    const io = spec.io || null;
    const uid = spec.uid ?? io?.proc?.uid ?? 1000;
    const gid = spec.gid ?? io?.proc?.gid ?? io?.proc?.gid ?? 1000;
    const groups = spec.groups ?? io?.proc?.groups ?? [gid];
    const user = kernel.userByUid ? kernel.userByUid(uid) : null;
    let cwd = spec.cwd || io?.proc?.cwd || user?.home || '/home/user';

    proc.argv = spec.argv || ['node'];
    proc.execPath = '/usr/bin/node';
    proc.execArgv = [];
    proc.argv0 = 'node';
    proc.platform = 'linux';
    proc.arch = 'x64';
    proc.version = 'v22.0.0-webos';
    proc.versions = {
      node: '22.0.0', v8: '12.4.254.14-node.13', uv: '1.0.0-webos',
      zlib: '1.3.0-webos-zlib', openssl: '3.0.0-webos', modules: '127',
    };
    proc.release = { name: 'node' };
    proc.features = {};
    proc.allowedNodeEnvironmentFlags = new Set();
    proc.debugPort = 9229;
    proc.title = 'node';
    proc.pid = spec.pid ?? (1000 + Math.floor(Math.random() * 8000));
    proc.ppid = spec.ppid ?? io?.proc?.pid ?? 0;
    proc.uid = uid;
    proc.gid = gid;
    proc.groups = groups;
    proc.exitCode = undefined;
    proc.connected = false;
    proc.env = {
      HOME: user?.home || '/home/user',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      USER: user?.name || 'user',
      LOGNAME: user?.name || 'user',
      SHELL: user?.shell || '/bin/sh',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      PWD: cwd,
      ...(spec.env || {}),
    };

    proc.cwd = () => cwd;
    proc.chdir = (dir) => {
      const abs = String(dir).startsWith('/') ? path.normalize(String(dir)) : path.join(cwd, String(dir));
      const st = runtime.vfs.stat(abs, { uid, gid, groups, cwd });
      if (!st.isDirectory()) {
        const e = new Error(`ENOTDIR: not a directory, chdir '${dir}'`);
        e.code = 'ENOTDIR';
        throw e;
      }
      cwd = abs;
      proc.env.PWD = abs;
    };
    proc.getuid = () => uid;
    proc.getgid = () => gid;
    proc.geteuid = () => uid;
    proc.getegid = () => gid;
    proc.getgroups = () => groups.slice();
    proc.setuid = proc.setgid = () => { throw new Error('setuid/setgid are not supported in the WebOS sandbox'); };

    const makeOutput = (sink) => {
      const s = new EventEmitter();
      s.fd = sink === io?.stderr ? 2 : 1;
      s.write = (chunk, enc, cb) => {
        if (typeof enc === 'function') { cb = enc; enc = null; }
        try {
          const bytes = typeof chunk === 'string' ? Buffer.from(chunk, enc || 'utf8') : chunk;
          sink?.write(bytes);
        } catch { /* ignore sink errors */ }
        if (typeof cb === 'function') queueMicrotask(cb);
        return true;
      };
      s.end = (cb) => { if (typeof cb === 'function') queueMicrotask(cb); };
      s.cork = () => {};
      s.uncork = () => {};
      s.isTTY = false;
      s.columns = 80;
      s.rows = 24;
      s.getColorDepth = () => 1;
      s.hasColors = () => false;
      return s;
    };
    proc.stdout = makeOutput(io?.stdout || null);
    proc.stderr = makeOutput(io?.stderr || null);

    const stdin = new EventEmitter();
    let stdinStarted = false;
    const startStdin = () => {
      if (stdinStarted) return;
      stdinStarted = true;
      const src = io?.stdin;
      if (!src || typeof src.read !== 'function') { queueMicrotask(() => stdin.emit('end')); return; }
      runtime._trackAsync((async () => {
        try {
          for (;;) {
            const chunk = await src.read(65536);
            if (!chunk || !chunk.length) break;
            stdin.emit('data', Buffer.from(chunk));
          }
          stdin.emit('end');
        } catch (e) { stdin.emit('error', e); }
      })());
    };
    stdin.fd = 0;
    stdin.isTTY = false;
    stdin.setEncoding = () => stdin;
    stdin.read = () => null;
    stdin.pause = () => stdin;
    stdin.resume = () => { startStdin(); return stdin; };
    stdin.pipe = (dest) => { stdin.on('data', (d) => dest.write(d)); return dest; };
    stdin.setRawMode = () => stdin;
    stdin.destroy = () => {};
    stdin.ref = () => stdin;
    stdin.unref = () => stdin;
    stdin.on = function on(name, fn) {
      EventEmitter.prototype.on.call(this, name, fn);
      if (name === 'data' || name === 'readable') startStdin();
      return this;
    };
    proc.stdin = stdin;

    const startedAt = Date.now();
    proc.hrtime = (prev) => {
      const ns = (Date.now() - startedAt) * 1e6;
      let s = Math.floor(ns / 1e9);
      let n = ns % 1e9;
      if (prev) {
        s -= prev[0];
        n -= prev[1];
        if (n < 0) { s -= 1; n += 1e9; }
      }
      return [s, n];
    };
    proc.hrtime.bigint = () => BigInt(Date.now() - startedAt) * 1000000n;
    proc.uptime = () => (Date.now() - startedAt) / 1000;
    proc.memoryUsage = () => {
      const info = (typeof kernel.memoryInfo === 'function' ? kernel.memoryInfo() : null) || {};
      const total = info.total ?? 512 * 1024 * 1024;
      const free = info.free ?? Math.floor(total / 2);
      const used = info.used ?? Math.max(0, total - free);
      return { rss: used, heapTotal: total, heapUsed: used, external: 0, arrayBuffers: 0 };
    };
    proc.cpuUsage = () => ({ user: 0, system: 0 });
    proc.resourceUsage = () => ({
      maxRSS: proc.memoryUsage().rss, userCPUTime: 0, systemCPUTime: 0,
      maxRSSRaw: proc.memoryUsage().rss, sharedMemorySize: 0, unsharedDataSize: 0,
      unsharedStackSize: 0, minorPageFault: 0, majorPageFault: 0, swappedOut: 0,
      fsRead: 0, fsWrite: 0, ipcSent: 0, ipcReceived: 0, signalsCount: 0, voluntaryContextSwitches: 0,
      involuntaryContextSwitches: 0,
    });
    proc.nextTick = (fn, ...a) => { queueMicrotask(() => fn(...a)); };
    proc.exit = (code = proc.exitCode ?? 0) => { throw new ExitSignal(code); };
    proc.abort = () => { throw new ExitSignal(134); };
    proc.kill = (pid, sig) => kernel.kill(pid, sig);
    proc.emitWarning = (warning, typeOrOptions, code) => {
      const type = typeof typeOrOptions === 'string' ? typeOrOptions : (typeOrOptions?.type || 'Warning');
      try { proc.stderr.write(`(node:${proc.pid}) [${type}] ${warning}\n`); } catch { /* ignore */ }
    };
    proc.binding = () => {
      const e = new Error('process.binding() is not supported in the browser sandbox (no native bindings)');
      e.code = 'ERR_NOT_SUPPORTED';
      throw e;
    };
    proc.umask = (mask) => {
      const prev = kernel.vfs.umask ?? 0o022;
      if (mask !== undefined) kernel.vfs.umask = mask;
      return prev;
    };
    proc.disconnect = () => { proc.connected = false; };
    proc.openStdin = () => {};
    proc.hasUncaughtExceptionCaptureCallback = () => false;
    proc.setUncaughtExceptionCaptureCallback = () => {
      throw new Error('process.setUncaughtExceptionCaptureCallback is not supported in the WebOS sandbox');
    };
    proc.getActiveResourcesInfo = () => [];
    proc.memoryUsage.rss = () => proc.memoryUsage().rss;
    return proc;
  };

  /* ------------------------------- globals ------------------------------- */

  runtime.makeGlobals = (filename, esm, sandbox) => {
    const proc = runtime.currentProcess;
    const g = sandbox || runtime.globalObject;
    const fetchImpl = typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null;
    return {
      global: g,
      globalThis: g,
      process: proc,
      Buffer,
      console: runtime.currentConsole,
      setTimeout: (fn, ms, ...args) => runtime._setTimer(proc, fn, ms, args, 'timeout'),
      clearTimeout: (t) => runtime._clearTimer(t),
      setInterval: (fn, ms, ...args) => runtime._setTimer(proc, fn, ms, args, 'interval'),
      clearInterval: (t) => runtime._clearTimer(t),
      setImmediate: (fn, ...args) => runtime._setImmediate(proc, fn, args),
      clearImmediate: (t) => runtime._clearTimer(t),
      queueMicrotask,
      TextEncoder: globalThis.TextEncoder,
      TextDecoder: globalThis.TextDecoder,
      URL: globalThis.URL,
      URLSearchParams: globalThis.URLSearchParams,
      performance: misc.perf_hooks.performance,
      fetch: fetchImpl
        ? (...args) => fetchImpl(...args)
        : () => Promise.reject(Object.assign(new Error('fetch() is not available in this environment'), { code: 'ENETUNREACH' })),
      structuredClone: typeof globalThis.structuredClone === 'function'
        ? globalThis.structuredClone.bind(globalThis)
        : (value) => JSON.parse(JSON.stringify(value)),
      atob: typeof globalThis.atob === 'function' ? globalThis.atob.bind(globalThis) : undefined,
      btoa: typeof globalThis.btoa === 'function' ? globalThis.btoa.bind(globalThis) : undefined,
      crypto: globalThis.crypto,
    };
  };

  const MODULE_PARAMS = new Set([
    'exports', 'require', 'module', '__filename', '__dirname', '__webos_scope', 'arguments',
  ]);

  runtime.executeModule = (mod, requireFn, code, filename, esm) => {
    const dirname = filename.startsWith('/')
      ? (filename.slice(0, filename.lastIndexOf('/')) || '/')
      : runtime.cwdDir();
    const globals = runtime.makeGlobals(filename, esm);
    const scope = new Proxy(globals, {
      has: (target, key) => typeof key === 'string' && !MODULE_PARAMS.has(key),
      get: (target, key) => {
        if (typeof key !== 'string') return undefined;
        if (key in target) return target[key];
        return globalThis[key];
      },
      set: (target, key, value) => {
        if (typeof key === 'string') target[key] = value;
        return true;
      },
    });
    const sourceBody = `with (__webos_scope) {\n${code}\n}\n//# sourceURL=${filename}`;
    let fn;
    try {
      fn = new Function(
        '__webos_scope', 'exports', 'require', 'module', '__filename', '__dirname',
        sourceBody,
      );
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      // Top-level await: run the body as an async function. Callers must await
      // mod.__execPromise before observing exports.
      const asyncFn = new AsyncFunction(
        '__webos_scope', 'exports', 'require', 'module', '__filename', '__dirname',
        sourceBody,
      );
      mod.__execPromise = asyncFn.call(mod.exports, scope, mod.exports, requireFn, mod, filename, dirname);
      return;
    }
    fn.call(mod.exports, scope, mod.exports, requireFn, mod, filename, dirname);
  };
  function makeRunIO(io) {
    if (io && io.stdout && io.stderr) return io;
    return io || { stdin: null, stdout: null, stderr: null, proc: null };
  }

  /* --------------------------------- APIs --------------------------------- */

  runtime.runCode = async (code, options = {}) => {
    const {
      filename = '[eval]', args = [], env = {}, io = null, cwd, esm = false, worker = null,
    } = options || {};
    const runCwd = cwd || env?.PWD || runtime.cwdDir() || '/home/user';
    const prevProc = runtime.currentProcess;
    const prevConsole = runtime.currentConsole;
    const prevMain = runtime.mainModule;
    const prevWorker = runtime.workerContext;
    const proc = runtime._createProcess({
      argv: ['node', ...(filename && filename !== '[eval]' && !filename.startsWith('[') ? [filename] : []), ...args],
      env, cwd: runCwd, io,
    });
    runtime.currentProcess = proc;
    runtime.currentConsole = runtime._createConsole(makeRunIO(io));
    if (worker) runtime.workerContext = worker;
    let exitCode = 0;
    try {
      const mod = new Module(filename, filename, runtime);
      mod.parent = null;
      const dirname = filename.startsWith('/')
        ? (filename.slice(0, filename.lastIndexOf('/')) || '/')
        : runCwd;
      runtime.mainModule = mod;
      const requireFn = runtime.loader.makeRequire(mod, dirname);
      mod.require = requireFn;
      let sourceText = String(code);
      if (sourceText.startsWith('#!')) sourceText = '//' + sourceText.slice(2);
      const finalCode = esm ? transformESM(sourceText, filename) : sourceText;
      runtime.executeModule(mod, requireFn, finalCode, filename, esm);
      if (mod.__execPromise) await mod.__execPromise;
      await runtime._drainTimers(proc);
      exitCode = proc.exitCode ?? 0;
    } catch (e) {
      if (e instanceof ExitSignal) exitCode = e.code;
      else { runtime._reportError(proc, e); exitCode = 1; }
    }
    runtime._clearAllTimers();
    try { proc.emit('exit', exitCode); } catch { /* ignore listener errors */ }
    runtime.currentProcess = prevProc;
    runtime.currentConsole = prevConsole;
    runtime.mainModule = prevMain;
    runtime.workerContext = prevWorker;
    return exitCode;
  };

  runtime.runFile = async (inputPath, args = [], io = null, env = {}, opts = {}) => {
    const base = opts.cwd || io?.proc?.cwd || env?.PWD || runtime.cwdDir() || '/home/user';
    let filename = String(inputPath);
    if (!filename.startsWith('/')) filename = path.join(base, filename);
    filename = path.normalize(filename);

    const uid = opts.uid ?? io?.proc?.uid ?? 1000;
    const gid = opts.gid ?? io?.proc?.gid ?? 1000;
    const groups = opts.groups ?? io?.proc?.groups ?? [gid];
    const fileCred = { uid, gid, groups, cwd: base };

    let stat;
    try { stat = runtime.vfs.stat(filename, fileCred); } catch (e) {
      const sink = io?.stderr;
      const text = `node: ${e.code === 'ENOENT' ? `Cannot find module '${filename}'` : e.message}\n`;
      try { sink?.write(text); } catch { /* ignore */ }
      return 1;
    }
    if (stat.isDirectory()) {
      try { io?.stderr?.write(`node: ${filename}: is a directory\n`); } catch { /* ignore */ }
      return 1;
    }
    if (filename.endsWith('.node')) {
      try {
        io?.stderr?.write(`node: ${filename}: native addons (.node) are not supported in the browser sandbox\n`);
      } catch { /* ignore */ }
      return 1;
    }

    const prevProc = runtime.currentProcess;
    const prevConsole = runtime.currentConsole;
    const prevMain = runtime.mainModule;
    const prevWorker = runtime.workerContext;
    const proc = runtime._createProcess({
      argv: ['node', filename, ...args],
      env, cwd: base, io,
      uid, gid, groups,
      pid: io?.proc?.pid,
      ppid: io?.proc?.ppid,
    });
    runtime.currentProcess = proc;
    runtime.currentConsole = runtime._createConsole(makeRunIO(io));
    if (opts.worker) runtime.workerContext = opts.worker;

    if (opts.ipc) {
      proc.connected = true;
      proc.send = (message, sendHandle, options2, cb) => {
        if (typeof options2 === 'function') cb = options2;
        try { opts.ipc.postMessage(message); } catch (e) { if (typeof cb === 'function') queueMicrotask(() => cb(e)); return false; }
        if (typeof cb === 'function') queueMicrotask(() => cb(null));
        return true;
      };
      if (typeof opts.ipc.on === 'function') opts.ipc.on('message', (msg) => proc.emit('message', msg));
      if (typeof opts.ipc.start === 'function') opts.ipc.start();
    }

    let exitCode = 0;
    try {
      const dirname = filename.slice(0, filename.lastIndexOf('/')) || '/';
      const mod = new Module(filename, filename, runtime);
      mod.parent = null;
      runtime.mainModule = mod;
      const requireFn = runtime.loader.makeRequire(mod, dirname);
      mod.require = requireFn;
      runtime.loader.cache[filename] = mod;
      let source = runtime.readFileText(filename);
      if (source.startsWith('#!')) source = '//' + source.slice(2);
      if (filename.endsWith('.json')) {
        mod.exports = JSON.parse(source);
        mod.loaded = true;
      } else if (runtime.loader.isEsmFile(filename)) {
        const transformed = transformESM(source, filename);
        runtime.executeModule(mod, requireFn, transformed, filename, true);
        if (mod.__execPromise) await mod.__execPromise;
        mod.loaded = true;
      } else {
        runtime.executeModule(mod, requireFn, source, filename, false);
        if (mod.__execPromise) await mod.__execPromise;
        mod.loaded = true;
      }
      await runtime._drainTimers(proc);
      exitCode = proc.exitCode ?? 0;
    } catch (e) {
      if (e instanceof ExitSignal) exitCode = e.code;
      else if (e && e.code === 'ERR_INVALID_JSON') { runtime._reportError(proc, e); exitCode = 1; }
      else { runtime._reportError(proc, e); exitCode = 1; }
    }
    runtime._clearAllTimers();
    try { proc.emit('exit', exitCode); } catch { /* ignore listener errors */ }
    runtime.currentProcess = prevProc;
    runtime.currentConsole = prevConsole;
    runtime.mainModule = prevMain;
    runtime.workerContext = prevWorker;
    return exitCode;
  };

  runtime.requireFrom = (request, options = {}) => {
    const { filename, dirname, env = {}, cwd } = options || {};
    const prevProc = runtime.currentProcess;
    let temp = null;
    if (!prevProc) {
      temp = runtime._createProcess({ argv: ['node'], env, cwd: cwd || '/', io: null });
      runtime.currentProcess = temp;
      if (!runtime.currentConsole) runtime.currentConsole = runtime._createConsole({});
    }
    try {
      return runtime.loader.require(request, filename, dirname || cwd || runtime.cwdDir());
    } finally {
      if (temp) runtime.currentProcess = prevProc;
    }
  };

  runtime.loader = createLoader(runtime);
  moduleBuiltin._cache = runtime.loader.cache;
  Module._cache = runtime.loader.cache;

  /* ---------------------------- shell commands ---------------------------- */

  const NODE_VERSION = 'v22.0.0-webos';
  const NPM_VERSION = '10.0.0-webos';

  const shellQuote = (value) => {
    const text = String(value);
    return /^[A-Za-z0-9_@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
  };

  const ioOf = (c) => ({ stdin: c.stdin, stdout: c.stdout, stderr: c.stderr, proc: c.proc });
  const absPath = (c, p) => (String(p).startsWith('/') ? path.normalize(String(p)) : path.normalize(path.join(c.cwd, String(p))));

  const runShellLine = (c, line, extraEnv = {}) => {
    const sh = c.shell.clone();
    sh.cwd = c.cwd;
    sh.oldpwd = c.oldpwd || c.cwd;
    for (const [key, value] of Object.entries(extraEnv)) {
      sh.vars.set(key, String(value));
      sh.exports.add(key);
    }
    const binDir = path.join(c.cwd, 'node_modules/.bin');
    const currentPath = sh.getVar('PATH') || '';
    if (!currentPath.split(':').includes(binDir)) {
      sh.vars.set('PATH', `${binDir}:${currentPath}`);
      sh.exports.add('PATH');
    }
    const session = sh.startSession(line, {
      stdin: c.stdin, stdout: c.stdout, stderr: c.stderr, ppid: c.proc?.pid ?? 1,
    });
    return session.done.then((result) => result.code);
  };

  const readPackageJson = (c, dir = c.cwd) => {
    const file = path.join(dir, 'package.json');
    try {
      return JSON.parse(Buffer.from(c.vfs.readFile(file, c.cred())).toString('utf8'));
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ENOTDIR') return null;
      throw e;
    }
  };

  const writePackageJson = (c, pkg, dir = c.cwd) => {
    c.vfs.writeFile(path.join(dir, 'package.json'), Buffer.from(JSON.stringify(pkg, null, 2) + '\n'), c.cred());
  };

  const splitKey = (key) => String(key).split('.').filter(Boolean);
  const getPath = (obj, key) => {
    let cur = obj;
    for (const part of splitKey(key)) {
      if (cur === null || typeof cur !== 'object') return undefined;
      cur = cur[part];
    }
    return cur;
  };
  const setPath = (obj, key, value) => {
    const parts = splitKey(key);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  };
  const deletePath = (obj, key) => {
    const parts = splitKey(key);
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = cur?.[parts[i]];
      if (!cur || typeof cur !== 'object') return;
    }
    if (cur) delete cur[parts[parts.length - 1]];
  };

  const printNodeHelp = (c) => {
    c.out([
      `Usage: node [options] [script.js] [arguments]`,
      '',
      'Options:',
      '  -e, --eval <script>     evaluate the script',
      '  -p, --print <script>    evaluate and print the result',
      '  -c, --check             syntax check the script without executing',
      '  -r, --require <module>  preload a module before running',
      '  -v, --version           print the Node.js version',
      '  --input-type <type>     "module" or "commonjs" for string input',
      '  --                      end of options',
      '',
    ].join('\n'));
  };

  const printNpmHelp = (c) => {
    c.out([
      `npm ${NPM_VERSION} (offline WebOS build)`,
      '',
      'Usage: npm <command>',
      '',
      'Commands:',
      '  run <script> [-- args]   run a package.json script',
      '  test | start | stop | restart',
      '  ls                       list dependencies',
      '  init -y                  create package.json with defaults',
      '  pkg get|set|delete <key> edit package.json',
      '  version                  print npm version',
      '',
      'Installing packages from the registry is unavailable in the offline',
      'sandbox; dependencies must already be present under node_modules.',
      '',
    ].join('\n'));
  };

  const printNpxHelp = (c) => {
    c.out([
      `npx ${NPM_VERSION} (offline WebOS build)`,
      '',
      'Usage: npx [options] <command> [args...]',
      '',
      'Runs a binary from node_modules/.bin or a shell command. Downloading',
      'packages from the npm registry is unavailable in the offline sandbox.',
      '',
    ].join('\n'));
  };

  const nodeCommand = async (c) => {
    const argv = c.args.slice();
    const io = ioOf(c);
    let evalCode = null;
    let printResult = false;
    let checkOnly = false;
    let inputType = null;
    const preloads = [];
    const operands = [];
    let afterSeparator = false;

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (afterSeparator) { operands.push(arg); continue; }
      if (arg === '--') { afterSeparator = true; continue; }
      if (arg === '-v' || arg === '--version') { c.out(`${NODE_VERSION}\n`); return 0; }
      if (arg === '-h' || arg === '--help') { printNodeHelp(c); return 0; }
      if (arg === '-e' || arg === '--eval') {
        if (i + 1 >= argv.length) { c.err('node: -e requires an argument\n'); return 9; }
        evalCode = argv[++i];
        continue;
      }
      if (arg.startsWith('--eval=')) { evalCode = arg.slice(7); continue; }
      if (arg === '-p' || arg === '--print') {
        if (i + 1 >= argv.length) { c.err('node: -p requires an argument\n'); return 9; }
        evalCode = argv[++i];
        printResult = true;
        continue;
      }
      if (arg.startsWith('--print=')) { evalCode = arg.slice(8); printResult = true; continue; }
      if (arg === '-c' || arg === '--check') { checkOnly = true; continue; }
      if (arg === '-r' || arg === '--require') {
        if (i + 1 >= argv.length) { c.err('node: -r requires an argument\n'); return 9; }
        preloads.push(argv[++i]);
        continue;
      }
      if (arg.startsWith('--require=')) { preloads.push(arg.slice(10)); continue; }
      if (arg === '--input-type') { inputType = argv[++i] ?? null; continue; }
      if (arg.startsWith('--input-type=')) { inputType = arg.slice(13); continue; }
      if (arg === '-i' || arg === '--interactive' || arg === '--watch' || arg === '--no-warnings'
        || arg === '--enable-source-maps'
        || arg.startsWith('--experimental') || arg.startsWith('--trace-')
        || arg.startsWith('--inspect') || arg.startsWith('--max-old-space-size=')
        || arg.startsWith('--stack-trace-limit=') || arg.startsWith('--conditions=')
        || arg.startsWith('--env-file') || arg.startsWith('--title=')
        || arg.startsWith('--preserve-symlinks')) continue;
      if (arg.startsWith('-') && arg !== '-') {
        c.err(`node: bad option: ${arg}\n`);
        return 9;
      }
      operands.push(arg);
    }

    let script = operands[0];
    const scriptArgs = operands.slice(1);
    const compileCheck = (source, filename) => {
      const useEsm = inputType === 'module' || filename.endsWith('.mjs');
      const code = useEsm ? transformESM(source, filename) : source;
      new Function('exports', 'require', 'module', '__filename', '__dirname', code);
    };

    try {
      for (const spec of preloads) {
        runtime.requireFrom(spec, { filename: '[preload]', cwd: c.cwd, env: c.env });
      }
    } catch (e) {
      c.err(`${e?.stack || e}\n`);
      return 1;
    }

    if (checkOnly) {
      let source;
      let filename;
      if (evalCode !== null) { source = evalCode; filename = '[eval]'; }
      else if (script && script !== '-') {
        filename = absPath(c, script);
        try { source = Buffer.from(c.vfs.readFile(filename, c.cred())).toString('utf8'); }
        catch (e) { c.err(`node: ${e?.message || e}\n`); return 1; }
      } else { source = await c.readText(); filename = '[stdin]'; }
      if (source.startsWith('#!')) source = '//' + source.slice(2);
      try { compileCheck(source, filename); } catch (e) {
        c.err(`${e?.stack || e}\n`);
        return 1;
      }
      return 0;
    }

    if (evalCode !== null) {
      let code = evalCode;
      let filename = '[eval]';
      if (printResult) {
        try {
          new Function(`return (\n${code}\n);`);
          code = `console.log((\n${code}\n));`;
        } catch { /* statement list: run without printing */ }
      }
      if (inputType === 'module') filename = '[eval1.mjs]';
      return runtime.runCode(code, {
        filename, args: operands, env: c.env, io, cwd: c.cwd, esm: inputType === 'module',
      });
    }

    if (script && script !== '-') {
      return runtime.runFile(absPath(c, script), scriptArgs, io, c.env, { cwd: c.cwd });
    }

    const source = await c.readText();
    return runtime.runCode(source, {
      filename: '[stdin]', args: operands, env: c.env, io, cwd: c.cwd, esm: inputType === 'module',
    });
  };

  const npmRun = async (c, name, extraArgs = []) => {
    const pkg = readPackageJson(c);
    if (!pkg) { c.err('npm ERR! Could not find a package.json file.\n'); return 1; }
    const scripts = pkg.scripts || {};
    const pkgLabel = `${pkg.name || path.basename(c.cwd)}@${pkg.version || '0.0.0'}`;
    if (!name) {
      c.out(`Scripts available in ${pkgLabel} via \`npm run\`:\n`);
      const names = Object.keys(scripts);
      if (!names.length) c.out('  (none)\n');
      for (const key of names) c.out(`  ${key}\n    ${scripts[key]}\n`);
      return 0;
    }
    if (typeof scripts[name] !== 'string') {
      c.err(`npm ERR! Missing script: "${name}"\n`);
      if (Object.keys(scripts).length) c.err('npm ERR! To see a list of scripts, run:\n  npm run\n');
      return 1;
    }
    const suffix = extraArgs.length ? ' ' + extraArgs.map(shellQuote).join(' ') : '';
    const lifecycleEnv = {
      npm_lifecycle_event: name,
      npm_lifecycle_script: scripts[name],
      npm_package_name: pkg.name || '',
      npm_package_version: pkg.version || '',
      npm_execpath: '/usr/lib/node_modules/npm/bin/npm-cli.js',
      npm_node_execpath: '/usr/bin/node',
      npm_command: 'run-script',
      npm_config_user_agent: `npm/${NPM_VERSION} node/${NODE_VERSION.slice(1)} webos`,
    };
    for (const step of [`pre${name}`, name, `post${name}`]) {
      const script = scripts[step];
      if (typeof script !== 'string' || script === '') continue;
      const line = step === name ? script + suffix : script;
      c.out(`\n> ${pkgLabel} ${step}\n> ${line}\n\n`);
      const code = await runShellLine(c, line, { ...lifecycleEnv, npm_lifecycle_event: step, npm_lifecycle_script: script });
      if (code !== 0) return code;
    }
    return 0;
  };

  const npmLs = (c) => {
    const pkg = readPackageJson(c);
    const name = pkg?.name || path.basename(c.cwd) || c.cwd;
    c.out(`${name}@${pkg?.version || '0.0.0'} ${c.cwd}\n`);
    const deps = {};
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
      for (const [dep, range] of Object.entries(pkg?.[field] || {})) if (!(dep in deps)) deps[dep] = range;
    }
    const keys = Object.keys(deps).sort();
    if (!keys.length) { c.out('└── (empty)\n'); return 0; }
    let missing = 0;
    keys.forEach((dep, i) => {
      const last = i === keys.length - 1;
      let installed = null;
      try {
        const file = path.join(c.cwd, 'node_modules', dep, 'package.json');
        installed = JSON.parse(Buffer.from(c.vfs.readFile(file, c.cred())).toString('utf8')).version || null;
      } catch { /* not installed */ }
      if (!installed) missing++;
      const label = installed ? `${dep}@${installed}` : `${dep}@${deps[dep]} (missing)`;
      c.out(`${last ? '└──' : '├──'} ${label}\n`);
    });
    return missing ? 1 : 0;
  };

  const npmInit = (c, rest) => {
    const yes = rest.includes('-y') || rest.includes('--yes');
    const existing = readPackageJson(c);
    if (existing) {
      if (!yes) { c.err('npm ERR! package.json already exists\n'); return 1; }
      c.out(`npm warn init: package.json already exists in ${c.cwd}\n`);
      return 0;
    }
    if (!yes) {
      c.err('npm ERR! The interactive initializer is unavailable; use `npm init -y`.\n');
      return 1;
    }
    const base = path.basename(c.cwd) || 'webos-package';
    const name = base.toLowerCase().replace(/[^a-z0-9._~-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '') || 'webos-package';
    const pkg = {
      name,
      version: '1.0.0',
      description: '',
      main: 'index.js',
      scripts: { test: 'echo "Error: no test specified" && exit 1' },
      keywords: [],
      author: '',
      license: 'ISC',
    };
    writePackageJson(c, pkg);
    c.out(`Wrote to ${path.join(c.cwd, 'package.json')}:\n\n${JSON.stringify(pkg, null, 2)}\n`);
    return 0;
  };

  const npmPkg = (c, rest) => {
    if (!rest.length) {
      c.err('npm ERR! Usage: npm pkg get|set|delete <key> ...\n');
      return 1;
    }
    const action = rest[0];
    const keys = rest.slice(1);
    const pkg = readPackageJson(c) || {};
    if (action === 'get') {
      if (!keys.length) { c.out(`${JSON.stringify(pkg, null, 2)}\n`); return 0; }
      const result = {};
      for (const rawKey of keys) {
        const key = rawKey.replace(/^["']|["']$/g, '');
        const value = getPath(pkg, key);
        if (value !== undefined) setPath(result, key, value);
      }
      c.out(`${JSON.stringify(result, null, 2)}\n`);
      return 0;
    }
    if (action === 'set') {
      if (!keys.length) { c.err('npm ERR! Usage: npm pkg set <key>=<value> ...\n'); return 1; }
      for (const assignment of keys) {
        const eq = assignment.indexOf('=');
        if (eq < 0) { c.err(`npm ERR! Invalid package key: ${assignment}\n`); return 1; }
        const key = assignment.slice(0, eq).replace(/^["']|["']$/g, '');
        let value = assignment.slice(eq + 1).replace(/^["']|["']$/g, '');
        if (/^(true|false|null|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/.test(value) || /^[[{]/.test(value)) {
          try { value = JSON.parse(value); } catch { /* keep string */ }
        }
        setPath(pkg, key, value);
      }
      writePackageJson(c, pkg);
      return 0;
    }
    if (action === 'delete' || action === 'del') {
      if (!keys.length) { c.err('npm ERR! Usage: npm pkg delete <key> ...\n'); return 1; }
      for (const rawKey of keys) deletePath(pkg, rawKey.replace(/^["']|["']$/g, ''));
      writePackageJson(c, pkg);
      return 0;
    }
    c.err(`npm ERR! Unknown pkg subcommand: ${action}\n`);
    return 1;
  };

  const npmCommand = async (c) => {
    const argv = c.args.slice();
    if (!argv.length) { printNpmHelp(c); return 0; }
    if (argv[0] === '-v' || argv[0] === '--version') { c.out(`${NPM_VERSION}\n`); return 0; }
    if (argv[0] === '-h' || argv[0] === '--help') { printNpmHelp(c); return 0; }
    const command = argv.shift();
    const rest = argv;
    switch (command) {
      case 'help': printNpmHelp(c); return 0;
      case 'run': case 'run-script': return npmRun(c, rest[0], rest.slice(1));
      case 'test': case 'start': case 'stop': case 'restart':
        return npmRun(c, command, rest);
      case 'ls': case 'list': return npmLs(c);
      case 'init': return npmInit(c, rest);
      case 'pkg': return npmPkg(c, rest);
      case 'version': c.out(`${NPM_VERSION}\n`); return 0;
      case 'install': case 'i': case 'add': case 'ci': case 'clean-install':
      case 'uninstall': case 'remove': case 'rm': case 'update': case 'up':
      case 'exec': case 'x':
        c.err(`npm: '${command}' requires downloading packages from the npm registry,\n`);
        c.err('which is not reachable in the offline WebOS sandbox.\n');
        c.err('Dependencies must already exist under node_modules; use "npm run <script>" for local scripts.\n');
        return 1;
      default:
        c.err(`npm: unknown command: ${command}\n`);
        printNpmHelp(c);
        return 1;
    }
  };

  const npxCommand = async (c) => {
    const argv = c.args.slice();
    const rest = [];
    let command = null;
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (command !== null) { rest.push(arg); continue; }
      if (arg === '--') continue;
      if (arg === '-v' || arg === '--version') { c.out(`${NPM_VERSION}\n`); return 0; }
      if (arg === '-h' || arg === '--help') { printNpxHelp(c); return 0; }
      if (arg === '-y' || arg === '--yes' || arg === '--no-install' || arg === '--quiet' || arg === '-q') continue;
      if (arg === '--package' || arg === '-p') { i++; continue; }
      if (arg.startsWith('--package=') || arg.startsWith('-')) continue;
      command = arg;
    }
    if (!command) { c.err('npx: missing command\n'); printNpxHelp(c); return 1; }

    const binName = command.startsWith('@')
      ? (command.split('/')[1] || command).split('@')[0]
      : command.split('@')[0];

    if (command.includes('/')) {
      try {
        const abs = absPath(c, command);
        c.vfs.stat(abs, c.cred());
        return runtime.runFile(abs, rest, ioOf(c), c.env, { cwd: c.cwd });
      } catch { /* not a path, keep looking */ }
    }

    let dir = c.cwd;
    let binPath = null;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', '.bin', binName);
      try { c.vfs.stat(candidate, c.cred()); binPath = candidate; break; } catch { /* keep walking */ }
      if (dir === '/') break;
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
    }

    if (binPath) {
      try {
        const head = new TextDecoder().decode(
          Buffer.from(c.vfs.readFile(binPath, c.cred())).slice(0, 128),
        );
        if (head.startsWith('#!') && !/\bnode(js)?\b/.test(head.split('\n')[0])) {
          return runShellLine(c, [binPath, ...rest].map(shellQuote).join(' '));
        }
        return runtime.runFile(binPath, rest, ioOf(c), c.env, { cwd: c.cwd });
      } catch (e) {
        c.err(`npx: ${e?.message || e}\n`);
        return 1;
      }
    }

    if (c.kernel.commands.has(binName)) {
      return runShellLine(c, [binName, ...rest].map(shellQuote).join(' '));
    }

    c.err(`npx: command not found: ${command}\n`);
    c.err('npx cannot download packages: the npm registry is not reachable in the offline WebOS sandbox.\n');
    return 1;
  };

  runtime.install = () => {
    if (runtime.installed) return runtime;
    runtime.installed = true;
    const nodeDef = { summary: 'Node.js-compatible JavaScript runtime', run: nodeCommand };
    kernel.registerCommand('node', nodeDef);
    kernel.registerCommand('nodejs', nodeDef);
    kernel.registerCommand('npm', { summary: 'npm-compatible package manager (offline)', run: npmCommand });
    kernel.registerCommand('npx', { summary: 'run a local Node.js binary (offline)', run: npxCommand });
    return runtime;
  };

  kernel.nodeRuntime = runtime;
  return runtime;
}
