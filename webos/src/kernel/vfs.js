/*
 * WebOS virtual filesystem.
 * Inode based, in-memory, POSIX-ish semantics: permissions, symlinks, hard links,
 * file descriptors, dynamic directories (/proc), character devices.
 */

export const S_IFMT = 0o170000;
export const S_IFSOCK = 0o140000;
export const S_IFLNK = 0o120000;
export const S_IFREG = 0o100000;
export const S_IFBLK = 0o060000;
export const S_IFDIR = 0o040000;
export const S_IFCHR = 0o020000;
export const S_IFIFO = 0o010000;

export const O = {
  RDONLY: 0, WRONLY: 1, RDWR: 2,
  CREAT: 64, EXCL: 128, NOCTTY: 256, TRUNC: 512, APPEND: 1024,
  NONBLOCK: 2048, DSYNC: 4096, DIRECT: 65536, NOFOLLOW: 131072, DIRECTORY: 65536,
  SYNC: 1052672,
};

let nextIno = 1;

export class ErrnoError extends Error {
  constructor(code, path, syscall) {
    super(`${code}: ${syscall || 'syscall'}${path ? ` '${path}'` : ''}`);
    this.name = 'ErrnoError';
    this.code = code;
    this.errno = code;
    this.path = path;
    this.syscall = syscall;
  }
}

const fail = (code, path, syscall) => { throw new ErrnoError(code, path, syscall); };

const typeBit = (t) => ({
  dir: S_IFDIR, file: S_IFREG, symlink: S_IFLNK,
  chr: S_IFCHR, blk: S_IFBLK, fifo: S_IFIFO, sock: S_IFSOCK,
}[t] || 0);

export class Inode {
  constructor(type, perm = 0o644, opts = {}) {
    this.ino = opts.ino ?? nextIno++;
    this.type = type;
    this.perm = perm & 0o7777;
    this.uid = opts.uid ?? 0;
    this.gid = opts.gid ?? 0;
    this.nlink = opts.nlink ?? (type === 'dir' ? 2 : 1);
    const now = Date.now();
    this.atime = this.mtime = this.ctime = this.birthtime = now;
    this.children = type === 'dir' ? new Map() : null;
    this.data = type === 'file' ? (opts.data2 || new Uint8Array(0)) : null;
    this.linkTarget = opts.target ?? null;
    this.device = opts.device ?? null;
    this.dynamic = opts.dynamic ?? null;
    this.parent = null;
  }
  get size() {
    if (this.type === 'file') return this.data.length;
    if (this.type === 'symlink') return typeof this.linkTarget === 'string' ? this.linkTarget.length : 0;
    if (this.type === 'dir') return 4096;
    return 0;
  }
  get mode() { return typeBit(this.type) | this.perm; }
  isDir() { return this.type === 'dir'; }
  isFile() { return this.type === 'file'; }
}

export const dev = {
  /** create a character device inode */
  char(name, opts = {}) {
    return new Inode('chr', opts.perm ?? 0o666, { device: name, uid: 0, gid: 0 });
  },
};

const isAbs = (p) => p.startsWith('/');

/** Normalize purely lexically (no symlink resolution). */
export function normalizePath(base, p) {
  const parts = (isAbs(p) ? p : `${base}/${p}`).split('/');
  const out = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length) out.pop(); continue; }
    out.push(part);
  }
  return '/' + out.join('/');
}

export function joinPath(...ps) {
  return normalizePath('/', ps.filter(Boolean).join('/'));
}

export function dirnamePath(p) {
  p = normalizePath('/', p);
  if (p === '/') return '/';
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

export function basenamePath(p) {
  p = normalizePath('/', p);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

export class FileHandle {
  constructor(vfs, node, flags, path, ctx) {
    this.vfs = vfs;
    this.node = node;
    this.flags = flags;
    this.path = path;
    this.ctx = ctx;
    this.pos = 0;
    this.closed = false;
    this.writable = (flags & 3) !== O.RDONLY;
    this.readable = (flags & 3) !== O.WRONLY;
    if (flags & O.APPEND) this.pos = node.data.length;
  }
  ensure(open = true) { if (this.closed && open) fail('EBADF', this.path, 'read'); }
  read(bufOrLen, offset = 0, length, position = null) {
    this.ensure();
    if (!this.readable) fail('EBADF', this.path, 'read');
    let target, len;
    if (typeof bufOrLen === 'number') {
      len = Math.min(bufOrLen, 1 << 20);
      target = new Uint8Array(len);
    } else {
      target = bufOrLen instanceof Uint8Array ? bufOrLen : new Uint8Array(bufOrLen);
      len = length ?? target.length - offset;
      target = target.subarray(offset, offset + len);
      len = target.length;
    }
    const at = position == null ? this.pos : position;
    const src = this.node.data;
    if (at >= src.length) return typeof bufOrLen === 'number' ? new Uint8Array(0) : 0;
    const n = Math.min(len, src.length - at);
    target.set(src.subarray(at, at + n));
    if (position == null) this.pos += n;
    this.node.atime = Date.now();
    return typeof bufOrLen === 'number' ? target.subarray(0, n) : n;
  }
  write(bytes, offset = 0, length, position = null) {
    this.ensure();
    if (!this.writable) fail('EBADF', this.path, 'write');
    this.vfs.guard(this.path, this.ctx, 'write');
    if (typeof bytes === 'string') bytes = new TextEncoder().encode(bytes);
    const src = bytes instanceof Uint8Array ? bytes.subarray(offset, offset + (length ?? bytes.length - offset)) : new Uint8Array(bytes);
    const at = (this.flags & O.APPEND) ? this.node.data.length : (position == null ? this.pos : position);
    const end = at + src.length;
    let data = this.node.data;
    if (end > data.length) {
      const next = new Uint8Array(end);
      next.set(data);
      data = next;
      this.node.data = data;
    }
    data.set(src, at);
    if (position == null || (this.flags & O.APPEND)) this.pos = end;
    const now = Date.now();
    this.node.mtime = now; this.node.ctime = now;
    this.vfs.notify(this.path, 'change');
    return src.length;
  }
  truncate(len = 0) {
    this.ensure();
    if (!this.writable) fail('EBADF', this.path, 'ftruncate');
    this.vfs.guard(this.path, this.ctx, 'ftruncate');
    const n = Math.max(0, len | 0);
    const next = new Uint8Array(n);
    next.set(this.node.data.subarray(0, Math.min(n, this.node.data.length)));
    this.node.data = next;
    this.node.mtime = Date.now();
    return 0;
  }
  close() { this.closed = true; return 0; }
  stat() { return this.vfs.statObj(this.node); }
}

export class VFS {
  constructor() {
    this.root = new Inode('dir', 0o755);
    this.root.uid = 0; this.root.gid = 0;
    this.root.parent = this.root;
    this.umask = 0o022;
    this.watchers = new Set();
    this.changes = 0;
    /** target path -> mount entry { source, target, fstype, flags:Set, options, root, mountedAt } */
    this.mounts = new Map();
    /** mount root inode -> mount entry (for path reconstruction) */
    this.mountRoots = new Map();
    this.nextMountId = 1;
  }

  // ---------- mount table ----------
  mountFor(path, ctx = {}) {
    const abs = normalizePath(ctx.cwd || '/', path);
    let best = null;
    for (const m of this.mounts.values()) {
      if (m.target === '/' || abs === m.target || abs.startsWith(m.target + '/')) {
        if (!best || m.target.length > best.target.length) best = m;
      }
    }
    return best;
  }

  /** Reject mutations on read-only mounts (EROFS). */
  guard(path, ctx, syscall) {
    const m = this.mountFor(path, ctx);
    if (m && m.flags.has('ro')) fail('EROFS', path, syscall);
  }

  _guardNode(node, path, ctx, syscall) {
    const m = this.mountFor(this._pathOf(node) || path, ctx);
    if (m && m.flags.has('ro')) fail('EROFS', path, syscall);
  }

  parseMountFlags(flags) {
    const set = new Set();
    const options = {};
    const list = Array.isArray(flags) ? flags : String(flags || '').split(',');
    for (const raw of list) {
      const f = String(raw).trim();
      if (!f) continue;
      const eq = f.indexOf('=');
      if (eq > 0) { set.add(f.slice(0, eq)); options[f.slice(0, eq)] = f.slice(eq + 1); }
      else set.add(f);
    }
    if (!set.has('rw') && !set.has('ro')) set.add('rw');
    if (!set.has('relatime')) set.add('relatime');
    return { flags: set, options };
  }

  mount(source, target, fstype = 'tmpfs', flags = 'rw', ctx = {}) {
    const abs = normalizePath(ctx.cwd || '/', target);
    const existing = this.resolve(abs, { ...ctx, uid: 0, cwd: '/' });
    if (!existing.node.isDir()) fail('ENOTDIR', target, 'mount');
    if (this.mounts.has(abs)) fail('EBUSY', target, 'mount');
    if (abs === '/') fail('EBUSY', target, 'mount');
    const parsed = this.parseMountFlags(flags);
    let root;
    if (fstype === 'bind') {
      const src = this.resolve(source, ctx, { followFinal: true });
      if (!src.node.isDir()) fail('ENOTDIR', source, 'mount');
      root = cloneTree(src.node, this);
    } else if (fstype === 'proc' || fstype === 'sysfs' || fstype === 'devtmpfs' || fstype === 'devpts') {
      root = this.mounts.get(`/${fstype === 'sysfs' ? 'sys' : fstype === 'proc' ? 'proc' : fstype === 'devtmpfs' ? 'dev' : 'dev/pts'}`)?.root || existing.node;
    } else {
      root = new Inode('dir', 0o755);
      root.uid = parsed.options.uid != null ? Number(parsed.options.uid) : (ctx.uid ?? 0);
      root.gid = parsed.options.gid != null ? Number(parsed.options.gid) : (ctx.gid ?? 0);
      root.parent = null;
      if (parsed.options.mode) root.perm = parseInt(parsed.options.mode, 8) & 0o7777;
    }
    const entry = {
      id: this.nextMountId++, source: source || fstype, target: abs, fstype,
      flags: parsed.flags, options: parsed.options, root, mountedAt: Date.now(),
    };
    this.mounts.set(abs, entry);
    this.mountRoots.set(root, entry);
    this.notify(abs, 'mount');
    return entry;
  }

  umount(target, ctx = {}) {
    const abs = normalizePath(ctx.cwd || '/', target);
    const entry = this.mounts.get(abs);
    if (!entry) fail('EINVAL', target, 'umount');
    if (abs === '/') fail('EBUSY', target, 'umount');
    for (const m of this.mounts.values()) {
      if (m.target !== abs && m.target.startsWith(abs + '/')) fail('EBUSY', target, 'umount');
    }
    this.mounts.delete(abs);
    this.mountRoots.delete(entry.root);
    this.notify(abs, 'umount');
    return 0;
  }

  mountsList() {
    return [...this.mounts.values()].sort((a, b) => (a.target === '/' ? -1 : b.target === '/' ? 1 : a.target.localeCompare(b.target)));
  }

  /** Render mount flags/options the way /proc/mounts does. */
  mountOptionText(entry) {
    const order = ['rw', 'ro', 'nosuid', 'nodev', 'noexec', 'relatime', 'noatime', 'sync', 'dirsync'];
    const opts = [...entry.flags].filter((f) => !(f in entry.options)).sort((a, b) => {
      const ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
    });
    for (const [k, v] of Object.entries(entry.options || {})) opts.push(`${k}=${v}`);
    return opts.join(',');
  }

  /** statvfs/statfs approximation. */
  statfs(path, ctx = {}) {
    const m = this.mountFor(path, ctx);
    const typeMagic = {
      ext4: 0xEF53, tmpfs: 0x01021994, proc: 0x9fa0, sysfs: 0x62656572,
      devtmpfs: 0x62656572, ramfs: 0x858458f6, bind: 0xEF53,
    };
    let total = 8 * 1024 * 1024 * 1024;
    if (m?.fstype === 'tmpfs' || m?.fstype === 'ramfs') {
      const sizeOpt = m.options.size;
      total = sizeOpt ? parseSizeOption(sizeOpt) : 64 * 1024 * 1024;
    }
    let used = 0, files = 0;
    if (m && (m.fstype === 'tmpfs' || m.fstype === 'ramfs' || m.fstype === 'bind' || m.fstype === 'ext4')) {
      const walk = (node) => {
        files++;
        if (node.type === 'file') used += node.data.length;
        if (node.type === 'dir') for (const c of node.children.values()) walk(c);
      };
      walk(m.root);
    }
    const bsize = 4096;
    const blocks = Math.ceil(total / bsize);
    const bfree = Math.max(0, blocks - Math.ceil(used / bsize));
    return {
      fstype: m?.fstype || 'ext4', type: typeMagic[m?.fstype] || 0xEF53,
      bsize, frsize: bsize, blocks, bfree, bavail: bfree,
      files: Math.max(files, 1), ffree: Math.max(0, 1000000 - files),
      namelen: 255, flags: m?.flags.has('ro') ? 1 : 0,
    };
  }

  // ---------- low level ----------
  _getChild(dir, name, ctx) {
    if (dir.dynamic?.getChild) {
      const n = dir.dynamic.getChild(name, ctx);
      if (n) return n;
    }
    return dir.children.get(name);
  }

  _names(dir, ctx) {
    const names = new Set(dir.children.keys());
    if (dir.dynamic?.names) for (const n of dir.dynamic.names(ctx)) names.add(n);
    return [...names];
  }

  _can(node, ctx, mask) {
    const uid = ctx?.uid ?? 0;
    const gid = ctx?.gid ?? 0;
    const groups = ctx?.groups || [];
    if (uid === 0) {
      if (node.type === 'file' && mask.includes('x') && !(node.perm & 0o111)) return false;
      return true;
    }
    let bits;
    if (node.uid === uid) bits = (node.perm >> 6) & 7;
    else if (node.gid === gid || groups.includes(node.gid)) bits = (node.perm >> 3) & 7;
    else bits = node.perm & 7;
    if (mask.includes('r') && !(bits & 4)) return false;
    if (mask.includes('w') && !(bits & 2)) return false;
    if (mask.includes('x') && !(bits & 1)) return false;
    return true;
  }

  check(node, ctx, mask, path, syscall) {
    if (!this._can(node, ctx, mask)) fail('EACCES', path, syscall);
  }

  /**
   * Resolve a path. Returns { node, parent, name, path, nodePath }.
   * Mount points are transparent: walking through one switches to its root.
   * options.followFinal (default true), allowMissingFinal.
   */
  resolve(path, ctx = {}, opts = {}) {
    if (typeof path !== 'string') fail('EINVAL', String(path), 'resolve');
    const followFinal = opts.followFinal !== false;
    const allowMissing = !!opts.allowMissingFinal;
    path = path === '' ? '.' : path;
    const cwd = ctx.cwd || '/';
    const start = isAbs(path) ? normalizePath('/', path) : normalizePath(cwd, path);
    let queue = start.split('/').filter((c) => c !== '');
    let node = this.root;
    const stack = [this.root];
    const pathStack = [''];
    let curPath = '';
    let parent = null, name = null;
    let links = 0;
    for (let i = 0; i < queue.length; i++) {
      const nm = queue[i];
      if (nm === '.') continue;
      if (nm === '..') {
        if (stack.length > 1) { stack.pop(); pathStack.pop(); }
        node = stack[stack.length - 1];
        curPath = pathStack[pathStack.length - 1];
        continue;
      }
      if (node.type !== 'dir') fail('ENOTDIR', path, 'resolve');
      this.check(node, ctx, 'x', path, 'resolve');
      const childPath = curPath === '' ? '/' + nm : curPath + '/' + nm;
      let child = this.mounts.get(childPath)?.root ?? this._getChild(node, nm, { ...ctx, path });
      const last = i === queue.length - 1;
      if (!child) {
        if (last && allowMissing) return { node: null, parent: node, name: nm, path, nodePath: childPath };
        fail('ENOENT', path, 'resolve');
      }
      if (child.type === 'symlink' && (!last || followFinal)) {
        if (++links > 40) fail('ELOOP', path, 'resolve');
        let target = child.linkTarget;
        if (typeof target === 'function') target = target({ ...ctx, path });
        const abs = target.startsWith('/');
        const base = abs ? '' : dirnamePath(childPath);
        queue = `${base}/${target}`.split('/').filter((c) => c !== '').concat(queue.slice(i + 1));
        node = this.root;
        stack.length = 0; stack.push(this.root);
        pathStack.length = 0; pathStack.push('');
        curPath = '';
        i = -1;
        continue;
      }
      parent = node;
      name = nm;
      node = child;
      stack.push(child);
      pathStack.push(childPath);
      curPath = childPath;
    }
    return { node, parent, name, path, nodePath: curPath || '/' };
  }

  _pathOf(node, ctx) {
    const parts = [];
    let n = node;
    for (let guard = 0; n && guard < 4096; guard++) {
      const m = this.mountRoots.get(n);
      if (m) return (m.target === '/' ? '' : m.target) + (parts.length ? '/' + parts.join('/') : '');
      const p = n.parent;
      if (!p || p === n) break;
      let found = null;
      for (const [k, v] of p.children) if (v === n) { found = k; break; }
      if (!found) break;
      parts.unshift(found);
      n = p;
    }
    return '/' + parts.join('/');
  }

  // ---------- stat ----------
  statObj(node) {
    return {
      dev: 1, ino: node.ino, mode: node.mode, nlink: node.nlink,
      uid: node.uid, gid: node.gid, rdev: 0, size: node.size,
      blksize: 4096, blocks: Math.ceil(node.size / 512),
      atimeMs: node.atime, mtimeMs: node.mtime, ctimeMs: node.ctime, birthtimeMs: node.birthtime,
      atime: new Date(node.atime), mtime: new Date(node.mtime), ctime: new Date(node.ctime), birthtime: new Date(node.birthtime),
      isFile: () => node.type === 'file',
      isDirectory: () => node.type === 'dir',
      isSymbolicLink: () => node.type === 'symlink',
      isFIFO: () => node.type === 'fifo',
      isCharacterDevice: () => node.type === 'chr',
      isBlockDevice: () => node.type === 'blk',
      isSocket: () => node.type === 'sock',
    };
  }

  stat(path, ctx, opts = {}) {
    const { node } = this.resolve(path, ctx, opts);
    return this.statObj(node);
  }

  // ---------- dirs & links ----------
  mkdir(path, ctx = {}, mode = 0o777) {
    this.guard(path, ctx, 'mkdir');
    const { node, parent, name } = this.resolve(path, ctx, { allowMissingFinal: true });
    if (node) fail('EEXIST', path, 'mkdir');
    this.check(parent, ctx, 'wx', path, 'mkdir');
    if (parent.type !== 'dir') fail('ENOTDIR', path, 'mkdir');
    const inode = new Inode('dir', mode & ~this.umask & 0o777);
    inode.uid = ctx.uid ?? 0; inode.gid = ctx.gid ?? 0;
    inode.parent = parent;
    parent.children.set(name, inode);
    parent.nlink++;
    parent.mtime = parent.ctime = Date.now();
    this.notify(path, 'create');
    return 0;
  }

  mkdirp(path, ctx, mode = 0o777) {
    const abs = normalizePath(ctx.cwd || '/', path);
    if (abs === '/') return 0;
    const parts = abs.split('/').filter(Boolean);
    let cur = '';
    for (const p of parts) {
      cur += '/' + p;
      const r = this.resolve(cur, { ...ctx, cwd: '/' }, { allowMissingFinal: true });
      if (!r.node) this.mkdir(cur, { ...ctx, cwd: '/' }, mode);
      else if (!r.node.isDir()) fail('ENOTDIR', cur, 'mkdir');
    }
    return 0;
  }

  rmdir(path, ctx = {}) {
    this.guard(path, ctx, 'rmdir');
    const { node, parent, name } = this.resolve(path, ctx);
    if (!node.isDir()) fail('ENOTDIR', path, 'rmdir');
    this.check(parent, ctx, 'wx', path, 'rmdir');
    if (this._names(node, ctx).length) fail('ENOTEMPTY', path, 'rmdir');
    if (node === this.root) fail('EBUSY', path, 'rmdir');
    parent.children.delete(name);
    parent.nlink--;
    parent.mtime = parent.ctime = Date.now();
    node.parent = null;
    this.notify(path, 'remove');
    return 0;
  }

  unlink(path, ctx = {}) {
    this.guard(path, ctx, 'unlink');
    const { node, parent, name } = this.resolve(path, ctx);
    if (node.isDir()) fail('EISDIR', path, 'unlink');
    this.check(parent, ctx, 'wx', path, 'unlink');
    parent.children.delete(name);
    node.nlink--;
    parent.mtime = parent.ctime = Date.now();
    this.notify(path, 'remove');
    return 0;
  }

  rename(oldPath, newPath, ctx = {}) {
    this.guard(oldPath, ctx, 'rename');
    this.guard(newPath, ctx, 'rename');
    const src = this.resolve(oldPath, ctx);
    const dst = this.resolve(newPath, ctx, { allowMissingFinal: true });
    if (src.node === this.root) fail('EBUSY', oldPath, 'rename');
    if (src.node.isDir() && (newPath === '/' || (newPath + '/').startsWith(oldPath + '/'))) {
      fail('EINVAL', oldPath, 'rename');
    }
    this.check(src.parent, ctx, 'wx', oldPath, 'rename');
    this.check(dst.parent, ctx, 'wx', newPath, 'rename');
    if (dst.node) {
      if (dst.node.isDir() && !src.node.isDir()) fail('EISDIR', newPath, 'rename');
      if (!dst.node.isDir() && src.node.isDir()) fail('ENOTDIR', newPath, 'rename');
      if (dst.node.isDir() && this._names(dst.node, ctx).length) fail('ENOTEMPTY', newPath, 'rename');
      dst.parent.children.delete(dst.name);
      dst.node.nlink--;
    }
    src.parent.children.delete(src.name);
    dst.parent.children.set(dst.name, src.node);
    if (src.node.isDir()) src.node.parent = dst.parent;
    src.parent.mtime = src.parent.ctime = Date.now();
    dst.parent.mtime = dst.parent.ctime = Date.now();
    this.notify(oldPath, 'rename');
    this.notify(newPath, 'create');
    return 0;
  }

  link(oldPath, newPath, ctx = {}) {
    this.guard(newPath, ctx, 'link');
    const src = this.resolve(oldPath, ctx);
    if (src.node.isDir()) fail('EPERM', oldPath, 'link');
    const dst = this.resolve(newPath, ctx, { allowMissingFinal: true });
    if (dst.node) fail('EEXIST', newPath, 'link');
    this.check(dst.parent, ctx, 'wx', newPath, 'link');
    dst.parent.children.set(dst.name, src.node);
    src.node.nlink++;
    src.node.ctime = Date.now();
    this.notify(newPath, 'create');
    return 0;
  }

  symlink(target, path, ctx = {}) {
    this.guard(path, ctx, 'symlink');
    const dst = this.resolve(path, ctx, { allowMissingFinal: true });
    if (dst.node) fail('EEXIST', path, 'symlink');
    this.check(dst.parent, ctx, 'wx', path, 'symlink');
    const inode = new Inode('symlink', 0o777, { target });
    inode.uid = ctx.uid ?? 0; inode.gid = ctx.gid ?? 0;
    dst.parent.children.set(dst.name, inode);
    inode.parent = dst.parent;
    this.notify(path, 'create');
    return 0;
  }

  readlink(path, ctx = {}) {
    const { node } = this.resolve(path, ctx, { followFinal: false });
    if (node.type !== 'symlink') fail('EINVAL', path, 'readlink');
    return typeof node.linkTarget === 'function' ? node.linkTarget(ctx) : node.linkTarget;
  }

  realpath(path, ctx = {}) {
    const { node } = this.resolve(path, ctx);
    return this._pathOf(node, ctx) || normalizePath(ctx.cwd || '/', path);
  }

  chmod(path, mode, ctx = {}) {
    this.guard(path, ctx, 'chmod');
    const { node } = this.resolve(path, ctx);
    if ((ctx.uid ?? 0) !== 0 && node.uid !== (ctx.uid ?? 0)) fail('EPERM', path, 'chmod');
    node.perm = mode & 0o7777;
    node.ctime = Date.now();
    this.notify(path, 'change');
    return 0;
  }

  chown(path, uid, gid, ctx = {}) {
    this.guard(path, ctx, 'chown');
    const { node } = this.resolve(path, ctx);
    if ((ctx.uid ?? 0) !== 0) fail('EPERM', path, 'chown');
    if (uid != null && uid >= 0) node.uid = uid;
    if (gid != null && gid >= 0) node.gid = gid;
    node.ctime = Date.now();
    return 0;
  }

  utimes(path, atime, mtime, ctx = {}) {
    this.guard(path, ctx, 'utimes');
    const { node } = this.resolve(path, ctx);
    this.check(node, ctx, 'w', path, 'utimes');
    if (atime != null) node.atime = atime instanceof Date ? atime.getTime() : atime * 1000;
    if (mtime != null) node.mtime = mtime instanceof Date ? mtime.getTime() : mtime * 1000;
    node.ctime = Date.now();
    return 0;
  }

  truncate(path, len, ctx = {}) {
    this.guard(path, ctx, 'truncate');
    const { node } = this.resolve(path, ctx);
    if (node.type !== 'file') fail('EINVAL', path, 'truncate');
    this.check(node, ctx, 'w', path, 'truncate');
    const next = new Uint8Array(Math.max(0, len));
    next.set(node.data.subarray(0, Math.min(len, node.data.length)));
    node.data = next;
    node.mtime = node.ctime = Date.now();
    this.notify(path, 'change');
    return 0;
  }

  readFile(path, ctx = {}, opts = {}) {
    const { node } = this.resolve(path, ctx, opts);
    if (node.isDir()) fail('EISDIR', path, 'read');
    if (node.dynamic?.read) {
      this.check(node, ctx, 'r', path, 'open');
      node.atime = Date.now();
      const data = node.dynamic.read(ctx);
      return typeof data === 'string' ? new TextEncoder().encode(data) : data;
    }
    if (node.type === 'chr') {
      if (node.device === 'null' || node.device === 'full') return new Uint8Array(0);
      if (node.device === 'zero') return new Uint8Array(4096);
      if (node.device === 'random' || node.device === 'urandom') {
        const b = new Uint8Array(4096);
        globalThis.crypto.getRandomValues(b);
        return b;
      }
      return new Uint8Array(0);
    }
    this.check(node, ctx, 'r', path, 'open');
    node.atime = Date.now();
    return node.data;
  }

  writeFile(path, data, ctx = {}, opts = {}) {
    const target = this.resolve(path, ctx, { followFinal: true, allowMissingFinal: true });
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (target.node?.dynamic) {
      this.guard(target.nodePath || path, ctx, 'open');
      this.check(target.node, ctx, 'w', path, 'open');
      if (!target.node.dynamic.write) fail('EACCES', path, 'write');
      target.node.dynamic.write(bytes, ctx);
      target.node.ctime = Date.now();
      return 0;
    }
    const flags = opts.flag === 'a' || opts.append ? O.WRONLY | O.CREAT | O.APPEND : O.WRONLY | O.CREAT | O.TRUNC;
    const h = this.open(path, flags, ctx, opts.mode ?? 0o666);
    try {
      h.write(bytes);
    } finally { h.close(); }
    return 0;
  }

  open(path, flags, ctx = {}, mode = 0o666) {
    if (typeof flags === 'string') flags = parseFlags(flags);
    const followFinal = !(flags & O.NOFOLLOW);
    const allowMissing = !!(flags & O.CREAT);
    const r = this.resolve(path, ctx, { followFinal, allowMissingFinal: allowMissing });
    let { node } = r;
    const writing = (flags & 3) !== O.RDONLY || (flags & (O.TRUNC | O.CREAT | O.APPEND));
    if (writing) this.guard(r.nodePath || path, ctx, 'open');
    if (!node) {
      this.check(r.parent, ctx, 'wx', path, 'open');
      if (flags & O.DIRECTORY) fail('ENOENT', path, 'open');
      node = new Inode('file', (mode & ~this.umask) & 0o777);
      node.uid = ctx.uid ?? 0; node.gid = ctx.gid ?? 0;
      node.parent = r.parent;
      r.parent.children.set(r.name, node);
      this.notify(path, 'create');
    } else {
      if (flags & O.CREAT && flags & O.EXCL) fail('EEXIST', path, 'open');
      if (node.isDir()) {
        if ((flags & 3) !== O.RDONLY) fail('EISDIR', path, 'open');
        if (flags & O.DIRECTORY) return new FileHandle(this, node, flags, path, ctx);
        fail('EISDIR', path, 'open');
      }
      if (node.type === 'chr') {
        if (node.device === 'full' && (flags & 3) !== O.RDONLY) fail('ENOSPC', path, 'write');
        const h = new FileHandle(this, new Inode('file', 0o600, { data2: new Uint8Array(0) }), flags, path, ctx);
        h.device = node.device;
        return h;
      }
      this.check(node, ctx, (flags & 3) === O.RDONLY ? 'r' : ((flags & 3) === O.WRONLY ? 'w' : 'rw'), path, 'open');
      if (flags & O.TRUNC) {
        if (!this._can(node, ctx, 'w')) fail('EACCES', path, 'open');
        node.data = new Uint8Array(0);
        node.mtime = node.ctime = Date.now();
      }
    }
    return new FileHandle(this, node, flags, path, ctx);
  }

  readdir(path, ctx = {}, opts = {}) {
    const { node } = this.resolve(path, ctx);
    if (!node.isDir()) fail('ENOTDIR', path, 'scandir');
    this.check(node, ctx, 'r', path, 'scandir');
    node.atime = Date.now();
    const names = this._names(node, ctx);
    return opts.withFileTypes ? names.map((n) => ({ name: n, node: this._getChild(node, n, ctx) })) : names;
  }

  readdirNodes(path, ctx = {}) {
    const { node } = this.resolve(path, ctx);
    if (!node.isDir()) fail('ENOTDIR', path, 'scandir');
    this.check(node, ctx, 'r', path, 'scandir');
    return new Map(this._names(node, ctx).map((n) => [n, this._getChild(node, n, ctx)]));
  }

  exists(path, ctx = {}) {
    try { this.resolve(path, ctx); return true; } catch (e) { return false; }
  }

  access(path, mode, ctx = {}) {
    const { node } = this.resolve(path, ctx);
    let mask = '';
    if (mode & 4) mask += 'r';
    if (mode & 2) mask += 'w';
    if (mode & 1) mask += 'x';
    this.check(node, ctx, mask, path, 'access');
    return 0;
  }

  // ---------- watchers ----------
  watch(path, cb) {
    const w = { path: normalizePath('/', path), cb };
    this.watchers.add(w);
    return () => this.watchers.delete(w);
  }
  notify(path, event) {
    this.changes++;
    const abs = normalizePath('/', path);
    for (const w of this.watchers) {
      if (abs === w.path || abs.startsWith(w.path === '/' ? '/' : w.path + '/')) {
        try { w.cb(event, abs); } catch { /* ignore watcher errors */ }
      }
    }
  }
}

export function parseFlags(flags) {
  const m = {
    r: O.RDONLY, 'r+': O.RDWR,
    w: O.WRONLY | O.CREAT | O.TRUNC, 'w+': O.RDWR | O.CREAT | O.TRUNC,
    a: O.WRONLY | O.CREAT | O.APPEND, 'a+': O.RDWR | O.CREAT | O.APPEND,
    wx: O.WRONLY | O.CREAT | O.TRUNC | O.EXCL, 'wx+': O.RDWR | O.CREAT | O.TRUNC | O.EXCL,
    ax: O.WRONLY | O.CREAT | O.APPEND | O.EXCL, 'ax+': O.RDWR | O.CREAT | O.APPEND | O.EXCL,
  };
  return m[flags] ?? O.RDONLY;
}

/** Parse tmpfs-style size options: 64k, 8M, 1g, 4096. */
export function parseSizeOption(value) {
  const m = /^([0-9]+(?:\.[0-9]+)?)\s*([kmgt]?)b?$/i.exec(String(value).trim());
  if (!m) return 64 * 1024 * 1024;
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()];
  return Math.floor(Number(m[1]) * mult);
}

/** Deep-copy a subtree for bind mounts (files become copy-on-mount). */
export function cloneTree(node, vfs) {
  const copy = new Inode(node.type, node.perm, {
    uid: node.uid, gid: node.gid, target: node.linkTarget, device: node.device,
    data2: node.type === 'file' ? new Uint8Array(node.data) : undefined,
  });
  copy.atime = node.atime; copy.mtime = node.mtime; copy.ctime = node.ctime; copy.birthtime = node.birthtime;
  if (node.type === 'dir') {
    copy.parent = null;
    for (const [name, child] of node.children) {
      const c = cloneTree(child, vfs);
      c.parent = copy;
      copy.children.set(name, c);
    }
  }
  return copy;
}
