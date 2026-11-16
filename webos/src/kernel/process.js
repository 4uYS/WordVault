/* Process table and user database. */

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
    this.env = opts.env || {};
    this.argv = opts.argv || [];
    this.name = opts.name || this.argv[0] || 'webos';
    this.state = 'R';
    this.exitCode = null;
    this.signal = null;
    this.started = Date.now();
    this.cpu = 0;
    this.nice = 0;
    this.priority = 20;
    this.tty = opts.tty || '/dev/tty';
    this.fds = new Map();
    this.controlling = opts.controlling ?? null;
    this.background = !!opts.background;
    this.exitListeners = new Set();
    this.abort = new AbortController();
  }
  setExit(code, signal = null) {
    if (this.state === 'Z') return;
    this.exitCode = code;
    this.signal = signal;
    this.state = 'Z';
    this.cpu = Date.now() - this.started;
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
    this.signal = sig;
    if (sig === 'SIGKILL' || sig === 'SIGTERM' || sig === 'SIGINT' || sig === 'SIGHUP') {
      this.abort.abort(new Error(`Process ${this.pid} received ${sig}`));
      this.setExit(128 + signalNumber(sig), sig);
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
