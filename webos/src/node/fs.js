/*
 * `fs` implemented over the WebOS VFS, exposing sync, callback and
 * promise APIs. File descriptors map to VFS FileHandles in a per-runtime table.
 */

import { O, normalizePath } from '../kernel/vfs.js';
import { Buffer } from './buffer.js';
import { Readable, Writable } from './stream.js';

const ENCODING = new TextEncoder();
const DECODER = new TextDecoder('utf-8');

const toBytes = (data, encoding) => {
  if (typeof data === 'string') return encoding ? Buffer.from(data, encoding) : ENCODING.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('data must be a string, Buffer, TypedArray or DataView');
};

const optsOf = (opts) => {
  if (typeof opts === 'string') return { encoding: opts };
  return opts || {};
};

export function createFs(kernel, getProc) {
  const realVfs = kernel.vfs;
  const procs = () => getProc?.() || { uid: 1000, gid: 1000, groups: [1000], cwd: '/home/user' };
  const cred = () => {
    const p = procs();
    const cwd = typeof p.cwd === 'function' ? p.cwd() : p.cwd;
    return { uid: p.uid ?? 1000, gid: p.gid ?? 1000, groups: p.groups || [], cwd: cwd || '/' };
  };

  const relPath = (p) => {
    const cwd = cred().cwd || '/';
    return normalizePath(cwd, String(p));
  };

  // Resolve relative paths against the process cwd, like Node's fs does.
  const vfs = new Proxy(realVfs, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (typeof value !== 'function') return value;
      return (...args) => {
        if (prop === 'symlink') {
          if (typeof args[1] === 'string') args[1] = relPath(args[1]);
        } else if (prop === 'rename' || prop === 'copyFile' || prop === 'cp' || prop === 'link') {
          if (typeof args[0] === 'string') args[0] = relPath(args[0]);
          if (typeof args[1] === 'string') args[1] = relPath(args[1]);
        } else if (typeof args[0] === 'string') {
          args[0] = relPath(args[0]);
        }
        return value.apply(target, args);
      };
    },
  });

  const fdTable = new Map();
  let nextFd = 3;
  const allocFd = (handle) => {
    const fd = nextFd++;
    fdTable.set(fd, handle);
    return fd;
  };
  const getHandle = (fd) => {
    const h = fdTable.get(fd);
    if (!h) {
      const e = new Error(`EBADF: bad file descriptor, ${fd}`);
      e.code = 'EBADF'; e.errno = 9; e.syscall = 'read';
      throw e;
    }
    return h;
  };

  const cbify = (fn, mapResult) => function (...args) {
    const cb = args[args.length - 1];
    if (typeof cb !== 'function') throw new TypeError('Callback must be a function');
    args.pop();
    queueMicrotask(() => {
      try {
        const result = fn.apply(null, args);
        cb(null, mapResult ? mapResult(result) : result);
      } catch (e) { cb(e); }
    });
  };

  const decodeResult = (bytes, opts) => {
    const o = optsOf(opts);
    if (o.encoding) return Buffer.from(bytes).toString(o.encoding === 'buffer' ? undefined : o.encoding);
    if (o.flag === 'b' || o.encoding === 'buffer') return Buffer.from(bytes);
    return Buffer.from(bytes);
  };

  /* ---------------------------- reading / writing ---------------------------- */

  function readFileSync(path, opts) {
    const o = optsOf(opts);
    const bytes = vfs.readFile(path, cred(), { followFinal: o.flag !== 'n' });
    return decodeResult(bytes, o);
  }

  function writeFileSync(path, data, opts) {
    const o = optsOf(opts);
    const bytes = toBytes(data, o.encoding);
    vfs.writeFile(path, bytes, cred(), { mode: o.mode ?? 0o666, flag: o.flag });
  }

  function appendFileSync(path, data, opts) {
    const o = optsOf(opts);
    const bytes = toBytes(data, o.encoding);
    const h = vfs.open(path, O.WRONLY | O.CREAT | O.APPEND, cred(), o.mode ?? 0o666);
    try { h.write(bytes); } finally { h.close(); }
  }

  function existsSync(path) {
    try { vfs.resolve(path, cred()); return true; } catch { return false; }
  }

  /* --------------------------------- metadata --------------------------------- */

  function statSyncInner(path, follow = true) {
    const st = vfs.stat(path, cred(), { followFinal: follow });
    return st;
  }
  const statSync = (path) => statSyncInner(path, true);
  const lstatSync = (path) => statSyncInner(path, false);

  function fstatSync(fd) { return getHandle(fd).stat(); }

  function readdirSync(path, opts) {
    const o = optsOf(opts);
    if (o.withFileTypes) {
      const map = vfs.readdirNodes(path, cred());
      const out = [];
      for (const [name, node] of map) {
        out.push({
          name, parentPath: path,
          isFile: () => node.type === 'file',
          isDirectory: () => node.type === 'dir',
          isSymbolicLink: () => node.type === 'symlink',
          isFIFO: () => node.type === 'fifo',
          isCharacterDevice: () => node.type === 'chr',
          isBlockDevice: () => node.type === 'blk',
          isSocket: () => node.type === 'sock',
        });
      }
      return out;
    }
    const names = vfs.readdir(path, cred());
    if (o.encoding === 'buffer') return names.map((n) => Buffer.from(n));
    return names;
  }

  function mkdirSync(path, opts) {
    const o = typeof opts === 'number' ? { mode: opts } : (opts || {});
    if (o.recursive) vfs.mkdirp(path, cred(), o.mode ?? 0o777);
    else vfs.mkdir(path, cred(), o.mode ?? 0o777);
    return o.recursive ? path : undefined;
  }

  function mkdtempSync(prefix) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    for (let attempt = 0; attempt < 100; attempt++) {
      let suffix = '';
      for (let i = 0; i < 6; i++) suffix += alphabet[Math.floor(Math.random() * alphabet.length)];
      const dir = prefix.replace(/X{6}/, suffix);
      if (!existsSync(dir)) { vfs.mkdir(dir, cred(), 0o700); return dir; }
    }
    throw new Error('EEXIST: unable to create a unique temporary directory');
  }

  function removeTree(path) {
    let st;
    try { st = vfs.stat(path, cred(), { followFinal: false }); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
    if (st.isDirectory()) {
      for (const name of vfs.readdir(path, cred())) removeTree(path === '/' ? '/' + name : `${path}/${name}`);
      vfs.rmdir(path, cred());
    } else {
      vfs.unlink(path, cred());
    }
  }

  function rmdirSync(path, opts) {
    const o = typeof opts === 'number' ? {} : (opts || {});
    if (o.recursive) removeTree(path);
    else vfs.rmdir(path, cred());
  }

  function unlinkSync(path) { vfs.unlink(path, cred()); }

  function rmSync(path, opts) {
    const o = opts || {};
    try {
      const st = vfs.stat(path, cred(), { followFinal: false });
      if (st.isDirectory()) {
        if (!o.recursive) {
          const e = new Error(`EISDIR: illegal operation on a directory, rm '${path}'`);
          e.code = 'EISDIR'; e.errno = 21; e.path = path; e.syscall = 'rm';
          throw e;
        }
        removeTree(path);
      } else unlinkSync(path);
    } catch (e) {
      if (o.force && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return;
      throw e;
    }
  }

  function renameSync(from, to) { vfs.rename(from, to, cred()); }

  function copyFileSync(src, dst) {
    const data = vfs.readFile(src, cred());
    vfs.writeFile(dst, data, cred());
  }

  function cpSync(src, dst, opts = {}) {
    const st = vfs.stat(src, cred(), { followFinal: true });
    if (st.isDirectory()) {
      if (opts.recursive) {
        if (!existsSync(dst)) vfs.mkdirp(dst, cred(), st.mode & 0o777);
        for (const name of vfs.readdir(src, cred())) {
          cpSync(`${src}/${name}`, `${dst}/${name}`, opts);
        }
      }
    } else {
      copyFileSync(src, dst);
      try { vfs.chmod(dst, st.mode & 0o777, cred()); } catch { /* best effort */ }
    }
  }

  function chmodSync(path, mode) { vfs.chmod(path, mode, cred()); }
  function chownSync(path, uid, gid) { vfs.chown(path, uid, gid, cred()); }

  function utimesSync(path, atime, mtime) {
    const toSec = (t) => (t instanceof Date ? t.getTime() / 1000 : Number(t));
    vfs.utimes(path, toSec(atime), toSec(mtime), cred());
  }

  function truncateSync(path, len = 0) { vfs.truncate(path, len, cred()); }

  function accessSync(path, mode = 0) { vfs.access(path, mode, cred()); }

  function realpathSync(path) { return vfs.realpath(path, cred()); }

  function symlinkSync(target, path) { vfs.symlink(target, path, cred()); }
  function linkSync(existing, newPath) { vfs.link(existing, newPath, cred()); }
  function readlinkSync(path) { return vfs.readlink(path, cred()); }

  function statfsSync() {
    return {
      type: 0xef53, bsize: 4096, blocks: 131072, bfree: 65536, bavail: 65536,
      files: 32768, ffree: 16384, fsid: 0, flags: 0,
    };
  }

  /* -------------------------------- file descriptors -------------------------------- */

  function openSync(path, flags = 'r', mode = 0o666) {
    const h = vfs.open(path, flags, cred(), mode);
    return allocFd(h);
  }

  function closeSync(fd) {
    const h = fdTable.get(fd);
    if (!h) return;
    fdTable.delete(fd);
    h.close();
  }

  function readSync(fd, buffer, offset = 0, length = buffer.length - offset, position = null) {
    const h = getHandle(fd);
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    return h.read(buffer, offset, length, position);
  }

  function writeSync(fd, buffer, offset = 0, length, position = null) {
    const h = getHandle(fd);
    if (typeof buffer === 'string') {
      const bytes = Buffer.from(buffer, typeof offset === 'string' ? offset : 'utf8');
      return h.write(bytes, 0, bytes.length, position ?? (typeof length === 'number' ? length : null));
    }
    return h.write(buffer, offset, length, position);
  }

  function writevSync(fd, buffers, position = null) {
    const h = getHandle(fd);
    let total = 0;
    for (const b of buffers) total += h.write(b, 0, b.length, position == null ? null : position + total);
    return total;
  }

  /* ------------------------------- streams ------------------------------- */

  function createReadStream(path, opts = {}) {
    const stream = new Readable({ highWaterMark: opts.highWaterMark ?? 65536 });
    let handle = null;
    let started = false;
    let position = opts.start ?? 0;
    const end = opts.end ?? Infinity;
    const pump = () => {
      if (stream.destroyed) { if (handle) handle.close(); return; }
      try {
        if (!handle) {
          handle = vfs.open(path, 'r', cred());
          stream.emit('open', handle);
        }
        const want = Math.min(opts.highWaterMark ?? 65536, end + 1 - position);
        if (want <= 0) { handle.close(); handle = null; stream.push(null); stream.emit('close'); return; }
        const chunk = handle.read(want, 0, want, position);
        if (chunk.length) {
          position += chunk.length;
          stream.push(Buffer.from(chunk));
          queueMicrotask(pump);
        } else {
          handle.close(); handle = null;
          stream.push(null);
          stream.emit('close');
        }
      } catch (e) { stream.destroy(e); }
    };
    stream._startPump = () => { if (!started) { started = true; queueMicrotask(pump); } };
    stream.on('newListener', (name) => { if (name === 'data' || name === 'readable') stream._startPump(); });
    stream.on('resume', () => stream._startPump());
    queueMicrotask(() => stream._startPump());
    return stream;
  }

  function createWriteStream(path, opts = {}) {
    let handle = null;
    const stream = new Writable({
      highWaterMark: opts.highWaterMark ?? 16384,
      write(chunk, enc, cb) {
        try {
          if (!handle) {
            handle = vfs.open(path, opts.flags || 'w', cred(), opts.mode ?? 0o666);
            stream.emit('open', handle);
          }
          handle.write(chunk);
          cb();
        } catch (e) { cb(e); }
      },
      final(cb) { if (handle) { handle.close(); handle = null; } cb(); },
    });
    stream.path = path;
    stream.on('finish', () => stream.emit('close'));
    return stream;
  }

  /* ------------------------------- watching ------------------------------- */

  function watch() {
    const watcher = {
      close() {}, unref() {}, ref() { return this; },
      on() { return this; }, once() { return this; }, addListener() { return this; },
      removeListener() { return this; }, removeAllListeners() { return this; },
      _note: 'filesystem watching is not supported in the browser sandbox',
    };
    return watcher;
  }

  /* ------------------------------- module object ------------------------------- */

  const constants = {
    F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
    O_RDONLY: O.RDONLY, O_WRONLY: O.WRONLY, O_RDWR: O.RDWR,
    O_CREAT: O.CREAT, O_EXCL: O.EXCL, O_TRUNC: O.TRUNC, O_APPEND: O.APPEND,
    O_NOFOLLOW: O.NOFOLLOW, O_DIRECTORY: O.DIRECTORY, O_SYNC: O.SYNC,
    S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,
    S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000, S_IFSOCK: 0o140000,
    COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
    UV_FS_SYMLINK_DIR: 1, UV_FS_SYMLINK_JUNCTION: 2,
  };

  const M = {
    constants,
    readFileSync, writeFileSync, appendFileSync, existsSync,
    statSync, lstatSync, fstatSync, readdirSync, mkdirSync, mkdtempSync,
    rmdirSync, unlinkSync, rmSync, renameSync, copyFileSync, cpSync,
    chmodSync, chownSync, utimesSync, truncateSync, accessSync,
    realpathSync, symlinkSync, linkSync, readlinkSync, statfsSync,
    openSync, closeSync, readSync, writeSync, writevSync,
    createReadStream, createWriteStream, watch,
    readFile: cbify(readFileSync),
    writeFile: cbify(writeFileSync),
    appendFile: cbify(appendFileSync),
    stat: cbify(statSync),
    lstat: cbify(lstatSync),
    fstat: cbify(fstatSync),
    readdir: cbify(readdirSync),
    mkdir: cbify(mkdirSync),
    mkdtemp: cbify(mkdtempSync),
    rmdir: cbify(rmdirSync),
    unlink: cbify(unlinkSync),
    rm: cbify(rmSync),
    rename: cbify(renameSync),
    copyFile: cbify(copyFileSync),
    cp: cbify(cpSync),
    chmod: cbify(chmodSync),
    chown: cbify(chownSync),
    utimes: cbify(utimesSync),
    truncate: cbify(truncateSync),
    access: cbify(accessSync),
    realpath: cbify(realpathSync),
    symlink: cbify(symlinkSync),
    link: cbify(linkSync),
    readlink: cbify(readlinkSync),
    statfs: cbify(statfsSync),
    open: cbify(openSync),
    close: cbify(closeSync),
    read: function read(fd, buffer, offset, length, position, cb) {
      if (typeof offset === 'function') { cb = offset; offset = 0; length = buffer.length; position = null; }
      else if (typeof length === 'function') { cb = length; length = buffer.length - offset; position = null; }
      else if (typeof position === 'function') { cb = position; position = null; }
      queueMicrotask(() => {
        try { cb(null, readSync(fd, buffer, offset, length, position), buffer); } catch (e) { cb(e); }
      });
    },
    write: function write(fd, buffer, offset, length, position, cb) {
      if (typeof offset === 'function') { cb = offset; offset = 0; length = undefined; position = null; }
      else if (typeof length === 'function') { cb = length; length = undefined; position = null; }
      else if (typeof position === 'function') { cb = position; position = null; }
      queueMicrotask(() => {
        try {
          const n = writeSync(fd, buffer, offset, length, position);
          cb(null, n, typeof buffer === 'string' ? buffer : buffer);
        } catch (e) { cb(e); }
      });
    },
    exists: (path, cb) => queueMicrotask(() => cb(existsSync(path))),
  };

  const promises = {
    readFile: async (p, o) => readFileSync(p, o),
    writeFile: async (p, d, o) => writeFileSync(p, d, o),
    appendFile: async (p, d, o) => appendFileSync(p, d, o),
    stat: async (p, o) => statSync(p, o),
    lstat: async (p, o) => lstatSync(p, o),
    fstat: async (fd, o) => fstatSync(fd),
    readdir: async (p, o) => readdirSync(p, o),
    mkdir: async (p, o) => mkdirSync(p, o),
    mkdtemp: async (p) => mkdtempSync(p),
    rmdir: async (p, o) => rmdirSync(p, o),
    unlink: async (p) => unlinkSync(p),
    rm: async (p, o) => rmSync(p, o),
    rename: async (a, b) => renameSync(a, b),
    copyFile: async (a, b) => copyFileSync(a, b),
    cp: async (a, b, o) => cpSync(a, b, o),
    chmod: async (p, m) => chmodSync(p, m),
    chown: async (p, u, g) => chownSync(p, u, g),
    utimes: async (p, a, m) => utimesSync(p, a, m),
    truncate: async (p, n) => truncateSync(p, n),
    access: async (p, m) => accessSync(p, m),
    realpath: async (p) => realpathSync(p),
    symlink: async (t, p) => symlinkSync(t, p),
    link: async (a, b) => linkSync(a, b),
    readlink: async (p) => readlinkSync(p),
    statfs: async () => statfsSync(),
    watch: () => watch(),
    open: async (p, f, m) => {
      const fd = openSync(p, f, m);
      return {
        fd,
        read: async (buffer, offset, length, position) => readSync(fd, buffer, offset, length, position),
        write: async (buffer, offset, length, position) => writeSync(fd, buffer, offset, length, position),
        close: async () => closeSync(fd),
        stat: async () => fstatSync(fd),
      };
    },
  };
  M.promises = promises;

  return M;
}

export default createFs;
