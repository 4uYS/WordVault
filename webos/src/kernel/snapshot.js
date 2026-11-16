/*
 * Whole-machine snapshots.
 *
 * The snapshot captures the persistent parts of the virtual machine: the
 * filesystem tree, users/groups, hostname and tmpfs mount contents. Runtime
 * state (processes, open fds, IPC, sockets, timers) is deliberately excluded:
 * a JavaScript engine cannot serialize live async stacks portably. Restoring
 * therefore behaves like a fresh boot with the saved disk image attached.
 */

import { Inode } from './vfs.js';

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SKIP = new Set(['proc', 'sys', 'dev']);

function b64encode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i], b = i + 1 < bytes.length ? bytes[i + 1] : 0, c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b >> 4)];
    out += i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += i + 2 < bytes.length ? B64[c & 63] : '=';
  }
  return out;
}

function b64decode(text) {
  const map = new Map([...B64].map((ch, i) => [ch, i]));
  const out = [];
  let acc = 0, bits = 0;
  for (const ch of String(text)) {
    if (ch === '=') break;
    if (/\s/.test(ch)) continue;
    const v = map.get(ch);
    if (v == null) continue;
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function serializeNode(node) {
  if (!node || node.dynamic) return null;
  const base = { perm: node.perm, uid: node.uid, gid: node.gid, atime: node.atime, mtime: node.mtime, ctime: node.ctime };
  if (node.type === 'dir') {
    const children = {};
    for (const [name, child] of node.children) {
      const s = serializeNode(child);
      if (s) children[name] = s;
    }
    return { t: 'd', ...base, children };
  }
  if (node.type === 'file') return { t: 'f', ...base, data: b64encode(node.data) };
  if (node.type === 'symlink') {
    if (typeof node.linkTarget !== 'string') return null;
    return { t: 'l', ...base, target: node.linkTarget };
  }
  if (node.type === 'chr') return { t: 'c', ...base, device: node.device };
  if (node.type === 'fifo') return { t: 'p', ...base };
  if (node.type === 'sock') return { t: 's', ...base };
  return null;
}

function materialize(spec, parent) {
  if (!spec) return null;
  const type = { d: 'dir', f: 'file', l: 'symlink', c: 'chr', p: 'fifo', s: 'sock' }[spec.t];
  if (!type) return null;
  const node = new Inode(type, spec.perm, {
    uid: spec.uid, gid: spec.gid, target: spec.target, device: spec.device,
    data2: spec.t === 'f' ? b64decode(spec.data) : undefined,
  });
  node.atime = spec.atime || Date.now();
  node.mtime = spec.mtime || node.atime;
  node.ctime = spec.ctime || node.atime;
  node.parent = parent;
  if (type === 'dir') {
    for (const [name, child] of Object.entries(spec.children || {})) {
      const c = materialize(child, node);
      if (c) node.children.set(name, c);
    }
  }
  return node;
}

function overlayDir(vfs, node, spec, ctx) {
  if (!spec || spec.t !== 'd') return;
  for (const [name, child] of Object.entries(spec.children || {})) {
    const path = `${vfs._pathOf(node) === '/' ? '' : vfs._pathOf(node)}/${name}`;
    if (child.t === 'd') {
      try { vfs.mkdir(path, ctx, child.perm); } catch { /* exists */ }
      const r = vfs.resolve(path, ctx);
      r.node.perm = child.perm; r.node.uid = child.uid; r.node.gid = child.gid;
      r.node.atime = child.atime; r.node.mtime = child.mtime; r.node.ctime = child.ctime;
      overlayDir(vfs, r.node, child, ctx);
    } else if (child.t === 'f') {
      vfs.writeFile(path, b64decode(child.data), ctx, { mode: child.perm });
      try { vfs.chmod(path, child.perm, { uid: 0, gid: 0, cwd: '/' }); } catch { /* ro */ }
      try { vfs.chown(path, child.uid, child.gid, { uid: 0, gid: 0, cwd: '/' }); } catch { /* ignore */ }
    } else if (child.t === 'l') {
      try { vfs.unlink(path, ctx); } catch { /* missing */ }
      try { vfs.symlink(child.target, path, ctx); } catch { /* ro */ }
    }
  }
}

/** Capture a JSON-serializable snapshot of the machine's persistent state. */
export function exportState(kernel) {
  const children = {};
  for (const [name, child] of kernel.vfs.root.children) {
    if (SKIP.has(name)) continue;
    const s = serializeNode(child);
    if (s) children[name] = s;
  }
  const mounts = [];
  for (const m of kernel.vfs.mountsList()) {
    if (m.target === '/') continue;
    if (['proc', 'sysfs', 'devtmpfs', 'devpts'].includes(m.fstype)) continue;
    mounts.push({
      source: m.source, target: m.target, fstype: m.fstype,
      flags: [...m.flags], options: m.options, root: serializeNode(m.root),
    });
  }
  return {
    format: 'webos-snapshot', version: 1, createdAt: Date.now(),
    hostname: kernel.hostname, domainname: kernel.domainname, machine: kernel.machine,
    timezone: kernel.clock.tz,
    users: kernel.users.map((u) => ({ ...u })),
    groups: kernel.groups.map((g) => ({ ...g, members: [...g.members] })),
    vfs: { t: 'd', perm: 0o755, uid: 0, gid: 0, children },
    mounts,
    log: kernel.log.entries.slice(-200),
  };
}

/** Restore a snapshot produced by exportState() into an already-booted kernel. */
export function importState(kernel, state) {
  if (!state || state.format !== 'webos-snapshot') throw new Error('not a WebOS snapshot');
  const ctx = { uid: 0, gid: 0, groups: [0], cwd: '/' };
  if (state.hostname) kernel.hostname = state.hostname;
  if (state.domainname != null) kernel.domainname = state.domainname;
  if (state.machine) kernel.machine = state.machine;
  if (Array.isArray(state.users) && state.users.length) kernel.users = state.users.map((u) => ({ ...u }));
  if (Array.isArray(state.groups) && state.groups.length) kernel.groups = state.groups.map((g) => ({ ...g, members: [...g.members] }));
  overlayDir(kernel.vfs, kernel.vfs.root, state.vfs, ctx);
  for (const spec of state.mounts || []) {
    try {
      if (kernel.vfs.mounts.has(spec.target)) kernel.vfs.umount(spec.target, ctx);
      const entry = kernel.vfs.mount(spec.source, spec.target, spec.fstype, (spec.flags || ['rw']).join(','), ctx);
      if (spec.root) {
        kernel.vfs.mountRoots.delete(entry.root);
        entry.root = materialize(spec.root, null);
        entry.options = spec.options || {};
        kernel.vfs.mountRoots.set(entry.root, entry);
      }
    } catch { /* skip incompatible mount */ }
  }
  if (Array.isArray(state.log)) {
    kernel.log.entries = state.log.slice();
    kernel.log.seq = kernel.log.entries.reduce((a, e) => Math.max(a, e.seq || 0), 0);
  }
  kernel.log.notice(`restored snapshot from ${new Date(state.createdAt || Date.now()).toISOString()}`, 'kern');
  return kernel;
}

export { b64encode, b64decode, materialize };
