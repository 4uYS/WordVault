/*
 * `child_process` on top of the WebOS shell. There is no OS process
 * primitive in the browser, so children are cooperative shell sessions.
 * Synchronous execution is impossible without blocking the event loop and is
 * reported as an explicit, typed error.
 */

import { Shell } from '../shell/shell.js';
import { Channel, sourceFromChannel } from '../kernel/io.js';
import { EventEmitter } from './events.js';
import { Readable, Writable } from './stream.js';
import { Buffer } from './buffer.js';
import { MessageChannel } from './worker.js';

const quote = (s) => (/^[A-Za-z0-9_./:=@%+-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`);

function syncUnsupported(name) {
  return function () {
    const e = new Error(
      `${name} cannot work in the browser sandbox: synchronous child processes would require blocking the event loop. Use the async spawn()/exec() APIs instead.`,
    );
    e.code = 'ERR_CHILD_PROCESS_SYNC_UNSUPPORTED';
    throw e;
  };
}

export function createChildProcess(runtime) {
  const kernel = runtime.kernel;

  class ChildProcess extends EventEmitter {
    constructor(command) {
      super();
      this.spawnfile = command;
      this.spawnargs = [];
      this.pid = undefined;
      this.connected = false;
      this.killed = false;
      this.exitCode = null;
      this.signalCode = null;
      this.stdin = null;
      this.stdout = null;
      this.stderr = null;
      this.channel = null;
    }
    kill(signal = 'SIGTERM') {
      if (this.pid === undefined) return false;
      this.killed = true;
      try { return kernel.kill(this.pid, signal); } catch { return false; }
    }
    disconnect() { this.connected = false; }
    ref() { return this; }
    unref() { return this; }
  }

  function spawn(command, args, options) {
    if (!Array.isArray(args)) { options = args || {}; args = []; }
    options = options || {};
    const child = new ChildProcess(command);
    child.spawnargs = [command, ...args];

    const stdout = new Readable();
    const stderr = new Readable();
    child.stdout = stdout;
    child.stderr = stderr;

    const stdinChannel = new Channel();
    child.stdin = new Writable({
      write(chunk, enc, cb) { try { stdinChannel.write(chunk); cb(); } catch (e) { cb(e); } },
      final(cb) { stdinChannel.end(); cb(); },
    });

    const outSink = {
      write: (b) => { if (!stdout.destroyed) stdout.push(Buffer.from(b)); return true; },
      end: () => { if (!stdout.destroyed) stdout.push(null); },
      get closed() { return stdout.destroyed; },
    };
    const errSink = {
      write: (b) => { if (!stderr.destroyed) stderr.push(Buffer.from(b)); return true; },
      end: () => { if (!stderr.destroyed) stderr.push(null); },
      get closed() { return stderr.destroyed; },
    };

    let timeoutHandle = null;
    if (options.timeout) {
      timeoutHandle = setTimeout(() => {
        child.killed = true;
        if (child.pid !== undefined) {
          try { kernel.kill(child.pid, 'SIGTERM'); } catch { /* noop */ }
          child.emit('timeout');
        }
      }, options.timeout);
    }

    queueMicrotask(() => {
      runtime._trackAsync((async () => {
        let line;
        if (options.shell === false) line = [command, ...args].map(quote).join(' ');
        else line = args.length ? `${quote(command)} ${args.map(quote).join(' ')}` : String(command);
        const user = options.uid != null ? kernel.userByUid(options.uid)?.name : undefined;
        try {
          const shell = new Shell(kernel, {
            user: user || 'user',
            cwd: options.cwd || undefined,
            env: options.env || {},
            argv0: 'sh',
          });
          const session = shell.startSession(line, {
            stdin: sourceFromChannel(stdinChannel),
            stdout: outSink,
            stderr: errSink,
            ppid: 1,
          });
          child.pid = session.pid;
          child.connected = true;
          child.emit('spawn');
          const result = await session.done;
          if (timeoutHandle) clearTimeout(timeoutHandle);
          child.exitCode = result.code;
          child.connected = false;
          child.emit('exit', result.code, null);
          child.emit('close', result.code, null);
        } catch (e) {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          child.emit('error', e);
          child.emit('exit', 1, null);
          child.emit('close', 1, null);
        }
      })());
    });

    return child;
  }

  function exec(command, options, cb) {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    const child = spawn(command, [], { ...options, shell: true });
    let out = '';
    let err = '';
    const encoding = options.encoding || 'utf8';
    const maxBuffer = options.maxBuffer || 1024 * 1024;
    let size = 0;
    child.stdout.on('data', (d) => {
      out += d.toString(encoding);
      size += d.length;
      if (size > maxBuffer) {
        const e = new Error(`maxBuffer length exceeded (${maxBuffer} bytes)`);
        e.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        child.emit('error', e);
        child.kill();
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(encoding); });
    child.on('close', (code, signal) => {
      if (!cb) return;
      if (code === 0 && !signal) { cb(null, out, err); return; }
      const e = new Error(`Command failed: ${command}\n${err}`);
      e.code = code; e.killed = child.killed; e.signal = signal; e.cmd = command;
      cb(e, out, err);
    });
    return child;
  }

  function execFile(file, args, options, cb) {
    if (typeof args === 'function') { cb = args; args = []; options = {}; }
    else if (typeof options === 'function') { cb = options; options = {}; }
    const cmd = [file, ...(args || [])].map(quote).join(' ');
    return exec(cmd, options || {}, cb);
  }

  function fork(modulePath, args = [], options = {}) {
    const child = new ChildProcess(modulePath);
    child.spawnargs = ['node', modulePath, ...args];
    const stdout = new Readable();
    const stderr = new Readable();
    child.stdout = stdout;
    child.stderr = stderr;
    child.stdin = new Writable({ write(c, e, cb) { cb(); } });
    const channel = new MessageChannel();
    child.connected = true;
    child.channel = channel.port1;
    channel.port1.on('message', (msg) => child.emit('message', msg));
    child.send = (message, sendHandle, opts, cb) => {
      if (typeof opts === 'function') cb = opts;
      channel.port1.postMessage(message);
      if (typeof cb === 'function') queueMicrotask(() => cb(null));
      return true;
    };
    channel.port1.on('close', () => { child.connected = false; });

    queueMicrotask(async () => {
      try {
        child.emit('spawn');
        const code = await runtime.runFile(modulePath, args, {
          stdin: sourceFromChannel(new Channel()),
          stdout: { write: (b) => { stdout.push(Buffer.from(b)); return true; }, end: () => stdout.push(null) },
          stderr: { write: (b) => { stderr.push(Buffer.from(b)); return true; }, end: () => stderr.push(null) },
        }, options.env || {}, { ipc: channel.port2, cwd: options.cwd });
        child.exitCode = code;
        child.emit('exit', code, null);
        child.emit('close', code, null);
      } catch (e) {
        child.emit('error', e);
        child.emit('exit', 1, null);
        child.emit('close', 1, null);
      }
    });
    return child;
  }

  return {
    spawn, exec, execFile, fork,
    execSync: syncUnsupported('child_process.execSync'),
    spawnSync: syncUnsupported('child_process.spawnSync'),
    execFileSync: syncUnsupported('child_process.execFileSync'),
    ChildProcess,
  };
}
