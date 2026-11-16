/* WebOS public API.
 *
 * createWebOS() boots a virtual Linux kernel (in-memory VFS, process table,
 * /proc, users/groups) and returns a headless API: no DOM, no terminal, no
 * UI. Every call goes through the JavaScript shell and command table.
 */

import { Kernel } from './kernel/kernel.js';
import { Shell } from './shell/shell.js';
import { registerAllCommands } from './commands/index.js';
import { createNodeRuntime } from './node/runtime.js';
import { sourceFromBytes, sourceFromText, decode } from './kernel/io.js';
import { ErrnoError, O } from './kernel/vfs.js';
import { exportState, importState } from './kernel/snapshot.js';

export function createWebOS(opts = {}) {
  const kernel = new Kernel(opts);
  kernel.boot();
  registerAllCommands(kernel);

  const node = createNodeRuntime(kernel);
  kernel.nodeRuntime = node;
  node.install();

  if (opts.snapshot) importState(kernel, opts.snapshot);

  /** Create a shell bound to a user/cwd/env. */
  function createShell(shellOpts = {}) {
    return new Shell(kernel, {
      user: shellOpts.user || opts.user || 'user',
      cwd: shellOpts.cwd,
      env: { ...(opts.env || {}), ...(shellOpts.env || {}) },
      interactive: false,
    });
  }

  /**
   * Run a shell command line and collect its output.
   * @returns {Promise<{code:number, stdout:string, stderr:string, pid:number}>}
   */
  async function exec(command, runOpts = {}) {
    const shell = runOpts.shell || createShell(runOpts);
    if (runOpts.cwd) shell.cwd = runOpts.cwd;
    if (runOpts.env) for (const [k, v] of Object.entries(runOpts.env)) { shell.vars.set(k, String(v)); shell.exports.add(k); }
    const stdin = runOpts.stdin == null
      ? sourceFromBytes('')
      : (runOpts.stdin instanceof Uint8Array ? sourceFromBytes(runOpts.stdin) : sourceFromText(String(runOpts.stdin)));
    const session = shell.startSession(command, {
      stdin,
      ppid: runOpts.ppid ?? 1,
      name: runOpts.name || 'sh',
    });
    const res = await session.done;
    return { code: res.code, stdout: res.stdout ?? '', stderr: res.stderr ?? '', pid: res.pid };
  }

  /** Run a command line as another user (root by default). */
  function execAs(user, command, runOpts = {}) {
    return exec(command, { ...runOpts, user });
  }

  /**
   * Start a command line without waiting; returns live streams.
   * @returns {{pid:number, stdout:Channel, stderr:Channel, done:Promise<object>}}
   */
  function spawn(command, runOpts = {}) {
    const shell = runOpts.shell || createShell(runOpts);
    if (runOpts.cwd) shell.cwd = runOpts.cwd;
    const stdin = runOpts.stdin == null
      ? sourceFromBytes('')
      : (runOpts.stdin instanceof Uint8Array ? sourceFromBytes(runOpts.stdin) : sourceFromText(String(runOpts.stdin)));
    return shell.startSession(command, { stdin, ppid: runOpts.ppid ?? 1, name: runOpts.name || 'sh' });
  }

  /** Run a Node.js source file through the JS runtime. */
  async function runNodeFile(path, args = [], runOpts = {}) {
    const out = [];
    const err = [];
    const io = {
      stdin: sourceFromBytes(runOpts.stdin ? String(runOpts.stdin) : ''),
      stdout: { write: (s) => { out.push(typeof s === 'string' ? s : decode(s)); } },
      stderr: { write: (s) => { err.push(typeof s === 'string' ? s : decode(s)); } },
    };
    const code = await node.runFile(path, args, io, { ...(opts.env || {}), ...(runOpts.env || {}) }, { cwd: runOpts.cwd });
    return { code, stdout: out.join(''), stderr: err.join('') };
  }

  function registerCommand(name, def) {
    kernel.registerCommand(name, def);
  }

  const fs = {
    readFile(path, enc = 'utf8') {
      const bytes = kernel.vfs.readFile(path, { uid: 0, gid: 0, groups: [0] });
      return enc === 'utf8' || enc === 'utf-8' ? decode(bytes) : bytes;
    },
    writeFile(path, data) {
      kernel.vfs.writeFile(path, data, { uid: 0, gid: 0, groups: [0] });
    },
    readdir(path) {
      return [...kernel.vfs.readdirNodes(path, { uid: 0, gid: 0, groups: [0] })].map(([name]) => name);
    },
    stat(path) { return kernel.vfs.stat(path, { uid: 0, gid: 0, groups: [0] }); },
    mkdir(path, mode = 0o755) { kernel.vfs.mkdir(path, { uid: 0, gid: 0, groups: [0] }, mode); },
    mkdirp(path, mode = 0o755) { return kernel.vfs.mkdirp(path, { uid: 0, gid: 0, groups: [0] }, mode); },
    unlink(path) { kernel.vfs.unlink(path, { uid: 0, gid: 0, groups: [0] }); },
    rmdir(path) { kernel.vfs.rmdir(path, { uid: 0, gid: 0, groups: [0] }); },
    rename(a, b) { kernel.vfs.rename(a, b, { uid: 0, gid: 0, groups: [0] }); },
    exists(path) { return kernel.vfs.exists(path); },
    realpath(path) { return kernel.vfs.realpath(path, { uid: 0, gid: 0, groups: [0] }); },
    chmod(path, mode) { kernel.vfs.chmod(path, mode, { uid: 0, gid: 0, groups: [0] }); },
    O,
    ErrnoError,
  };

  return {
    kernel,
    node,
    fs,
    exec,
    execAs,
    spawn,
    createShell,
    runNodeFile,
    registerCommand,
    /** Low-level Linux-style syscall dispatch. */
    syscall: (name, args = [], ctx = {}) => kernel.syscall(name, args, ctx),
    mount: (source, target, fstype = 'tmpfs', flags = 'rw') => kernel.mount(source, target, fstype, flags),
    umount: (target) => kernel.umount(target),
    /** Kernel log ring buffer (also /dev/kmsg, dmesg). */
    log: kernel.log,
    ipc: kernel.ipc,
    /** Persistent machine snapshot: JSON-serializable. */
    snapshot: () => exportState(kernel),
    restore: (state) => importState(kernel, state),
    get stats() { return kernel.stats; },
    get commands() { return kernel.commands; },
    get users() { return kernel.users; },
    get groups() { return kernel.groups; },
    info: () => kernel.info(),
  };
}

export { Kernel, Shell };
export default createWebOS;
