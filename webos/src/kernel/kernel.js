/* Kernel: ties together the VFS, mount table, processes, IPC, syscalls and /proc. */

import { VFS, Inode, dev, ErrnoError } from './vfs.js';
import { Process, SIGNALS, signalNumber, signalName, USERS, GROUPS, RLIMITS } from './process.js';
import { KernelLog } from './log.js';
import { IPC } from './ipc.js';
import { createSyscallTable } from './syscalls.js';
import { buildRootfs } from './init.js';
import { installProcfs } from './procfs.js';

export class Kernel {
  constructor(opts = {}) {
    this.vfs = new VFS();
    this.vfs.umask = opts.umask ?? 0o022;
    this.hostname = opts.hostname || 'webos';
    this.domainname = opts.domainname || '';
    this.machine = opts.machine || 'x86_64';
    this.bootTime = Date.now();
    this.bootId = makeBootId();
    this.nextPid = 100;
    this.procs = new Map();
    this.commands = new Map();
    this.users = USERS.map((u) => ({ ...u, groups: u.groups ? [...u.groups] : u.groups }));
    this.groups = GROUPS.map((g) => ({ ...g, members: [...g.members] }));
    this.clock = { tz: opts.timezone || 'UTC' };
    this.running = true;
    this.initProc = null;
    this.installListeners = new Set();
    this.kernelProc = null;
    this.syscallTrace = !!opts.syscallTrace;
    this.log = new KernelLog(this, opts.logSize || 2048);
    this.ipc = new IPC(this);
    this.stats = {
      bootTime: this.bootTime, syscalls: 0, failedSyscalls: 0, forks: 0,
      contextSwitches: 0, signals: 0, irqs: 0, pageFaults: 0, jiffies: 0,
      procsCreated: 0, mounts: 0,
    };
    this.syscalls = createSyscallTable(this);
    this._waiters = new Set();
  }

  boot() {
    buildRootfs(this);
    installProcfs(this);
    this._installMounts();
    this.initProc = this.spawnProcess({
      argv: ['/sbin/init'], name: 'init', pid: 1, ppid: 0,
      uid: 0, gid: 0, groups: [0], cwd: '/',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', USER: 'root' },
    });
    this.log.info(`Linux version 6.6.0-webos (js@webos) #1 SMP ${this.machine}`, 'kern');
    this.log.info(`Command line: webos console=ttyS0 quiet hostname=${this.hostname}`, 'kern');
    this.log.info(`Mounted root filesystem (ext4) on /, ${this.vfs.mounts.size} mounts`, 'kern');
    return this;
  }

  _installMounts() {
    const rootEntry = {
      id: 0, source: '/dev/root', target: '/', fstype: 'ext4',
      flags: new Set(['rw', 'relatime']), options: {}, root: this.vfs.root, mountedAt: Date.now(),
    };
    this.vfs.mounts.set('/', rootEntry);
    this.vfs.mountRoots.set(this.vfs.root, rootEntry);
    const ctx = { uid: 0, gid: 0, groups: [0], cwd: '/' };
    const ensure = (p) => { try { this.vfs.mkdir(p, ctx, 0o755); } catch { /* exists */ } };
    ensure('/proc'); ensure('/sys'); ensure('/dev'); ensure('/tmp'); ensure('/run');
    ensure('/dev/pts'); ensure('/dev/shm'); ensure('/mnt'); ensure('/media');
    const specs = [
      ['proc', '/proc', 'proc', 'rw,nosuid,nodev,noexec'],
      ['sysfs', '/sys', 'sysfs', 'ro,nosuid,nodev,noexec'],
      ['devtmpfs', '/dev', 'devtmpfs', 'rw,nosuid,noexec'],
      ['devpts', '/dev/pts', 'devpts', 'rw,nosuid,noexec'],
      ['tmpfs', '/dev/shm', 'tmpfs', 'rw,nosuid,nodev,size=64m,mode=1777'],
      ['tmpfs', '/run', 'tmpfs', 'rw,nosuid,nodev,size=64m,mode=755'],
      ['tmpfs', '/tmp', 'tmpfs', 'rw,nosuid,nodev,size=256m,mode=1777'],
    ];
    for (const [source, target, fstype, flags] of specs) {
      try {
        this.vfs.mount(source, target, fstype, flags, ctx);
        this.stats.mounts++;
      } catch (e) {
        this.log.warn(`mount ${target} failed: ${e.message}`, 'kern');
      }
    }
  }

  spawnProcess(opts = {}) {
    const pid = opts.pid ?? this.nextPid++;
    if (pid >= this.nextPid) this.nextPid = pid + 1;
    const parent = opts.ppid != null ? this.procs.get(opts.ppid) : null;
    const p = new Process(this, {
      ...opts,
      pid,
      pgrp: opts.pgrp ?? parent?.pgrp ?? pid,
      sid: opts.sid ?? parent?.sid ?? pid,
      caps: opts.caps ?? parent?.caps,
      rlimits: opts.rlimits ?? (parent ? new Map(parent.rlimits) : undefined),
      umask: opts.umask ?? parent?.umask ?? this.vfs.umask,
      nice: opts.nice ?? parent?.nice ?? 0,
      root: opts.root ?? parent?.root ?? '/',
    });
    this.procs.set(pid, p);
    if (pid === 1) p.ppid = 0;
    this.stats.procsCreated++;
    this.stats.forks++;
    this.vfs.notify('/proc', 'change');
    return p;
  }

  /** fork(2)-like clone: same credentials, fds, limits and environment. */
  forkProcess(parent, overrides = {}) {
    const child = this.spawnProcess({
      ...overrides,
      argv: (overrides.argv || parent.argv).slice(),
      name: overrides.name || parent.name,
      uid: overrides.uid ?? parent.uid,
      gid: overrides.gid ?? parent.gid,
      groups: (overrides.groups || parent.groups).slice(),
      cwd: overrides.cwd ?? parent.cwd,
      root: overrides.root ?? parent.root,
      env: { ...(overrides.env || parent.env) },
      ppid: overrides.ppid ?? parent.pid,
      pgrp: overrides.pgrp ?? parent.pgrp,
      sid: overrides.sid ?? parent.sid,
      caps: overrides.caps ?? parent.caps,
      rlimits: overrides.rlimits ?? new Map(parent.rlimits),
      umask: overrides.umask ?? parent.umask,
      nice: overrides.nice ?? parent.nice,
      tty: overrides.tty ?? parent.tty,
    });
    for (const [fd, obj] of parent.fds) child.fds.set(fd, obj);
    child.nextFd = parent.nextFd;
    this.log.debug(`fork: ${parent.pid} -> ${child.pid} (${child.name})`, 'kern');
    return child;
  }

  getProcess(pid) { return this.procs.get(Number(pid)) || null; }

  children(pid) { return [...this.procs.values()].filter((p) => p.ppid === Number(pid) && p.state !== 'Z'); }

  allChildren(pid) { return [...this.procs.values()].filter((p) => p.ppid === Number(pid)); }

  reap(proc) {
    if (!proc || proc.pid === 1) return;
    if (proc.state === 'Z') {
      this.procs.delete(proc.pid);
      this.vfs.notify('/proc', 'change');
    }
  }

  /** Called from Process.setExit(). Reparents orphans onto init. */
  onProcessExit(proc) {
    this.stats.contextSwitches++;
    for (const fd of [...proc.fds.keys()]) proc.closeFd(fd);
    for (const child of this.procs.values()) {
      if (child.ppid === proc.pid && child.pid !== 1) child.ppid = 1;
    }
    this._wakeWaiters();
    this.vfs.notify('/proc', 'change');
    if (proc.pid !== 1 && proc.pid !== 0 && (proc.exitCode !== 0 || proc.signal)) {
      this.log.notice(`process ${proc.pid} (${proc.name}) exited with ${proc.exitCode}${proc.signal ? ` signal ${proc.signal}` : ''}`, 'kern');
    }
  }

  /**
   * waitpid(2). pid: >0 exact, 0 same process group, -1 any child, <-1 group.
   * Returns {pid,status,code,signal} or 0 with WNOHANG.
   */
  async waitpid(pid = -1, options = 0, callerPid = 0) {
    const WNOHANG = 1, WUNTRACED = 2;
    const mine = () => [...this.procs.values()].filter((p) => {
      if (p.ppid !== callerPid) return false;
      if (pid > 0) return p.pid === pid;
      if (pid === 0) return p.pgrp === callerPid;
      if (pid < -1) return p.pgrp === -pid;
      return true;
    });
    const finish = (p) => {
      const status = p.signal ? signalNumber(p.signal) : ((p.exitCode ?? 0) & 0xff) << 8;
      const out = { pid: p.pid, status, code: p.exitCode ?? 0, signal: p.signal || null };
      if (p.state === 'Z') this.procs.delete(p.pid);
      return out;
    };
    const ready = mine().find((p) => p.state === 'Z' || (options & WUNTRACED && p.state === 'T'));
    if (ready) return finish(ready);
    if (!mine().length) throw new ErrnoError('ECHILD', String(pid), 'waitpid');
    if (options & WNOHANG) return 0;
    return new Promise((resolve) => {
      this._waiters.add(resolve);
    }).then(() => {
      const done = mine().find((p) => p.state === 'Z' || (options & WUNTRACED && p.state === 'T'));
      if (done) return finish(done);
      throw new ErrnoError('ECHILD', String(pid), 'waitpid');
    });
  }

  _wakeWaiters() {
    for (const w of this._waiters) { try { w(); } catch { /* ignore */ } }
    this._waiters.clear();
  }

  kill(pid, sig = 'SIGTERM') {
    const p = this.procs.get(Number(pid));
    if (!p) throw new ErrnoError('ESRCH', String(pid), 'kill');
    return p.kill(sig);
  }

  setHostname(name) {
    this.hostname = String(name).slice(0, 64);
    try { this.vfs.writeFile('/etc/hostname', this.hostname + '\n', { uid: 0, gid: 0, cwd: '/' }); } catch { /* ro */ }
    this.log.notice(`hostname set to ${this.hostname}`, 'daemon');
    return this.hostname;
  }

  userByName(name) { return this.users.find((u) => u.name === name) || null; }
  userByUid(uid) { return this.users.find((u) => u.uid === Number(uid)) || null; }
  groupByName(name) { return this.groups.find((g) => g.name === name) || null; }
  groupByGid(gid) { return this.groups.find((g) => g.gid === Number(gid)) || null; }

  credentialFor(nameOrUid) {
    let user;
    if (typeof nameOrUid === 'number' || /^\d+$/.test(String(nameOrUid))) user = this.userByUid(Number(nameOrUid));
    else user = this.userByName(nameOrUid);
    if (!user) throw new Error(`unknown user: ${nameOrUid}`);
    const groups = [user.gid, ...this.groups.filter((g) => g.members.includes(user.name)).map((g) => g.gid)];
    return { uid: user.uid, gid: user.gid, groups, user, home: user.home };
  }

  registerCommand(name, def) {
    this.commands.set(name, def);
    this.installTool(name, def);
  }

  /** Create the /bin, /usr/bin, /sbin entry for a command. */
  installTool(name, def = {}) {
    const ctx = { uid: 0, gid: 0, cwd: '/' };
    const content = new TextEncoder().encode(`#!/bin/webos\n# ${def.summary || name} (builtin)\n`);
    for (const dir of ['/bin', '/usr/bin']) {
      try {
        const existing = this.vfs.resolve(`${dir}/${name}`, ctx, { allowMissingFinal: true });
        if (existing.node) continue;
        const h = this.vfs.open(`${dir}/${name}`, 0o1 | 64 | 512, ctx, 0o755);
        h.write(content);
        h.close();
        this.vfs.chmod(`${dir}/${name}`, 0o755, ctx);
      } catch { /* ignore tool stub failures */ }
    }
  }

  /** Dispatch a syscall through the kernel syscall table. */
  async syscall(name, args = [], ctx = {}) {
    return this.syscalls.call(name, args, ctx);
  }

  mount(source, target, fstype = 'tmpfs', flags = 'rw') {
    return this.vfs.mount(source, target, fstype, flags, { uid: 0, gid: 0, cwd: '/' });
  }

  umount(target) { return this.vfs.umount(target, { uid: 0, gid: 0, cwd: '/' }); }

  get jiffies() { return Math.floor((Date.now() - this.bootTime) / 10); }
  get uptime() { return (Date.now() - this.bootTime) / 1000; }

  loadavg() {
    const now = Date.now();
    const runs = [...this.procs.values()].filter((p) => p.state === 'R').length;
    const total = this.procs.size;
    const scale = Math.min(1, (now - this.bootTime) / 60000);
    return [runs, runs * 0.8 * scale, runs * 0.6 * scale];
  }

  info() {
    return {
      hostname: this.hostname, uptime: this.uptime, procs: this.procs.size,
      load: this.loadavg(), mem: this.memoryInfo(), mounts: this.vfs.mounts.size,
      stats: { ...this.stats }, ipc: this.ipc.list(),
    };
  }

  memoryInfo() {
    const perf = globalThis.performance;
    let used = 0, total = 512 * 1024 * 1024;
    if (perf?.memory) { used = perf.memory.usedJSHeapSize || 0; total = Math.max(perf.memory.jsHeapSizeLimit || total, used); }
    const buffers = (this.vfs.mountFor('/tmp')?.root ? 0 : 0);
    return { total, used, free: Math.max(0, total - used), buffers };
  }

  onInstall(fn) { this.installListeners.add(fn); }
}

export { Inode, dev, ErrnoError, SIGNALS, signalNumber, signalName, RLIMITS };

function makeBootId() {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = (Math.random() * 256) | 0;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
