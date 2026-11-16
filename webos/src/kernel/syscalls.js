/*
 * A small system-call layer over the virtual kernel.
 *
 * This is what makes WebOS an "OS API" rather than a bag of commands: every
 * call takes a process context, mutates kernel state, and raises ErrnoError
 * with Linux-style errno codes. It is intentionally isomorphic: no host fs,
 * no host processes, no native syscalls.
 */

import { ErrnoError, O, normalizePath, parseFlags } from './vfs.js';
import { CAP, RLIMITS, SIGNALS, signalNumber, signalName } from './process.js';
import { Channel, decode, toBytes } from './io.js';

const fail = (code, path, syscall) => { throw new ErrnoError(code, path, syscall); };
const enc = new TextEncoder();

const CLOCK = { REALTIME: 0, MONOTONIC: 1, PROCESS_CPUTIME_ID: 2, THREAD_CPUTIME_ID: 3 };

/** fd object for an in-memory pipe created by pipe(). */
class PipeEnd {
  constructor(channel, mode, owner) {
    this.channel = channel;
    this.mode = mode;
    this.owner = owner;
    this.closed = false;
    this.buffer = new Uint8Array(0);
  }
  write(data) {
    if (this.closed || this.mode !== 'w') fail('EBADF', 'pipe', 'write');
    if (!this.channel.write(data)) fail('EPIPE', 'pipe', 'write');
    return toBytes(data).length;
  }
  read(max = 65536) {
    if (this.closed || this.mode !== 'r') fail('EBADF', 'pipe', 'read');
    const b = this.channel.take(max);
    return b || new Uint8Array(0);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.mode === 'w') this.channel.end();
    else this.channel.closeRead();
  }
}

/* Channel has no take(); add a small adapter without touching the core file. */
class PipeChannel {
  constructor() { this.ch = new Channel(); }
  write(d) { return this.ch.write(d); }
  end() { this.ch.end(); }
  closeRead() { this.ch.closeRead(); }
  take(max) {
    const chunks = this.ch.chunks;
    if (!chunks.length) return null;
    const parts = [];
    let n = 0;
    while (chunks.length) {
      const b = chunks[0];
      if (n + b.length > max) {
        const want = max - n;
        parts.push(b.subarray(0, want));
        chunks[0] = b.subarray(want);
        n = max;
        break;
      }
      parts.push(chunks.shift());
      n += b.length;
      if (n >= max) break;
    }
    if (!parts.length) return null;
    const all = new Uint8Array(n);
    let off = 0;
    for (const b of parts) { all.set(b, off); off += b.length; }
    return all;
  }
}

export function createSyscallTable(kernel) {
  const credOf = (ctx = {}) => ({
    uid: ctx.uid ?? 0, gid: ctx.gid ?? 0, groups: ctx.groups || (ctx.gid != null ? [ctx.gid] : [0]),
    cwd: ctx.cwd || '/', pid: ctx.pid ?? 0,
  });

  const processOf = (ctx = {}) => {
    if (ctx.pid && kernel.getProcess(ctx.pid)) return kernel.getProcess(ctx.pid);
    if (!kernel.kernelProc) {
      kernel.kernelProc = { pid: 0, ppid: 0, uid: 0, gid: 0, groups: [0], cwd: '/', fds: new Map(), nextFd: 3,
        rlimits: new Map(), caps: 0n, umask: kernel.vfs.umask, name: '[kernel]', state: 'R' };
      kernel.kernelProc.allocFd = (obj, min = 3) => {
        const p = kernel.kernelProc;
        let fd = Math.max(min, p.nextFd);
        while (p.fds.has(fd)) fd++;
        p.fds.set(fd, obj); p.nextFd = fd + 1; return fd;
      };
      kernel.kernelProc.getFd = (fd) => kernel.kernelProc.fds.get(Number(fd));
      kernel.kernelProc.closeFd = (fd) => {
        const o = kernel.kernelProc.fds.get(Number(fd));
        if (!o) return false;
        kernel.kernelProc.fds.delete(Number(fd));
        try { o.close?.(); } catch { /* ignore */ }
        return true;
      };
    }
    return kernel.kernelProc;
  };

  const fdOf = (proc, fd, syscall) => {
    const o = proc.getFd(fd);
    if (!o) fail('EBADF', String(fd), syscall);
    return o;
  };

  const okCap = (proc, cap, syscall) => {
    if (proc.capable ? !proc.capable(cap) : proc.uid !== 0) fail('EPERM', '', syscall);
  };

  const table = {
    /* ------------------------------- files ------------------------------- */
    open([path, flags = O.RDONLY, mode = 0o666], ctx) {
      const proc = processOf(ctx);
      const handle = kernel.vfs.open(String(path), typeof flags === 'string' ? parseFlags(flags) : flags, credOf(ctx), mode);
      return proc.allocFd(handle);
    },
    close([fd], ctx) {
      const proc = processOf(ctx);
      if (!proc.closeFd(fd)) fail('EBADF', String(fd), 'close');
      return 0;
    },
    read([fd, length = 4096, position = null], ctx) {
      const o = fdOf(processOf(ctx), fd, 'read');
      const data = o.read(length, 0, length, position);
      return data;
    },
    write([fd, data], ctx) {
      const o = fdOf(processOf(ctx), fd, 'write');
      return o.write(data);
    },
    lseek([fd, offset = 0, whence = 0], ctx) {
      const o = fdOf(processOf(ctx), fd, 'lseek');
      if (o.pos == null) fail('ESPIPE', String(fd), 'lseek');
      if (whence === 0) o.pos = Number(offset);
      else if (whence === 1) o.pos += Number(offset);
      else if (whence === 2) o.pos = (o.node?.size || 0) + Number(offset);
      else fail('EINVAL', String(whence), 'lseek');
      return o.pos;
    },
    fstat([fd], ctx) {
      const o = fdOf(processOf(ctx), fd, 'fstat');
      if (typeof o.stat === 'function') return o.stat();
      if (o.node) return kernel.vfs.statObj(o.node);
      return { mode: 0o600, size: 0, ino: 0, nlink: 1, uid: ctx.uid ?? 0, gid: ctx.gid ?? 0 };
    },
    stat([path], ctx) { return kernel.vfs.stat(String(path), credOf(ctx)); },
    lstat([path], ctx) { return kernel.vfs.stat(String(path), credOf(ctx), { followFinal: false }); },
    access([path, mode = 0], ctx) { return kernel.vfs.access(String(path), mode, credOf(ctx)); },
    truncate([path, len = 0], ctx) { return kernel.vfs.truncate(String(path), len, credOf(ctx)); },
    ftruncate([fd, len = 0], ctx) {
      const o = fdOf(processOf(ctx), fd, 'ftruncate');
      return o.truncate ? o.truncate(len) : fail('EINVAL', String(fd), 'ftruncate');
    },
    unlink([path], ctx) { return kernel.vfs.unlink(String(path), credOf(ctx)); },
    mkdir([path, mode = 0o777], ctx) { return kernel.vfs.mkdir(String(path), credOf(ctx), mode); },
    rmdir([path], ctx) { return kernel.vfs.rmdir(String(path), credOf(ctx)); },
    rename([a, b], ctx) { return kernel.vfs.rename(String(a), String(b), credOf(ctx)); },
    chmod([path, mode], ctx) { return kernel.vfs.chmod(String(path), mode, credOf(ctx)); },
    chown([path, uid, gid], ctx) {
      const proc = processOf(ctx);
      if (proc.uid !== 0) okCap(proc, CAP.CHOWN, 'chown');
      return kernel.vfs.chown(String(path), uid, gid, credOf(ctx));
    },
    getcwd([], ctx) { return credOf(ctx).cwd; },
    chdir([path], ctx) {
      const cred = credOf(ctx);
      const abs = normalizePath(cred.cwd, String(path));
      const r = kernel.vfs.resolve(abs, cred);
      if (!r.node.isDir()) fail('ENOTDIR', String(path), 'chdir');
      kernel.vfs.check(r.node, cred, 'x', String(path), 'chdir');
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (proc) proc.cwd = abs;
      return 0;
    },
    umask([mask], ctx) {
      const proc = processOf(ctx);
      const old = proc.umask ?? kernel.vfs.umask;
      if (mask != null) proc.umask = Number(mask) & 0o777;
      return old;
    },
    dup([fd], ctx) {
      const proc = processOf(ctx);
      const o = fdOf(proc, fd, 'dup');
      return proc.allocFd(o);
    },
    dup2([oldfd, newfd], ctx) {
      const proc = processOf(ctx);
      const o = fdOf(proc, oldfd, 'dup2');
      if (Number(oldfd) === Number(newfd)) return Number(newfd);
      proc.closeFd(newfd);
      proc.fds.set(Number(newfd), o);
      return Number(newfd);
    },
    pipe([], ctx) {
      const ch = new PipeChannel();
      const r = new PipeEnd(ch, 'r');
      const w = new PipeEnd(ch, 'w');
      const proc = processOf(ctx);
      return [proc.allocFd(r), proc.allocFd(w)];
    },
    socketpair([], ctx) {
      const [a, b] = kernel.ipc.socketpair();
      const proc = processOf(ctx);
      return [proc.allocFd(a), proc.allocFd(b)];
    },

    /* ------------------------------ process ------------------------------ */
    getpid([], ctx) { return ctx.pid ?? 0; },
    getppid([], ctx) { return kernel.getProcess(ctx.pid)?.ppid ?? 0; },
    getuid([], ctx) { return ctx.uid ?? 0; },
    geteuid([], ctx) { return ctx.uid ?? 0; },
    getgid([], ctx) { return ctx.gid ?? 0; },
    getegid([], ctx) { return ctx.gid ?? 0; },
    getgroups([], ctx) { return ctx.groups || []; },
    setuid([uid], ctx) {
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (!proc) fail('ESRCH', String(ctx.pid), 'setuid');
      if (proc.uid !== 0) okCap(proc, CAP.SETUID, 'setuid');
      proc.uid = Number(uid);
      proc.caps = proc.uid === 0 ? ((1n << 32n) - 1n) : 0n;
      return 0;
    },
    setgid([gid], ctx) {
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (!proc) fail('ESRCH', String(ctx.pid), 'setgid');
      if (proc.uid !== 0) okCap(proc, CAP.SETGID, 'setgid');
      proc.gid = Number(gid);
      return 0;
    },
    getpgid([pid], ctx) {
      return kernel.getProcess(pid || ctx.pid)?.pgrp ?? 0;
    },
    setpgid([pid, pgid], ctx) {
      const p = kernel.getProcess(pid || ctx.pid);
      if (!p) fail('ESRCH', String(pid), 'setpgid');
      p.pgrp = pgid || p.pid;
      return 0;
    },
    setsid([], ctx) {
      const p = kernel.getProcess(ctx.pid);
      if (!p) fail('ESRCH', String(ctx.pid), 'setsid');
      p.sid = p.pid;
      p.pgrp = p.pid;
      return p.pid;
    },
    fork([], ctx) {
      const parent = kernel.getProcess(ctx.pid);
      if (!parent) fail('ESRCH', String(ctx.pid), 'fork');
      const child = kernel.forkProcess(parent);
      return child.pid;
    },
    async waitpid([pid = -1, options = 0], ctx) {
      return kernel.waitpid(Number(pid), Number(options), ctx.pid);
    },
    async nanosleep([ms = 0]) {
      const t = Math.max(0, Number(ms) || 0);
      await new Promise((r) => setTimeout(r, t));
      return 0;
    },
    kill([pid, sig = 'SIGTERM'], ctx) {
      const target = kernel.getProcess(pid);
      if (!target) fail('ESRCH', String(pid), 'kill');
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (proc && target.uid !== proc.uid) okCap(proc, CAP.KILL, 'kill');
      target.kill(typeof sig === 'number' ? sig : signalNumber(sig));
      return 0;
    },
    getrlimit([resource], ctx) {
      const proc = processOf(ctx);
      const key = typeof resource === 'string' ? RLIMITS[resource.toUpperCase()] : resource;
      const v = proc.rlimits?.get(key) || [Infinity, Infinity];
      return { soft: v[0] === Infinity ? -1 : v[0], hard: v[1] === Infinity ? -1 : v[1] };
    },
    setrlimit([resource, limits], ctx) {
      const proc = processOf(ctx);
      const key = typeof resource === 'string' ? RLIMITS[resource.toUpperCase()] : resource;
      if (!proc.rlimits) proc.rlimits = new Map();
      proc.rlimits.set(key, [limits.soft < 0 ? Infinity : limits.soft, limits.hard < 0 ? Infinity : limits.hard]);
      return 0;
    },
    getrusage([who = 0], ctx) {
      const p = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (!p) return { utime: 0, stime: 0, maxrss: 0, nvcsw: 0, nivcsw: 0 };
      return {
        utime: p.utimeMs || 0, stime: p.stimeMs || 0, maxrss: 4096 + (p.cpu || 0) / 100,
        nvcsw: p.nvcsw || 0, nivcsw: p.nivcsw || 0, who,
      };
    },
    sysinfo() {
      const m = kernel.memoryInfo();
      return {
        uptime: Math.floor(kernel.uptime), loads: kernel.loadavg(),
        totalram: m.total, freeram: m.free, sharedram: 0, bufferram: 0,
        totalswap: 0, freeswap: 0, procs: kernel.procs.size, totalhigh: 0, freehigh: 0, mem_unit: 1,
      };
    },
    uname() {
      return {
        sysname: 'Linux', nodename: kernel.hostname, release: '6.6.0-webos',
        version: '#1 SMP WebOS-JS', machine: kernel.machine || 'x86_64', domainname: kernel.domainname,
      };
    },

    /* ------------------------------- mounts ------------------------------ */
    mount([source, target, fstype = 'tmpfs', flags = 'rw'], ctx) {
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (proc) okCap(proc, CAP.SYS_ADMIN, 'mount');
      else if ((ctx.uid ?? 0) !== 0) fail('EPERM', String(target), 'mount');
      const entry = kernel.vfs.mount(String(source), String(target), fstype, flags, credOf(ctx));
      kernel.log.info(`mount: ${source} on ${target} type ${fstype} (${flags})`, 'kern');
      return entry.id;
    },
    umount([target], ctx) {
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (proc) okCap(proc, CAP.SYS_ADMIN, 'umount');
      else if ((ctx.uid ?? 0) !== 0) fail('EPERM', String(target), 'umount');
      const rc = kernel.vfs.umount(String(target), credOf(ctx));
      kernel.log.info(`umount: ${target}`, 'kern');
      return rc;
    },
    statfs([path], ctx) { return kernel.vfs.statfs(String(path), credOf(ctx)); },

    /* -------------------------------- IPC -------------------------------- */
    msgget([key, flags], ctx) { return kernel.ipc.msgget(key, flags, credOf(ctx)); },
    msgsnd([id, type, data, flags], ctx) { return kernel.ipc.msgsnd(id, type, data, flags, credOf(ctx)); },
    msgrcv([id, size, type, flags], ctx) { return kernel.ipc.msgrcv(id, size, type, flags, credOf(ctx)); },
    msgctl([id, cmd], ctx) { return kernel.ipc.msgctl(id, cmd, credOf(ctx)); },
    semget([key, nsems, flags], ctx) { return kernel.ipc.semget(key, nsems, flags, credOf(ctx)); },
    semop([id, ops], ctx) { return kernel.ipc.semop(id, ops, credOf(ctx)); },
    semctl([id, num, cmd, arg], ctx) { return kernel.ipc.semctl(id, num, cmd, arg, credOf(ctx)); },
    shmget([key, size, flags], ctx) { return kernel.ipc.shmget(key, size, flags, credOf(ctx)); },
    shmat([id, flags], ctx) { return kernel.ipc.shmat(id, flags, credOf(ctx)); },
    shmdt([attach]) { return kernel.ipc.shmdt(attach); },
    shmctl([id, cmd], ctx) { return kernel.ipc.shmctl(id, cmd, credOf(ctx)); },

    /* ------------------------------- misc -------------------------------- */
    clock_gettime([clock = CLOCK.REALTIME]) {
      const now = Date.now();
      if (clock === CLOCK.MONOTONIC) return { sec: Math.floor(kernel.uptime), nsec: Math.floor((kernel.uptime % 1) * 1e9) };
      return { sec: Math.floor(now / 1000), nsec: (now % 1000) * 1e6, clock };
    },
    gettimeofday() { return { sec: Math.floor(Date.now() / 1000), usec: (Date.now() % 1000) * 1000 }; },
    gettid([], ctx) { return ctx.pid ?? 0; },
    sethostname([name], ctx) {
      const proc = ctx.pid ? kernel.getProcess(ctx.pid) : null;
      if (proc) okCap(proc, CAP.SYS_ADMIN, 'sethostname');
      else if ((ctx.uid ?? 0) !== 0) fail('EPERM', '', 'sethostname');
      kernel.hostname = String(name).slice(0, 64);
      kernel.vfs.writeFile('/etc/hostname', kernel.hostname + '\n', { uid: 0, gid: 0, cwd: '/' });
      return 0;
    },
    ioctl([fd], ctx) {
      const o = fdOf(processOf(ctx), fd, 'ioctl');
      if (o.device === 'tty' || o.device === 'console' || o.tty) return { rows: 24, cols: 80 };
      fail('ENOTTY', String(fd), 'ioctl');
    },
    prctl() { return 0; },
    capget([], ctx) {
      const proc = processOf(ctx);
      return { effective: proc.caps ?? 0n, permitted: proc.caps ?? 0n, inheritable: 0n };
    },
    futex() { fail('ENOSYS', '', 'futex'); },
    mmap() { fail('ENOSYS', '', 'mmap'); },
    clone([flags], ctx) {
      const parent = kernel.getProcess(ctx.pid);
      if (!parent) fail('ESRCH', String(ctx.pid), 'clone');
      return kernel.forkProcess(parent).pid;
    },
  };

  const names = Object.keys(table);

  return {
    table,
    names,
    /** Dispatch a syscall by name. */
    async call(name, args = [], ctx = {}) {
      const fn = table[name];
      if (!fn) fail('ENOSYS', name, name);
      kernel.stats.syscalls++;
      try {
        const out = await fn(Array.isArray(args) ? args : [args], ctx);
        if (kernel.log && kernel.syscallTrace) {
          kernel.log.debug(`syscall ${name}(${safeArgs(args)}) -> ${summary(out)}`, 'kern');
        }
        return out;
      } catch (e) {
        if (e instanceof ErrnoError) {
          if (kernel.stats) kernel.stats.failedSyscalls++;
          throw e;
        }
        throw new ErrnoError('EINVAL', name, name);
      }
    },
    has(name) { return Object.prototype.hasOwnProperty.call(table, name); },
  };
}

function safeArgs(args) {
  try { return JSON.stringify(args, (k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v)); }
  catch { return '?'; }
}
function summary(v) {
  if (v == null || typeof v !== 'object') return String(v);
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return '[object]';
}

export { CLOCK, PipeChannel };
