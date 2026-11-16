/*
 * POSIX path module. `win32` is an alias of the POSIX implementation because
 * the WebOS VFS is strictly POSIX; Windows path semantics do not apply.
 */

function normalizeString(p) {
  if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
  if (!p) return '.';
  const absolute = p.charCodeAt(0) === 47;
  const trailing = p.length > 1 && p.charCodeAt(p.length - 1) === 47;
  const out = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!absolute) out.push('..');
    } else out.push(part);
  }
  let res = out.join('/');
  if (absolute) res = '/' + res;
  else if (!res) res = '.';
  if (trailing && res !== '/' && res !== '.') res += '/';
  return res;
}

export function createPath(cwdProvider = () => (typeof globalThis !== 'undefined' && globalThis.process?.cwd?.()) || '/') {
  function resolve(...args) {
    let resolved = '';
    let absolute = false;
    for (let i = args.length - 1; i >= -1 && !absolute; i--) {
      const p = i >= 0 ? args[i] : cwdProvider();
      if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof p}`);
      if (!p) continue;
      resolved = p + '/' + resolved;
      absolute = p.charCodeAt(0) === 47;
    }
    if (!absolute) resolved = cwdProvider() + '/' + resolved;
    resolved = normalizeString('/' + resolved);
    if (resolved.length > 1 && resolved.charCodeAt(resolved.length - 1) === 47) resolved = resolved.slice(0, -1);
    return resolved;
  }

  function join(...args) {
    const parts = [];
    for (const a of args) {
      if (typeof a !== 'string') throw new TypeError(`The "path" argument must be of type string. Received ${typeof a}`);
      if (a) parts.push(a);
    }
    if (!parts.length) return '.';
    return normalizeString(parts.join('/'));
  }

  function dirname(p) {
    if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string');
    if (!p) return '.';
    const absolute = p.charCodeAt(0) === 47;
    let end = p.length;
    while (end > 0 && p.charCodeAt(end - 1) === 47) end--;
    if (end === 0) return '/';
    let idx = p.lastIndexOf('/', end - 1);
    if (idx === -1) return '.';
    if (idx === 0) return '/';
    while (idx > 0 && p.charCodeAt(idx - 1) === 47) idx--;
    const res = p.slice(0, idx);
    return res || (absolute ? '/' : '.');
  }

  function basename(p, ext) {
    if (typeof p !== 'string') throw new TypeError('The "path" argument must be of type string');
    let end = p.length;
    while (end > 0 && p.charCodeAt(end - 1) === 47) end--;
    if (end === 0) return '';
    const start = p.lastIndexOf('/', end - 1) + 1;
    let base = p.slice(start, end);
    if (ext && ext !== base && base.endsWith(ext)) base = base.slice(0, -ext.length);
    return base;
  }

  function extname(p) {
    const base = basename(p);
    const idx = base.lastIndexOf('.');
    if (idx <= 0) return '';
    return base.slice(idx);
  }

  function relative(from, to) {
    const f = resolve(from).split('/').filter(Boolean);
    const t = resolve(to).split('/').filter(Boolean);
    let common = 0;
    while (common < f.length && common < t.length && f[common] === t[common]) common++;
    const up = f.length - common;
    const parts = Array(up).fill('..').concat(t.slice(common));
    return parts.join('/') || '';
  }

  function parse(p) {
    const root = p.startsWith('/') ? '/' : '';
    const base = basename(p) || '';
    const ext = extname(p);
    const dir = dirname(p);
    return {
      root, dir: dir === '.' && !root ? '' : dir,
      base, ext, name: ext ? base.slice(0, -ext.length) : base,
    };
  }

  function format(o) {
    if (o === null || typeof o !== 'object') throw new TypeError('Path object expected');
    const dir = o.dir || o.root || '';
    const base = o.base || ((o.name || '') + (o.ext || ''));
    if (!dir) return base;
    return dir === (o.root || '') && dir.endsWith('/') ? dir + base : `${dir}/${base}`;
  }

  const path = {
    resolve, normalize: normalizeString, isAbsolute: (p) => typeof p === 'string' && p.charCodeAt(0) === 47,
    join, relative, dirname, basename, extname, parse, format,
    sep: '/', delimiter: ':', toNamespacedPath: (p) => p,
  };
  path.posix = path;
  path.win32 = path;
  path._makeLong = path.toNamespacedPath;
  return path;
}

export const path = createPath();
export const posix = path;
export const win32 = path;
export const join = path.join;
export const resolve = path.resolve;
export const normalize = path.normalize;
export const dirname = path.dirname;
export const basename = path.basename;
export const extname = path.extname;
export const relative = path.relative;
export const isAbsolute = path.isAbsolute;
export const parse = path.parse;
export const format = path.format;
export const sep = path.sep;
export const delimiter = path.delimiter;
