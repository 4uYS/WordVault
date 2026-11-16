/* Shared helpers for command implementations. */

export function parseOpts(argv, shortSpec = '', longMap = {}) {
  const opts = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (a === '-' || !a.startsWith('-')) { opts._.push(a); i++; continue; }
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      const def = longMap[name];
      if (def == null) { opts._.push(a); i++; continue; }
      if (def.endsWith(':')) {
        if (val === undefined) val = argv[++i];
        opts[def.slice(0, -1)] = val;
      } else opts[def] = true;
      i++;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const ch = a[k];
      const idx = shortSpec.indexOf(ch);
      if (idx < 0) { opts._.push('-' + ch); continue; }
      if (shortSpec[idx + 1] === ':') {
        let val = a.slice(k + 1);
        if (val === '') val = argv[++i];
        opts[ch] = val;
        k = a.length;
      } else opts[ch] = true;
    }
    i++;
  }
  return opts;
}

export function resolvePath(ctx, p) {
  if (p === '~') return ctx.home || '/home/user';
  if (p.startsWith('~/')) return (ctx.home || '/home/user') + p.slice(1);
  return p;
}

export function statOf(ctx, p, { follow = true } = {}) {
  return ctx.vfs.stat(resolvePath(ctx, p), ctx.cred(), { followFinal: follow });
}

export function tryStat(ctx, p, opts = {}) {
  try { return statOf(ctx, p, opts); } catch { return null; }
}

export function readTextFile(ctx, p) {
  return new TextDecoder().decode(ctx.vfs.readFile(resolvePath(ctx, p), ctx.cred()));
}

export function writeTextFile(ctx, p, text, opts = {}) {
  ctx.vfs.writeFile(resolvePath(ctx, p), text, ctx.cred(), opts);
}

export function errnoText(e) {
  const map = {
    ENOENT: 'No such file or directory', EACCES: 'Permission denied', EPERM: 'Operation not permitted',
    ENOTDIR: 'Not a directory', EISDIR: 'Is a directory', EEXIST: 'File exists',
    ENOTEMPTY: 'Directory not empty', EINVAL: 'Invalid argument', ELOOP: 'Too many levels of symbolic links',
    ENOSPC: 'No space left on device', EXDEV: 'Invalid cross-device link',
  };
  return map[e?.code] || e?.code || e?.message || String(e);
}

export function modeString(mode) {
  const type = { 0o040000: 'd', 0o100000: '-', 0o120000: 'l', 0o020000: 'c', 0o060000: 'b', 0o010000: 'p', 0o140000: 's' }[mode & 0o170000] || '?';
  const bit = (n, c) => (mode & n ? c : '-');
  let s = type + bit(0o400, 'r') + bit(0o200, 'w') + bit(0o100, 'x')
    + bit(0o40, 'r') + bit(0o20, 'w') + bit(0o10, 'x')
    + bit(0o4, 'r') + bit(0o2, 'w') + bit(0o1, 'x');
  if (mode & 0o4000) s = s.slice(0, 3) + (mode & 0o100 ? 's' : 'S') + s.slice(4);
  if (mode & 0o2000) s = s.slice(0, 6) + (mode & 0o10 ? 's' : 'S') + s.slice(7);
  if (mode & 0o1000) s = s.slice(0, 9) + (mode & 0o1 ? 't' : 'T');
  return s;
}

export function humanSize(n) {
  if (n < 1024) return String(n);
  const units = ['K', 'M', 'G', 'T', 'P'];
  let v = n;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) { v /= 1024; u++; }
  return (v >= 10 ? v.toFixed(0) : v.toFixed(1)) + units[u];
}

export function pad(s, width, right = false) {
  s = String(s);
  return right ? s.padStart(width) : s.padEnd(width);
}

export function fmtDate(ms, { long = false } = {}) {
  const d = new Date(ms);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  if (long) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${hh}:${mm}:${String(d.getUTCSeconds()).padStart(2, '0')}.000000000 +0000`;
  }
  const now = Date.now();
  const sixMonths = 182 * 24 * 3600 * 1000;
  if (Math.abs(now - ms) > sixMonths) return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)}  ${d.getUTCFullYear()}`;
  return `${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2)} ${hh}:${mm}`;
}

export function splitOutput(text) {
  if (text.endsWith('\n')) return { lines: text.slice(0, -1).split('\n'), trailing: true };
  return { lines: text ? text.split('\n') : [], trailing: false };
}

export function parseSize(s) {
  const m = String(s).match(/^([0-9]+)([KMGTPE]?)(B?)$/i);
  if (!m) return Number(s) || 0;
  const mult = { '': 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4, P: 1024 ** 5, E: 1024 ** 6 }[m[2].toUpperCase()] || 1;
  return Number(m[1]) * mult;
}

export function makeTempName(ctx, template = 'tmp.XXXXXX', dir = null) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const rand = (n) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  const base = dir || '/tmp';
  if (template.includes('XXXXXX')) return `${base}/${template.replace(/XXXXXX/, rand(6))}`;
  return `${base}/${template}${rand(6)}`;
}

export function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
