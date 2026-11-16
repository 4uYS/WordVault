/* System V IPC (messages, semaphores, shared memory) and AF_UNIX sockets.
 *
 * These are in-kernel resources: they live and die with the WebOS instance and
 * are shared by every shell/Node context running inside it. Blocking calls are
 * synchronous and follow the IPC_NOWAIT convention (EAGAIN instead of parking
 * the JS thread); Unix socket reads are async and can be awaited.
 */

import { ErrnoError } from './vfs.js';

const NOWAIT = 0o4000;
const CREAT = 0o1000;
const EXCL = 0o2000;
const IPC_RMID = 0;
const IPC_SET = 1;
const IPC_STAT = 2;
const MSG_NOERROR = 0o10000;
const SHM_RDONLY = 0o10000;

const fail = (code, what, syscall) => { throw new ErrnoError(code, what, syscall); };
const okPerm = (obj, ctx, bits) => {
  const uid = ctx?.uid ?? 0;
  if (uid === 0) return true;
  const groups = ctx?.groups || [];
  let perm;
  if (obj.uid === uid) perm = (obj.mode >> 6) & 7;
  else if (obj.gid === (ctx?.gid ?? -1) || groups.includes(obj.gid)) perm = (obj.mode >> 3) & 7;
  else perm = obj.mode & 7;
  return (bits & ~perm) === 0;
};

function normalizeKey(key) {
  if (typeof key === 'number' || /^\d+$/.test(String(key))) return Number(key) | 0;
  const s = String(key);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h & 0x7fffffff) || 1;
}

let nextId = 1;

/** One endpoint of a connected AF_UNIX stream. */
export class UnixSocket {
  constructor(kernel, path = null) {
    this.kernel = kernel;
    this.path = path;
    this.peer = null;
    this.buf = [];
    this.closed = false;
    this.writeClosed = false;
    this.waiter = null;
    this.bytesIn = 0;
    this.bytesOut = 0;
  }
  _wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  /** Bytes written by the peer and waiting to be read here. */
  writeToPeer(data) {
    if (this.peer?.closed || this.peer?.writeClosed) fail('EPIPE', this.path || 'socket', 'write');
    const b = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    this.peer.buf.push(b);
    this.peer.bytesIn += b.length;
    this.bytesOut += b.length;
    this.peer._wake();
    return b.length;
  }
  write(data) { return this.writeToPeer(data); }
  async read() {
    for (;;) {
      if (this.buf.length) return this.buf.shift();
      if (this.closed || (this.writeClosed && this.peer?.closed)) return null;
      if (this.writeClosed && this.peer?.buf?.length === 0) return null;
      await new Promise((r) => { this.waiter = r; });
    }
  }
  async readText() {
    const chunks = [];
    for (;;) {
      const c = await this.read();
      if (c === null) break;
      chunks.push(c);
    }
    const n = chunks.reduce((a, b) => a + b.length, 0);
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  }
  /** Shut down the writing side; the peer observes EOF after buffered data. */
  end(data) {
    if (data != null) this.write(data);
    this.writeClosed = true;
    this.peer?._wake();
    return 0;
  }
  close() {
    if (this.closed) return 0;
    this.closed = true;
    this.writeClosed = true;
    this._wake();
    if (this.peer) { this.peer.closed = true; this.peer._wake(); }
    return 0;
  }
  get destroyed() { return this.closed; }
}

class UnixListener {
  constructor(kernel, path, backlog, ctx) {
    this.kernel = kernel;
    this.path = path;
    this.backlog = backlog || 128;
    this.pending = [];
    this.waiters = [];
    this.closed = false;
    this.uid = ctx?.uid ?? 0;
    this.gid = ctx?.gid ?? 0;
  }
  _wake() { while (this.waiters.length) this.waiters.shift()(); }
  offer(sock) {
    if (this.pending.length >= this.backlog) {
      sock.close();
      return false;
    }
    this.pending.push(sock);
    this._wake();
    return true;
  }
  async accept() {
    for (;;) {
      if (this.pending.length) return this.pending.shift();
      if (this.closed) fail('EINVAL', this.path, 'accept');
      await new Promise((r) => this.waiters.push(r));
    }
  }
  close() {
    this.closed = true;
    for (const s of this.pending) s.close();
    this.pending = [];
    this._wake();
    this.kernel.ipc.unixListeners.delete(this.path);
    return 0;
  }
}

/**
 * Kernel IPC manager. All ids are small integers scoped to this instance.
 */
export class IPC {
  constructor(kernel) {
    this.kernel = kernel;
    this.msgQueues = new Map();
    this.semSets = new Map();
    this.shmSegments = new Map();
    this.unixListeners = new Map();
    this.stats = { messages: 0, semops: 0, shmAttaches: 0, unixConnections: 0 };
  }

  /* ------------------------------- messages ------------------------------- */

  msgget(key, flags = 0o666, ctx = {}) {
    const k = normalizeKey(key);
    for (const q of this.msgQueues.values()) {
      if (k !== 0 && q.key === k) {
        if (flags & CREAT && flags & EXCL) fail('EEXIST', String(key), 'msgget');
        if (!okPerm(q, ctx, 0)) fail('EACCES', String(key), 'msgget');
        return q.msqid;
      }
    }
    if (!(flags & CREAT)) fail('ENOENT', String(key), 'msgget');
    const mode = (flags & 0o777) || 0o666;
    const q = {
      msqid: nextId++, key: k, mode, uid: ctx.uid ?? 0, gid: ctx.gid ?? 0,
      qbytes: 16384, messages: [], bytes: 0,
      ctime: Date.now(), stime: 0, rtime: 0, cpid: ctx.pid ?? 0, lspid: 0, lrpid: 0,
    };
    this.msgQueues.set(q.msqid, q);
    this.kernel.log?.debug(`msgget: queue ${q.msqid} key ${k}`, 'kern');
    return q.msqid;
  }

  _queue(id, ctx, syscall) {
    const q = this.msgQueues.get(id);
    if (!q) fail('EINVAL', String(id), syscall);
    if (!okPerm(q, ctx, 0)) fail('EACCES', String(id), syscall);
    return q;
  }

  msgsnd(id, type, data, flags = 0, ctx = {}) {
    const q = this._queue(id, ctx, 'msgsnd');
    if (!(Number(type) > 0)) fail('EINVAL', String(id), 'msgsnd');
    const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (q.bytes + buf.length > q.qbytes) fail('EAGAIN', String(id), 'msgsnd');
    q.messages.push({ mtype: Number(type), data: buf, time: Date.now() });
    q.bytes += buf.length;
    q.stime = Date.now();
    q.lspid = ctx.pid ?? 0;
    this.stats.messages++;
    return 0;
  }

  msgrcv(id, size = 8192, type = 0, flags = 0, ctx = {}) {
    const q = this._queue(id, ctx, 'msgrcv');
    let idx = -1;
    if (type === 0) idx = 0;
    else if (type > 0) idx = q.messages.findIndex((m) => m.mtype === type);
    else {
      const max = Math.abs(type);
      let best = null;
      for (let i = 0; i < q.messages.length; i++) {
        const m = q.messages[i];
        if (m.mtype <= max && (!best || m.mtype < best.m.mtype)) best = { i, m };
      }
      if (best) idx = best.i;
    }
    if (idx < 0 || !q.messages.length) fail('ENOMSG', String(id), 'msgrcv');
    const msg = q.messages[idx];
    if (msg.data.length > size) {
      if (!(flags & MSG_NOERROR)) fail('E2BIG', String(id), 'msgrcv');
      msg.data = msg.data.subarray(0, size);
    }
    q.messages.splice(idx, 1);
    q.bytes -= msg.data.length;
    q.rtime = Date.now();
    q.lrpid = ctx.pid ?? 0;
    this.stats.messages++;
    return { mtype: msg.mtype, data: msg.data };
  }

  msgctl(id, cmd, ctx = {}) {
    const q = this._queue(id, ctx, 'msgctl');
    if (cmd === IPC_RMID) { this.msgQueues.delete(id); return 0; }
    if (cmd === IPC_STAT) return this._msgStat(q);
    if (cmd === IPC_SET) return 0;
    fail('EINVAL', String(id), 'msgctl');
  }

  _msgStat(q) {
    return {
      msqid: q.msqid, key: q.key, mode: q.mode, uid: q.uid, gid: q.gid,
      qbytes: q.qbytes, qnum: q.messages.length, ctime: q.ctime, stime: q.stime,
      rtime: q.rtime, cpid: q.cpid, lspid: q.lspid, lrpid: q.lrpid,
    };
  }

  /* ------------------------------- semaphores ----------------------------- */

  semget(key, nsems = 1, flags = 0o666, ctx = {}) {
    const k = normalizeKey(key);
    for (const s of this.semSets.values()) {
      if (k !== 0 && s.key === k) {
        if (flags & CREAT && flags & EXCL) fail('EEXIST', String(key), 'semget');
        if (!okPerm(s, ctx, 0)) fail('EACCES', String(key), 'semget');
        return s.semid;
      }
    }
    if (!(flags & CREAT)) fail('ENOENT', String(key), 'semget');
    nsems = Math.max(1, nsems | 0);
    if (nsems > 512) fail('EINVAL', String(key), 'semget');
    const s = {
      semid: nextId++, key: k, mode: (flags & 0o777) || 0o666, uid: ctx.uid ?? 0, gid: ctx.gid ?? 0,
      nsems, values: new Array(nsems).fill(0), pid: new Array(nsems).fill(0),
      ncnt: new Array(nsems).fill(0), zcnt: new Array(nsems).fill(0),
      ctime: Date.now(), otime: 0,
    };
    this.semSets.set(s.semid, s);
    this.kernel.log?.debug(`semget: set ${s.semid} key ${k} nsems ${nsems}`, 'kern');
    return s.semid;
  }

  _sem(id, ctx, cmd) {
    const s = this.semSets.get(id);
    if (!s) fail('EINVAL', String(id), cmd);
    if (!okPerm(s, ctx, 0)) fail('EACCES', String(id), cmd);
    return s;
  }

  semop(id, ops, ctx = {}) {
    const s = this._sem(id, ctx, 'semop');
    // Validate first: Linux applies a semop atomically per operation, but a
    // failing later op must not leave earlier increments applied.
    const snapshot = s.values.slice();
    for (const op of ops) {
      const n = Number(op.sem_num);
      if (n < 0 || n >= s.nsems) fail('EFBIG', String(id), 'semop');
      const delta = Number(op.sem_op);
      const cur = s.values[n];
      if (delta < 0) {
        if (cur + delta < 0) {
          s.values.splice(0, s.values.length, ...snapshot);
          fail('EAGAIN', String(id), 'semop');
        }
      } else if (delta === 0) {
        if (cur !== 0) {
          s.values.splice(0, s.values.length, ...snapshot);
          fail('EAGAIN', String(id), 'semop');
        }
      }
      s.values[n] = cur + delta;
      s.pid[n] = ctx.pid ?? 0;
    }
    s.otime = Date.now();
    this.stats.semops++;
    return 0;
  }

  semctl(id, semnum, cmd, arg, ctx = {}) {
    const s = this._sem(id, ctx, 'semctl');
    if (cmd === IPC_RMID) { this.semSets.delete(id); return 0; }
    if (cmd === IPC_STAT) {
      return {
        semid: s.semid, key: s.key, mode: s.mode, uid: s.uid, gid: s.gid, nsems: s.nsems,
        otime: s.otime, ctime: s.ctime, values: s.values.slice(),
      };
    }
    const n = Number(semnum) | 0;
    if (n >= 0 && n < s.nsems && arg !== undefined) {
      if (cmd === 16 || cmd === 9) { s.values[n] = Number(arg); return 0; } // SETVAL / SETALL-ish
    }
    return s.values[n] ?? 0;
  }

  /* ------------------------------ shared memory --------------------------- */

  shmget(key, size = 4096, flags = 0o666, ctx = {}) {
    const k = normalizeKey(key);
    for (const m of this.shmSegments.values()) {
      if (k !== 0 && m.key === k) {
        if (flags & CREAT && flags & EXCL) fail('EEXIST', String(key), 'shmget');
        if (!okPerm(m, ctx, 0)) fail('EACCES', String(key), 'shmget');
        if (size > m.size) fail('EINVAL', String(key), 'shmget');
        return m.shmid;
      }
    }
    if (!(flags & CREAT)) fail('ENOENT', String(key), 'shmget');
    const sz = Math.max(1, size | 0);
    if (sz > 64 * 1024 * 1024) fail('ENOMEM', String(key), 'shmget');
    const m = {
      shmid: nextId++, key: k, size: sz, mode: (flags & 0o777) || 0o666,
      uid: ctx.uid ?? 0, gid: ctx.gid ?? 0, cpid: ctx.pid ?? 0, ctime: Date.now(),
      atime: 0, dtime: 0, nattch: 0, data: new Uint8Array(sz),
    };
    this.shmSegments.set(m.shmid, m);
    this.kernel.log?.debug(`shmget: segment ${m.shmid} key ${k} size ${sz}`, 'kern');
    return m.shmid;
  }

  shmat(id, flags = 0, ctx = {}) {
    const m = this.shmSegments.get(id);
    if (!m) fail('EINVAL', String(id), 'shmat');
    if (!okPerm(m, ctx, flags & SHM_RDONLY ? 4 : 6)) fail('EACCES', String(id), 'shmat');
    m.nattch++;
    m.atime = Date.now();
    this.stats.shmAttaches++;
    return { shmid: m.shmid, data: m.data, readonly: !!(flags & SHM_RDONLY), size: m.size };
  }

  shmdt(attach) {
    const m = this.shmSegments.get(typeof attach === 'number' ? attach : attach?.shmid);
    if (m && m.nattch > 0) m.nattch--;
    return 0;
  }

  shmctl(id, cmd, ctx = {}) {
    const m = this.shmSegments.get(id);
    if (!m) fail('EINVAL', String(id), 'shmctl');
    if (cmd === IPC_RMID) {
      m.dtime = Date.now();
      if (!m.nattch) this.shmSegments.delete(id);
      else m.marked = true;
      return 0;
    }
    if (cmd === IPC_STAT) {
      return {
        shmid: m.shmid, key: m.key, size: m.size, mode: m.mode, uid: m.uid, gid: m.gid,
        cpid: m.cpid, ctime: m.ctime, atime: m.atime, dtime: m.dtime, nattch: m.nattch,
      };
    }
    return 0;
  }

  /* ------------------------------- AF_UNIX -------------------------------- */

  socketpair() {
    const a = new UnixSocket(this.kernel, 'socketpair');
    const b = new UnixSocket(this.kernel, 'socketpair');
    a.peer = b; b.peer = a;
    this.stats.unixConnections++;
    return [a, b];
  }

  bindUnix(path, backlog = 128, ctx = {}) {
    if (this.unixListeners.has(path)) fail('EADDRINUSE', path, 'bind');
    const listener = new UnixListener(this.kernel, path, backlog, ctx);
    this.unixListeners.set(path, listener);
    this.kernel.log?.info(`unix socket listening on ${path}`, 'daemon');
    return listener;
  }

  connectUnix(path) {
    const listener = this.unixListeners.get(path);
    if (!listener || listener.closed) fail('ECONNREFUSED', path, 'connect');
    const serverEnd = new UnixSocket(this.kernel, path);
    const clientEnd = new UnixSocket(this.kernel, path);
    serverEnd.peer = clientEnd;
    clientEnd.peer = serverEnd;
    if (!listener.offer(serverEnd)) fail('ECONNREFUSED', path, 'connect');
    this.stats.unixConnections++;
    return clientEnd;
  }

  /* --------------------------------- info --------------------------------- */

  list() {
    return {
      messages: [...this.msgQueues.values()].map((q) => this._msgStat(q)),
      semaphores: [...this.semSets.values()].map((s) => ({
        semid: s.semid, key: s.key, nsems: s.nsems, mode: s.mode, uid: s.uid, gid: s.gid,
      })),
      shared: [...this.shmSegments.values()].map((m) => ({
        shmid: m.shmid, key: m.key, size: m.size, nattch: m.nattch, mode: m.mode,
        uid: m.uid, gid: m.gid,
      })),
      unix: [...this.unixListeners.keys()],
    };
  }
}
