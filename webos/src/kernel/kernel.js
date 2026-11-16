/* Kernel: ties together the VFS, process table, users, devices and /proc. */

import { VFS, Inode, dev, ErrnoError } from './vfs.js';
import { Process, SIGNALS, signalNumber, signalName, USERS, GROUPS } from './process.js';
import { buildRootfs } from './init.js';
import { installProcfs } from './procfs.js';

export class Kernel {
  constructor(opts = {}) {
    this.vfs = new VFS();
    this.vfs.umask = opts.umask ?? 0o022;
    this.hostname = opts.hostname || 'webos';
    this.domainname = opts.domainname || '';
    this.bootTime = Date.now();
    this.nextPid = 100;
    this.procs = new Map();
    this.commands = new Map();
    this.users = USERS;
    this.groups = GROUPS;
    this.clock = { tz: opts.timezone || 'UTC' };
    this.running = true;
    this.initProc = null;
    this.installListeners = new Set();
  }

  boot() {
    buildRootfs(this);
    installProcfs(this);
    this.initProc = this.spawnProcess({
      argv: ['/sbin/init'], name: 'init', pid: 1, ppid: 0,
      uid: 0, gid: 0, groups: [0], cwd: '/',
      env: { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/root', USER: 'root' },
    });
    return this;
  }

  spawnProcess(opts = {}) {
    const pid = opts.pid ?? this.nextPid++;
    if (pid >= this.nextPid) this.nextPid = pid + 1;
    const p = new Process(this, { ...opts, pid });
    this.procs.set(pid, p);
    if (pid === 1) p.ppid = 0;
    this.vfs.notify('/proc', 'change');
    return p;
  }

  getProcess(pid) { return this.procs.get(pid) || null; }

  children(pid) { return [...this.procs.values()].filter((p) => p.ppid === pid && p.state !== 'Z'); }

  reap(proc) {
    if (!proc || proc.pid === 1) return;
    if (proc.state === 'Z') this.procs.delete(proc.pid);
  }

  kill(pid, sig = 'SIGTERM') {
    const p = this.procs.get(pid);
    if (!p) throw new ErrnoError('ESRCH', String(pid), 'kill');
    return p.kill(sig);
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

  get uptime() { return (Date.now() - this.bootTime) / 1000; }

  info() {
    return {
      hostname: this.hostname, uptime: this.uptime, procs: this.procs.size,
      load: [0, 0, 0], mem: this.memoryInfo(),
    };
  }

  memoryInfo() {
    const perf = globalThis.performance;
    let used = 0, total = 512 * 1024 * 1024;
    if (perf?.memory) { used = perf.memory.usedJSHeapSize || 0; total = Math.max(perf.memory.jsHeapSizeLimit || total, used); }
    return { total, used, free: Math.max(0, total - used) };
  }

  onInstall(fn) { this.installListeners.add(fn); }
}

export { Inode, dev, ErrnoError, SIGNALS, signalNumber, signalName };
