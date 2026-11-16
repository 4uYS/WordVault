/* Process table, credentials, limits, capabilities and user database. */

/* Linux capability numbers (subset). A process holds a bitmask of these. */
export const CAP = {
  CHOWN: 0, DAC_OVERRIDE: 1, DAC_READ_SEARCH: 2, FOWNER: 3, FSETID: 4, KILL: 5,
  SETGID: 6, SETUID: 7, SETPCAP: 8, NET_BIND_SERVICE: 10, NET_RAW: 13,
  SYS_CHROOT: 18, SYS_PTRACE: 19, SYS_ADMIN: 21, SYS_BOOT: 22, SYS_NICE: 23,
  SYS_RESOURCE: 24, SYS_TIME: 25, SYS_TTY_CONFIG: 26, MKNOD: 27,
  AUDIT_WRITE: 29, SETFCAP: 31,
};
export const CAP_NAMES = Object.fromEntries(Object.entries(CAP).map(([k, v]) => [v, `cap_${k.toLowerCase()}`]));
export const ALL_CAPS = (1n << 32n) - 1n;

export const RLIMITS = {
  CPU: 0, FSIZE: 1, DATA: 2, STACK: 3, CORE: 4, RSS: 5, NPROC: 6, NOFILE: 7,
  MEMLOCK: 8, AS: 9, LOCKS: 10, SIGPENDING: 11, MSGQUEUE: 12, NICE: 13, RTPRIO: 14,
};

export function defaultRlimits() {
  return new Map([
    [RLIMITS.CPU, [Infinity, Infinity]],
    [RLIMITS.FSIZE, [Infinity, Infinity]],
    [RLIMITS.DATA, [Infinity, Infinity]],
    [RLIMITS.STACK, [8 * 1024 * 1024, Infinity]],
    [RLIMITS.CORE, [0, Infinity]],
    [RLIMITS.RSS, [Infinity, Infinity]],
    [RLIMITS.NPROC, [4096, 4096]],
    [RLIMITS.NOFILE, [1024, 4096]],
    [RLIMITS.MEMLOCK, [64 * 1024, 64 * 1024]],
    [RLIMITS.AS, [Infinity, Infinity]],
    [RLIMITS.LOCKS, [1024, 1024]],
    [RLIMITS.SIGPENDING, [1024, 1024]],
    [RLIMITS.MSGQUEUE, [32000, 32000]],
    [RLIMITS.NICE, [0, 0]],
    [RLIMITS.RTPRIO, [0, 0]],
  ]);
}

export class Process {
  constructor(kernel, opts = {}) {
    this.kernel = kernel;
    this.pid = opts.pid;
    this.ppid = opts.ppid ?? 0;
    this.pgrp = opts.pgrp ?? opts.pid;
    this.sid = opts.sid ?? opts.pid;
    this.uid = opts.uid ?? 1000;
    this.gid = opts.gid ?? 1000;
    this.groups = opts.groups || [1000];
    this.cwd = opts.cwd || '/home/user';
    this.root = opts.root || '/';
    this.env = opts.env || {};
    this.argv = opts.argv || [];
    this.name = opts.name || this.argv[0] || 'webos';
    this.state = 'R';
    this.exitCode = null;
    this.signal = null;
    this.started = Date.now();
    this.cpu = 0;
    this.nice = opts.nice ?? 0;
    this.priority = 20 + this.nice;
    this.tty = opts.tty || '/dev/tty';
    this.fds = new Map();
    this.nextFd = 3;
    this.fdFlags = new Map();
    this.controlling = opts.controlling ?? null;
    this.background = !!opts.background;
    this.exitListeners = new Set();
    this.abort = new AbortController();
    this.caps = opts.caps ?? (this.uid === 0 ? ALL_CAPS : 0n);
    this.userCaps = opts.userCaps ?? this.caps;
    this.rlimits = opts.rlimits ? new Map(opts.rlimits) : defaultRlimits();
    this.umask = opts.umask ?? kernel?.vfs?.umask ?? 0o022;
    this.signalMask = new Set();
    this.pendingSignals = [];
    this.nvcsw = 0;
    this.nivcsw = 0;
    this.utimeMs = 0;
    this.stimeMs = 0;
    this.oomScore = opts.oomScore ?? 0;
    this.ns = opts.ns || { pid: 1, mnt: 1, net: 1, uts: 1, ipc: 1, user: 1 };
  }

  capable(cap) {
    if (this.uid === 0 && !this._capDropped) return true;
    return (this.caps & (1n << BigInt(cap))) !== 0n;
  }
  setCap(cap, on = true) {
    this.caps = on ? (this.caps | (1n << BigInt(cap))) : (this.caps & ~(1n << BigInt(cap)));
  }
  capNames() {
    return Object.entries(CAP).filter(([, n]) => (this.caps & (1n << BigInt(n))) !== 0n).map(([k]) => k);
  }

  allocFd(obj, min = 3) {
    const hard = this.rlimits.get(RLIMITS.NOFILE)?.[1] ?? Infinity;
    if (this.fds.size >= hard) throw new Error('EMFILE: too many open files');
    let fd = Math.max(min, this.nextFd);
    while (this.fds.has(fd)) fd++;
    this.fds.set(fd, obj);
    this.nextFd = fd + 1;
    return fd;
  }
  getFd(fd) { return this.fds.get(Number(fd)); }
  closeFd(fd) {
    fd = Number(fd);
    const obj = this.fds.get(fd);
    if (!obj) return false;
    this.fds.delete(fd);
    try { obj.close?.(); } catch { /* ignore */ }
    return true;
  }

  setExit(code, signal = null) {
    if (this.state === 'Z') return;
    this.exitCode = code;
    this.signal = signal;
    this.state = 'Z';
    this.cpu = Date.now() - this.started;
    this.kernel?.onProcessExit?.(this);
    for (const cb of this.exitListeners) { try { cb(code, signal); } catch { /* noop */ } }
    this.exitListeners.clear();
  }
  onExit(cb) {
    if (this.state === 'Z') { cb(this.exitCode, this.signal); return () => {}; }
    this.exitListeners.add(cb);
    return () => this.exitListeners.delete(cb);
  }
  kill(sig = 'SIGTERM') {
    if (this.state === 'Z') return false;
    const n = signalNumber(sig);
    const name = signalName(typeof sig === 'number' ? sig : n);
    this.kernel?.stats && (this.kernel.stats.signals++);
    if (n === SIGNALS.SIGSTOP || n === SIGNALS.SIGTSTP) { this.state = 'T'; return true; }
    if (n === SIGNALS.SIGCONT) { if (this.state === 'T') this.state = 'R'; return true; }
    if (n && this.signalMask.has(name)) {
      this.pendingSignals.push(name);
      return true;
    }
    this.signal = name;
    if (name === 'SIGKILL' || name === 'SIGTERM' || name === 'SIGINT' || name === 'SIGHUP') {
      this.abort.abort(new Error(`Process ${this.pid} received ${name}`));
      this.setExit(128 + n, name);
    }
    return true;
  }
}

export const SIGNALS = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7,
  SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15, SIGSTKFLT: 16, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19,
  SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGURG: 23, SIGXCPU: 24, SIGXFSZ: 25,
  SIGVTALRM: 26, SIGPROF: 27, SIGWINCH: 28, SIGIO: 29, SIGPWR: 30, SIGSYS: 31,
};

export function signalNumber(sig) {
  if (typeof sig === 'number') return sig;
  const s = String(sig).toUpperCase().replace(/^SIG/, '');
  return SIGNALS['SIG' + s] || 0;
}
export function signalName(n) {
  for (const [k, v] of Object.entries(SIGNALS)) if (v === n) return k;
  return String(n);
}

export const USERS = [
  { name: 'root', uid: 0, gid: 0, home: '/root', shell: '/bin/sh', gecos: 'root' },
  { name: 'user', uid: 1000, gid: 1000, home: '/home/user', shell: '/bin/sh', gecos: 'WebOS User' },
  { name: 'nobody', uid: 65534, gid: 65534, home: '/nonexistent', shell: '/bin/false', gecos: 'nobody' },
];

export const GROUPS = [
  { name: 'root', gid: 0, members: [] },
  { name: 'user', gid: 1000, members: ['user'] },
  { name: 'sudo', gid: 27, members: ['user'] },
  { name: 'nogroup', gid: 65534, members: [] },
];
