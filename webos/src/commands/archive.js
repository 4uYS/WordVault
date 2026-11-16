/* Encoding, checksum and archive utilities (pure browser JS). */

import { parseOpts, resolvePath, errnoText, humanSize, modeString, fmtDate } from './util.js';
import { md5, sha1, sha224, sha256, sha384, sha512, blake2b, hex } from '../lib/hash.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

function reg(ctx, name, summary, run) {
  ctx.kernel.registerCommand(name, { summary, run });
}

function reportErr(c, msg, code = 1) {
  c.err(msg + '\n');
  return code;
}

const toBytes = (d) => (typeof d === 'string' ? enc.encode(d) : d);
const concat = (chunks) => {
  let n = 0;
  for (const b of chunks) n += b.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const b of chunks) { out.set(b, off); off += b.length; }
  return out;
};
const outBytes = (c, bytes) => { c.stdout.write(bytes); };

function vfsRead(c, p) {
  return c.vfs.readFile(resolvePath(c, p), c.cred());
}

function vfsWrite(c, p, bytes, mode) {
  c.vfs.writeFile(resolvePath(c, p), bytes, c.cred(), { mode });
}

function readInput(c, name) {
  if (name === '-' || name == null) return null;
  try { return vfsRead(c, name); }
  catch (e) { throw new Error(`${name}: ${errnoText(e)}`); }
}

/* ------------------------------ base encodings ------------------------------ */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function b64encode(bytes, alphabet = B64) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i], b1 = i + 1 < bytes.length ? bytes[i + 1] : 0, b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += alphabet[b0 >> 2];
    out += alphabet[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < bytes.length ? alphabet[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < bytes.length ? alphabet[b2 & 63] : '=';
  }
  return out;
}

function b64decode(text, alphabet = B64) {
  const map = new Map([...alphabet].map((ch, i) => [ch, i]));
  const chars = [];
  for (const ch of text) {
    if (ch === '=') break;
    if (/\s/.test(ch)) continue;
    if (!map.has(ch)) throw new Error(`invalid base64 character: ${ch}`);
    chars.push(map.get(ch));
  }
  const out = [];
  let acc = 0, bits = 0;
  for (const v of chars) {
    acc = (acc << 6) | v; bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function b32encode(bytes) {
  let out = '';
  let acc = 0, bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >> bits) & 31]; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  while (out.length % 8) out += '=';
  return out;
}

function b32decode(text) {
  const chars = [];
  for (const ch of text.toUpperCase()) {
    if (ch === '=') break;
    if (/\s/.test(ch)) continue;
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error(`invalid base32 character: ${ch}`);
    chars.push(v);
  }
  const out = [];
  let acc = 0, bits = 0;
  for (const v of chars) {
    acc = (acc << 5) | v; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

function hexEncode(bytes, upper = true) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').replace(/[a-f]/g, (m) => (upper ? m.toUpperCase() : m));
}

function hexDecode(text) {
  const clean = text.replace(/\s+/g, '');
  if (clean.length % 2) throw new Error('invalid hex string (odd length)');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    const v = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(v)) throw new Error('invalid hex digit');
    out[i] = v;
  }
  return out;
}

function wrapText(text, width) {
  if (!width || width <= 0) return text;
  const lines = [];
  for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
  return lines.join('\n') + (lines.length ? '\n' : '');
}

async function encodeCli(c, kind, decode, pre) {
  const o = pre || parseOpts(c.args, 'diw:', {
    decode: 'd', ignoregarbage: 'i', wrap: 'w:',
  });
  const wantDecode = decode ?? !!o.d;
  const width = o.w != null ? Number(o.w) : 76;
  const files = o._.length ? o._ : [null];
  let exit = 0;
  for (const f of files) {
    let data;
    try {
      data = f == null ? await c.readBytes() : vfsRead(c, f);
      if (wantDecode) {
        let text = dec.decode(data);
        if (o.i) {
          const keep = kind === 'base64url' ? /[^A-Za-z0-9_-]/g : kind === 'base32' ? /[^A-Za-z2-7=]/gi : /[^0-9A-Fa-f]/g;
          text = text.replace(keep, '');
        }
        const out = kind === 'base64' ? b64decode(text) : kind === 'base64url' ? b64decode(text, B64URL)
          : kind === 'base32' ? b32decode(text) : hexDecode(text);
        outBytes(c, out);
      } else {
        const text = kind === 'base64' ? b64encode(data) : kind === 'base64url' ? b64encode(data, B64URL)
          : kind === 'base32' ? b32encode(data) : hexEncode(data);
        c.out(wrapText(text, width));
      }
    } catch (e) { exit = reportErr(c, `${c.name}: ${f || 'standard input'}: ${e.message}`); }
  }
  return exit;
}

/* ------------------------------- checksums ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function posixCksum(bytes) {
  let crc = 0;
  for (const b of bytes) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0;
  let len = bytes.length;
  while (len > 0) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ (len & 0xff)) & 0xff]) >>> 0;
    len = Math.floor(len / 256);
  }
  return (~crc) >>> 0;
}

const ALGOS = {
  md5: { fn: md5, bits: 128 }, sha1: { fn: sha1, bits: 160 }, sha224: { fn: sha224, bits: 224 },
  sha256: { fn: sha256, bits: 256 }, sha384: { fn: sha384, bits: 384 }, sha512: { fn: sha512, bits: 512 },
  blake2b: { fn: (b) => blake2b(b, 64), bits: 512 },
};

async function hashCli(c, algo, fn) {
  const o = parseOpts(c.args, 'bctqsw', { check: 'c', binary: 'b', text: 't', quiet: 'q', status: 's', warn: 'w' });
  const check = !!o.c;
  const files = o._.length ? o._ : [null];
  let exit = 0;
  if (!check) {
    for (const f of files) {
      let data;
      try { data = f == null ? await c.readBytes() : vfsRead(c, f); }
      catch (e) { exit = reportErr(c, `${c.name}: ${f}: ${errnoText(e)}`); continue; }
      c.out(`${hex(fn(data))} ${o.b ? '*' : ' '}${f == null ? '-' : f}\n`);
    }
    return exit;
  }
  let bad = 0, checked = 0, failedOpen = 0;
  for (const f of files) {
    let text;
    try { text = f == null ? dec.decode(await c.readBytes()) : dec.decode(vfsRead(c, f)); }
    catch (e) { exit = reportErr(c, `${c.name}: ${f}: ${errnoText(e)}`); failedOpen++; continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      const m = line.match(/^([0-9a-fA-F]+)\s+[* ]?(.+)$/);
      if (!m) continue;
      checked++;
      let data;
      try { data = vfsRead(c, m[2]); }
      catch { failedOpen++; if (!o.status) c.out(`${m[2]}: FAILED open or read\n`); continue; }
      const ok = hex(fn(data)).toLowerCase() === m[1].toLowerCase();
      if (ok) { if (!o.status && !o.q) c.out(`${m[2]}: OK\n`); }
      else { bad++; if (!o.status) c.out(`${m[2]}: FAILED\n`); }
    }
  }
  if (!o.status) {
    if (bad) c.err(`${c.name}: WARNING: ${bad} computed checksum${bad > 1 ? 's' : ''} did NOT match\n`);
    if (failedOpen) c.err(`${c.name}: WARNING: ${failedOpen} listed file${failedOpen > 1 ? 's' : ''} could not be read\n`);
  }
  return bad || failedOpen ? 1 : 0;
}

/* --------------------------- compression helpers --------------------------- */

function streamAvailable() {
  return typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
}

async function transformBytes(bytes, mode, format) {
  if (!streamAvailable()) throw new Error('CompressionStream unavailable in this engine');
  const Ctor = mode === 'compress' ? CompressionStream : DecompressionStream;
  let stream;
  try { stream = new Ctor(format); } catch { throw new Error(`compression format '${format}' is not supported by this engine`); }
  const reader = stream.readable.getReader();
  const readAll = (async () => {
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    return concat(chunks);
  })();
  const writer = stream.writable.getWriter();
  const writeAll = (async () => {
    await writer.write(bytes);
    await writer.close();
  })();
  const [out] = await Promise.all([readAll, writeAll]);
  return out;
}

async function compressCli(c, format, suffix, forceDecompress) {
  const args = c.args.filter((a) => !/^-[1-9]$/.test(a));
  const o = parseOpts(args, 'dcfktv', {
    decompress: 'd', uncompress: 'd', stdout: 'c', tostdout: 'c', force: 'f', keep: 'k', test: 't', verbose: 'v',
  });
  const decompress = !!(o.d || forceDecompress);
  const cmd = c.name;
  if (!streamAvailable()) return reportErr(c, `${cmd}: CompressionStream unavailable in this engine`, 1);
  let exit = 0;

  if (!o._.length) {
    const data = await c.readBytes();
    try {
      if (o.t) { await transformBytes(data, 'decompress', format); return 0; }
      outBytes(c, await transformBytes(data, decompress ? 'decompress' : 'compress', format));
      return 0;
    } catch (e) { return reportErr(c, `${cmd}: ${e.message}`); }
  }

  for (const arg of o._) {
    const p = resolvePath(c, arg);
    let st;
    try { st = c.vfs.stat(p, c.cred(), { followFinal: false }); }
    catch (e) { exit = reportErr(c, `${cmd}: ${arg}: ${errnoText(e)}`); continue; }
    if (!st.isFile()) { exit = reportErr(c, `${cmd}: ${arg} is not a regular file`); continue; }
    const data = c.vfs.readFile(p, c.cred());
    if (o.t) {
      try { await transformBytes(data, 'decompress', format); if (o.v) c.err(`${arg}: OK\n`); }
      catch { exit = reportErr(c, `${cmd}: ${arg}: not in ${format} format`); }
      continue;
    }
    if (!decompress) {
      if (arg.endsWith(suffix) && !o.f) { exit = reportErr(c, `${cmd}: ${arg} already has ${suffix} suffix -- unchanged`); continue; }
      let out;
      try { out = await transformBytes(data, 'compress', format); }
      catch (e) { exit = reportErr(c, `${cmd}: ${arg}: ${e.message}`); continue; }
      if (o.c) { outBytes(c, out); continue; }
      const dest = p + suffix;
      try {
        vfsWrite(c, dest, out, st.mode & 0o777);
        c.vfs.chmod(dest, st.mode & 0o777, c.cred());
        c.vfs.utimes(dest, st.atimeMs, st.mtimeMs, c.cred());
        if (!o.k) c.vfs.unlink(p, c.cred());
      } catch (e) { exit = reportErr(c, `${cmd}: ${arg}: ${errnoText(e)}`); continue; }
    } else {
      let destName;
      if (arg.endsWith(suffix)) destName = p.slice(0, -suffix.length);
      else if (o.c) destName = null;
      else { exit = reportErr(c, `${cmd}: ${arg}: unknown suffix -- ignored`); continue; }
      let out;
      try { out = await transformBytes(data, 'decompress', format); }
      catch { exit = reportErr(c, `${cmd}: ${arg}: not in ${format} format`); continue; }
      if (o.c || !destName) { outBytes(c, out); continue; }
      try {
        vfsWrite(c, destName, out, st.mode & 0o777);
        c.vfs.chmod(destName, st.mode & 0o777, c.cred());
        c.vfs.utimes(destName, st.atimeMs, st.mtimeMs, c.cred());
        if (!o.k) c.vfs.unlink(p, c.cred());
      } catch (e) { exit = reportErr(c, `${cmd}: ${arg}: ${errnoText(e)}`); continue; }
    }
  }
  return exit;
}

/* --------------------------------- tar --------------------------------- */

function pad512(n) { return Math.ceil(n / 512) * 512; }

function octalField(h, off, len, value) {
  const s = Math.max(0, value | 0).toString(8).padStart(len - 1, '0').slice(-(len - 1));
  h.set(enc.encode(s), off);
  h[off + len - 1] = 0;
}

function putStr(h, off, len, str) {
  const b = enc.encode(str || '');
  h.set(b.subarray(0, len), off);
}

function cstr(bytes, off, len) {
  let end = off;
  while (end < off + len && bytes[end] !== 0) end++;
  return dec.decode(bytes.subarray(off, end));
}

function tarNum(bytes, off, len) {
  const s = cstr(bytes, off, len).trim();
  if (!s) return 0;
  if (bytes[off] & 0x80) {
    let v = 0;
    for (let i = off + 1; i < off + len; i++) v = v * 256 + bytes[i];
    return v;
  }
  return parseInt(s, 8) || 0;
}

function tarHeader(e) {
  const h = new Uint8Array(512);
  let name = e.name || '';
  let prefix = '';
  if (enc.encode(name).length > 100) {
    for (let i = name.length - 1; i > 0; i--) {
      if (name[i] !== '/') continue;
      const pre = name.slice(0, i), suf = name.slice(i + 1);
      if (enc.encode(pre).length <= 155 && enc.encode(suf).length <= 100) { prefix = pre; name = suf; break; }
    }
  }
  putStr(h, 0, 100, name);
  octalField(h, 100, 8, e.mode ?? 0o644);
  octalField(h, 108, 8, e.uid ?? 0);
  octalField(h, 116, 8, e.gid ?? 0);
  octalField(h, 124, 12, e.size || 0);
  octalField(h, 136, 12, Math.floor((e.mtime ?? Date.now()) / 1000));
  h[156] = (e.type || '0').charCodeAt(0);
  putStr(h, 157, 100, e.linkname || '');
  putStr(h, 257, 8, 'ustar\x0000');
  putStr(h, 265, 32, e.uname || 'root');
  putStr(h, 297, 32, e.gname || 'root');
  putStr(h, 345, 155, prefix);
  for (let i = 148; i < 156; i++) h[i] = 32;
  let sum = 0;
  for (const b of h) sum += b;
  putStr(h, 148, 8, sum.toString(8).padStart(6, '0') + '\0 ');
  return h;
}

function wildcardToRegex(pat) {
  let out = '';
  for (const ch of pat) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else if ('\\^$.|+()[]{}'.includes(ch)) out += '\\' + ch;
    else out += ch;
  }
  return new RegExp('^' + out + '$');
}

function entryNameFor(c, arg, abs) {
  const cwd = c.cwd === '/' ? '/' : c.cwd.replace(/\/+$/, '');
  if (arg === '.') return '.';
  if (arg === './') return '.';
  let rel;
  if (abs === cwd) rel = abs.slice(abs.lastIndexOf('/') + 1) || '.';
  else if (cwd === '/' && abs.startsWith('/')) rel = abs.slice(1);
  else if (abs.startsWith(cwd + '/')) rel = abs.slice(cwd.length + 1);
  else rel = abs.replace(/^\/+/, '');
  return rel.replace(/^\.\//, '') || '.';
}

function collectEntries(c, operands, excludes) {
  const list = [];
  const seen = new Set();
  // Honor the command context's cwd (including tar's -C) rather than the
  // shell's live cwd, which cred() would otherwise use.
  const ctxCred = () => ({ ...c.cred(), cwd: c.cwd });
  const rx = excludes.map(wildcardToRegex);
  const excluded = (name) => rx.some((r) => r.test(name) || r.test(name.replace(/\/$/, '')));
  const add = (abs, name) => {
    if (excluded(name) || seen.has(name)) return;
    seen.add(name);
    let st;
    try { st = c.vfs.stat(abs, ctxCred(), { followFinal: false }); } catch { return; }
    const base = {
      name, mode: st.mode & 0o7777, uid: st.uid, gid: st.gid,
      mtime: st.mtimeMs, uname: c.kernel.userByUid(st.uid)?.name || 'root',
      gname: c.kernel.groupByGid(st.gid)?.name || 'root',
    };
    if (st.isDirectory()) {
      if (name !== '.') list.push({ ...base, name: name.replace(/\/+$/, '') + '/', type: '5', size: 0 });
      const kids = [...c.vfs.readdirNodes(abs, ctxCred())].sort((a, b) => a[0].localeCompare(b[0]));
      for (const [n] of kids) {
        if (n === '.' || n === '..') continue;
        const childAbs = abs === '/' ? '/' + n : abs + '/' + n;
        add(childAbs, name === '.' ? './' + n : name.replace(/\/+$/, '') + '/' + n);
      }
    } else if (st.isSymbolicLink()) {
      list.push({ ...base, type: '2', size: 0, linkname: c.vfs.readlink(abs, ctxCred()) });
    } else if (st.isFile()) {
      list.push({ ...base, type: '0', size: st.size, data: c.vfs.readFile(abs, ctxCred()) });
    }
  };
  for (const op of operands) {
    const abs = resolvePath(c, op);
    add(abs, entryNameFor(c, op, abs));
  }
  return list;
}

function parseTar(bytes) {
  const entries = [];
  let off = 0, longName = null, longLink = null;
  while (off + 512 <= bytes.length) {
    const h = bytes.subarray(off, off + 512);
    let allZero = true;
    for (const b of h) if (b !== 0) { allZero = false; break; }
    if (allZero) break;
    const name0 = cstr(h, 0, 100);
    const prefix = cstr(h, 345, 155);
    let name = prefix ? prefix + '/' + name0 : name0;
    const type = String.fromCharCode(h[156] || 48);
    const size = tarNum(h, 124, 12);
    const linkname = cstr(h, 157, 100);
    const mode = tarNum(h, 100, 8), uid = tarNum(h, 108, 8), gid = tarNum(h, 116, 8);
    const mtime = tarNum(h, 136, 12) * 1000;
    const dataOff = off + 512;
    const data = bytes.subarray(dataOff, Math.min(bytes.length, dataOff + size));
    off = dataOff + pad512(size);
    if (type === 'L') { longName = dec.decode(data).replace(/\0[\s\S]*$/, ''); continue; }
    if (type === 'K') { longLink = dec.decode(data).replace(/\0[\s\S]*$/, ''); continue; }
    if (longName) { name = longName; longName = null; }
    let link = linkname;
    if (longLink) { link = longLink; longLink = null; }
    entries.push({ name, type, size, mode, uid, gid, mtime, linkname: link, data });
  }
  return entries;
}

function pathParts(name) {
  return name.replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
}

function safeJoin(root, parts) {
  return (root === '/' ? '' : root.replace(/\/+$/, '')) + '/' + parts.join('/');
}

/* --------------------------------- zip --------------------------------- */

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
    date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

const LE16 = (v) => [v & 0xff, (v >>> 8) & 0xff];
const LE32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

function zipEntryBytes(e, offset) {
  const nameBytes = enc.encode(e.name);
  const dt = dosDateTime(e.mtime);
  const crc = crc32(e.data);
  const local = [
    ...LE32(0x04034b50), ...LE16(20), ...LE16(0), ...LE16(0), ...LE16(dt.time), ...LE16(dt.date),
    ...LE32(crc), ...LE32(e.data.length), ...LE32(e.data.length), ...LE16(nameBytes.length), ...LE16(0),
  ];
  return { local: concat([new Uint8Array(local), nameBytes, e.data]), crc, dt, nameBytes, offset };
}

function zipCentral(dir, offset) {
  const h = [
    ...LE32(0x02014b50), ...LE16(20), ...LE16(20), ...LE16(0), ...LE16(0), ...LE16(dir.dt.time), ...LE16(dir.dt.date),
    ...LE32(dir.crc), ...LE32(dir.data.length), ...LE32(dir.data.length), ...LE16(dir.nameBytes.length),
    ...LE16(0), ...LE16(0), ...LE16(0), ...LE16(0), ...LE32(0), ...LE32(offset),
  ];
  return concat([new Uint8Array(h), dir.nameBytes]);
}

function parseZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65558); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end-of-central-directory record)');
  const count = view.getUint16(eocd + 10, true);
  let off = view.getUint32(eocd + 16, true);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > bytes.length || view.getUint32(off, true) !== 0x02014b50) throw new Error('corrupt central directory');
    const flags = view.getUint16(off + 8, true);
    const method = view.getUint16(off + 10, true);
    const crc = view.getUint32(off + 16, true);
    const csize = view.getUint32(off + 20, true);
    const usize = view.getUint32(off + 24, true);
    const nlen = view.getUint16(off + 28, true), elen = view.getUint16(off + 30, true), clen = view.getUint16(off + 32, true);
    const lho = view.getUint32(off + 42, true);
    const dtime = view.getUint16(off + 12, true), ddate = view.getUint16(off + 14, true);
    const name = dec.decode(bytes.subarray(off + 46, off + 46 + nlen));
    entries.push({
      name, flags, method, crc, csize, usize, lho,
      mtime: Date.UTC(1980 + ((ddate >> 9) & 0x7f), ((ddate >> 5) & 0x0f) - 1, ddate & 0x1f,
        (dtime >> 11) & 0x1f, (dtime >> 5) & 0x3f, (dtime & 0x1f) * 2),
    });
    off += 46 + nlen + elen + clen;
  }
  return entries;
}

async function extractZipEntry(bytes, e) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(e.lho, true) !== 0x04034b50) throw new Error(`bad local header for ${e.name}`);
  const nlen = view.getUint16(e.lho + 26, true), elen = view.getUint16(e.lho + 28, true);
  const start = e.lho + 30 + nlen + elen;
  const comp = bytes.subarray(start, start + e.csize);
  if (e.method === 0) return comp;
  if (e.method === 8) {
    if (typeof DecompressionStream !== 'function') throw new Error('DEFLATE unsupported: DecompressionStream unavailable');
    return transformBytes(comp, 'decompress', 'deflate-raw');
  }
  throw new Error(`unsupported compression method ${e.method}`);
}

/* --------------------------------- cpio --------------------------------- */

const CPIO_HDR = '070701';

function cpioHeader(e) {
  const name = e.name + '\0';
  const fields = [e.ino & 0xffffffff, e.mode, e.uid, e.gid, e.nlink || 1, Math.floor((e.mtime ?? Date.now()) / 1000),
    e.data ? e.data.length : 0, 0, 0, 0, 0, name.length, 0];
  const head = CPIO_HDR + fields.map((v) => (v >>> 0).toString(16).padStart(8, '0')).join('');
  const nameBytes = enc.encode(name);
  const padName = (4 - (nameBytes.length % 4)) % 4;
  return { bytes: concat([enc.encode(head), nameBytes, new Uint8Array(padName)]), nameLen: nameBytes.length };
}

function parseCpio(bytes) {
  const entries = [];
  let off = 0;
  while (off + 110 <= bytes.length) {
    const magic = dec.decode(bytes.subarray(off, off + 6));
    if (magic !== CPIO_HDR) {
      if (magic.startsWith('07070')) throw new Error('unsupported cpio format (only newc is supported)');
      break;
    }
    const f = [];
    for (let i = 0; i < 13; i++) f.push(parseInt(dec.decode(bytes.subarray(off + 6 + i * 8, off + 14 + i * 8)), 16) || 0);
    const [ino, mode, uid, gid, nlink, mtime, size, , , , , namesize] = f;
    const nameStart = off + 110;
    let name = dec.decode(bytes.subarray(nameStart, nameStart + namesize)).replace(/\0.*$/, '');
    const dataStart = nameStart + namesize;
    const data = bytes.subarray(dataStart, dataStart + size);
    entries.push({ name, mode, uid, gid, nlink, mtime: mtime * 1000, size, data });
    off = dataStart + ((size + 3) & ~3);
    if (name === 'TRAILER!!!') break;
  }
  return entries;
}

/* --------------------------------- ar --------------------------------- */

function arHeader(name, st, size) {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  return enc.encode(
    `${pad(name.endsWith('/') ? name : name + '/', 16)}${pad(Math.floor((st.mtimeMs || Date.now()) / 1000), 12)}` +
    `${pad(st.uid ?? 0, 6)}${pad(st.gid ?? 0, 6)}${pad((st.mode & 0o7777).toString(8), 8)}${pad(size, 10)}\`\n`,
  );
}

function parseAr(bytes) {
  if (dec.decode(bytes.subarray(0, 8)) !== '!<arch>\n') throw new Error('not an ar archive');
  const entries = [];
  let off = 8;
  while (off + 60 <= bytes.length) {
    const h = dec.decode(bytes.subarray(off, off + 60));
    const name = h.slice(0, 16).trim().replace(/\/$/, '');
    const size = parseInt(h.slice(48, 58).trim(), 10) || 0;
    const data = bytes.subarray(off + 60, off + 60 + size);
    entries.push({ name, size, data });
    off += 60 + size + (size % 2);
  }
  return entries;
}

/* ------------------------------ registration ------------------------------ */

export function registerArchiveCommands(kernel) {
  const ctx = { kernel };

  /* encodings */
  reg(ctx, 'base64', 'base64 encode/decode data', async (c) => encodeCli(c, 'base64'));
  reg(ctx, 'base32', 'base32 encode/decode data', async (c) => encodeCli(c, 'base32'));
  reg(ctx, 'basenc', 'encode/decode data using a selected base', async (c) => {
    const o = parseOpts(c.args, 'diw:', {
      base64: 'b64', 'base64url': 'b64url', base32: 'b32', base32hex: 'b32', base16: 'b16', hex: 'b16',
      decode: 'd', ignoregarbage: 'i', wrap: 'w:',
    });
    const kind = o.b64url ? 'base64url' : o.b32 ? 'base32' : o.b16 ? 'base16' : 'base64';
    return encodeCli(c, kind, !!o.d, o);
  });

  /* checksums */
  for (const [name, algo] of [['md5sum', 'md5'], ['sha1sum', 'sha1'], ['sha224sum', 'sha224'],
    ['sha256sum', 'sha256'], ['sha384sum', 'sha384'], ['sha512sum', 'sha512'], ['b2sum', 'blake2b']]) {
    const { fn, bits } = ALGOS[algo];
    reg(ctx, name, `compute and check ${algo.toUpperCase()} message digest`, (c) => {
      if (algo === 'blake2b') {
        const raw = c.args.slice();
        const args = [];
        let bits = 512;
        for (let i = 0; i < raw.length; i++) {
          const a = raw[i];
          let val;
          if (a === '-l' || a === '--length') val = raw[++i];
          else if (a.startsWith('--length=')) val = a.slice(9);
          else if (a.startsWith('-l') && a.length > 2) val = a.slice(2);
          if (val === undefined) { args.push(a); continue; }
          bits = Number(val);
          if (!(bits >= 8 && bits <= 512 && bits % 8 === 0)) return reportErr(c, 'b2sum: invalid length (must be 8..512, multiple of 8)');
        }
        return hashCli({ ...c, args }, algo, (b) => blake2b(b, bits / 8));
      }
      return hashCli(c, algo, fn);
    });
  }

  reg(ctx, 'cksum', 'checksum and count the bytes in a file', async (c) => {
    const o = parseOpts(c.args, '', { algorithm: 'a:' });
    const alg = o.a || 'crc32';
    const files = o._.length ? o._ : [null];
    let exit = 0;
    for (const f of files) {
      let data;
      try { data = f == null ? await c.readBytes() : vfsRead(c, f); }
      catch (e) { exit = reportErr(c, `cksum: ${f}: ${errnoText(e)}`); continue; }
      const label = f == null ? '-' : f;
      if (alg === 'crc32') c.out(`${posixCksum(data)} ${data.length} ${label}\n`);
      else if (ALGOS[alg]) c.out(`${alg.toUpperCase()} (${label}) = ${hex(ALGOS[alg].fn(data))}\n`);
      else { exit = reportErr(c, `cksum: invalid algorithm '${alg}'`); break; }
    }
    return exit;
  });

  reg(ctx, 'sum', 'checksum and count the blocks in a file', async (c) => {
    const o = parseOpts(c.args, 'rs', { sysv: 's', bsd: 'r' });
    const sysv = !!o.s;
    const files = o._.length ? o._ : [null];
    let exit = 0;
    for (const f of files) {
      let data;
      try { data = f == null ? await c.readBytes() : vfsRead(c, f); }
      catch (e) { exit = reportErr(c, `sum: ${f}: ${errnoText(e)}`); continue; }
      let checksum;
      if (sysv) {
        let s = 0;
        for (const b of data) s += b;
        s = (s & 0xffff) + (s >>> 16);
        s = (s & 0xffff) + (s >>> 16);
        checksum = (~s) & 0xffff;
        c.out(`${String(checksum).padStart(5)} ${String(Math.ceil(data.length / 512)).padStart(6)}${f ? ' ' + f : ''}\n`);
      } else {
        let s = 0;
        for (const b of data) {
          s = ((s >>> 1) | ((s & 1) << 15)) + b;
          s &= 0xffff;
        }
        checksum = s;
        c.out(`${String(checksum).padStart(5)} ${String(Math.ceil(data.length / 1024)).padStart(6)}${f ? ' ' + f : ''}\n`);
      }
    }
    return exit;
  });

  /* compression */
  reg(ctx, 'gzip', 'compress or expand files (gzip)', (c) => compressCli(c, 'gzip', '.gz', false));
  reg(ctx, 'gunzip', 'decompress gzip files', (c) => compressCli(c, 'gzip', '.gz', true));
  reg(ctx, 'zcat', 'view gzip-compressed files', async (c) => {
    const o = parseOpts(c.args, 'f', { force: 'f' });
    let exit = 0;
    if (!o._.length) {
      try { outBytes(c, await transformBytes(await c.readBytes(), 'decompress', 'gzip')); }
      catch (e) { exit = reportErr(c, `zcat: ${e.message}`); }
      return exit;
    }
    for (const f of o._) {
      try { outBytes(c, await transformBytes(vfsRead(c, f), 'decompress', 'gzip')); }
      catch (e) { exit = reportErr(c, `zcat: ${f}: ${errnoText(e) === 'ENOENT' ? 'No such file or directory' : e.message}`); }
    }
    return exit;
  });
  reg(ctx, 'compress', 'compress files using zlib (LZW compatible not available)', async (c) => {
    const o = parseOpts(c.args, 'dcfkv', { decompress: 'd', stdout: 'c', force: 'f', keep: 'k', verbose: 'v' });
    if (o.d) { c.err('compress: .Z (LZW) decompression is not available in the browser; use gzip instead\n'); return 1; }
    return compressCli(c, 'deflate', '.Z', false);
  });
  reg(ctx, 'uncompress', 'decompress zlib (.Z) files', async (c) => {
    const o = parseOpts(c.args, 'dcfkv', { decompress: 'd', stdout: 'c', force: 'f', keep: 'k', verbose: 'v' });
    return compressCli(c, 'deflate', '.Z', true);
  });

  for (const [name, format] of [['zstd', 'zstd'], ['lz4', 'lz4'], ['xz', 'xz'], ['unxz', 'xz'],
    ['bzip2', 'bzip2'], ['bunzip2', 'bzip2']]) {
    reg(ctx, name, `${format} compression`, async (c) => {
      const decompress = name.startsWith('un') || name === 'bunzip2';
      c.err(`${name}: ${format} ${decompress ? 'decompression' : 'compression'} is not supported in the browser sandbox (no ${format} codec is available)\n`);
      c.err(`${name}: use gzip/gunzip or xz/bzip2 on a real Linux system instead\n`);
      return 1;
    });
  }

  /* tar */
  reg(ctx, 'tar', 'manipulate tape archives (ustar)', async (c) => {
    const o = parseOpts(c.args, 'cxtf:zjJvC:p', {
      create: 'c', extract: 'x', get: 'x', list: 't', file: 'f:', gzip: 'z', unzip: 'z',
      bzip2: 'j', xz: 'J', verbose: 'v', directory: 'C:', exclude: 'exclude:', 'strip-components': 'strip:',
      preserve: 'p',
    });
    const verbose = !!o.v;
    const mode = o.c ? 'create' : o.x ? 'extract' : o.t ? 'list' : null;
    if (!mode) return reportErr(c, 'tar: You must specify one of the -c, -x or -t options', 2);
    const archive = o.f || '-';
    const compression = o.z ? 'gzip' : o.j ? 'bzip2' : o.J ? 'xz' : null;
    if (mode === 'create' && (o.j || o.J)) {
      return reportErr(c, `tar: ${compression} compression is not supported in the browser sandbox`, 2);
    }
    if (mode === 'create') {
      const excludes = o.exclude == null ? [] : Array.isArray(o.exclude) ? o.exclude : [o.exclude];
      const operands = o._.length ? o._ : ['.'];
      const addCtx = o.C ? { ...c, cwd: resolvePath(c, o.C) } : c;
      let entries;
      try { entries = collectEntries(addCtx, operands, excludes); }
      catch (e) { return reportErr(c, `tar: ${errnoText(e)}`, 2); }
      const chunks = [];
      for (const e of entries) {
        const name = e.name;
        if (verbose) c.out(`${name}\n`);
        chunks.push(tarHeader({ ...e, name }));
        if (e.type === '0' && e.data) {
          chunks.push(e.data);
          const pad = pad512(e.data.length) - e.data.length;
          if (pad) chunks.push(new Uint8Array(pad));
        }
      }
      chunks.push(new Uint8Array(1024));
      let bytes = concat(chunks);
      if (compression === 'gzip') {
        try { bytes = await transformBytes(bytes, 'compress', 'gzip'); }
        catch (e) { return reportErr(c, `tar: ${e.message}`, 2); }
      }
      if (archive === '-') outBytes(c, bytes);
      else {
        try { vfsWrite(c, archive, bytes, 0o644); }
        catch (e) { return reportErr(c, `tar: ${archive}: ${errnoText(e)}`, 2); }
      }
      return 0;
    }

    let bytes;
    try { bytes = archive === '-' ? await c.readBytes() : vfsRead(c, archive); }
    catch (e) { return reportErr(c, `tar: ${archive}: ${errnoText(e)}`, 2); }
    const gzipped = bytes[0] === 0x1f && bytes[1] === 0x8b;
    if (o.z || gzipped) {
      try { bytes = await transformBytes(bytes, 'decompress', 'gzip'); }
      catch (e) { return reportErr(c, `tar: ${archive}: ${e.message}`, 2); }
    } else if (bytes[0] === 0x42 && bytes[1] === 0x5a) {
      return reportErr(c, 'tar: bzip2 archives are not supported in the browser sandbox', 2);
    }
    const entries = parseTar(bytes);

    if (mode === 'list') {
      for (const e of entries) {
        if (!verbose) { c.out(`${e.name}\n`); continue; }
        const owner = kernel.userByUid(e.uid)?.name || String(e.uid);
        const group = kernel.groupByGid(e.gid)?.name || String(e.gid);
        c.out(`${modeString((e.type === '5' ? 0o040000 : e.type === '2' ? 0o120000 : 0o100000) | (e.mode & 0o7777))} ${owner}/${group} ${String(e.size).padStart(8)} ${fmtDate(e.mtime)} ${e.name}${e.type === '2' ? ' -> ' + e.linkname : ''}\n`);
      }
      return 0;
    }

    const destRoot = resolvePath(c, o.C || '.');
    if (o.C) { try { c.vfs.mkdirp(destRoot, c.cred()); } catch { /* ignore */ } }
    const strip = Math.max(0, Number(o.strip ?? 0) || 0);
    const dirs = [];
    let exit = 0;
    for (const e of entries) {
      let parts = pathParts(e.name);
      if (!parts.length) continue;
      if (parts.includes('..')) { exit = reportErr(c, `tar: ${e.name}: path traversal is not allowed`, 2); continue; }
      if (strip) {
        if (parts.length <= strip) continue;
        parts = parts.slice(strip);
      }
      const target = safeJoin(destRoot, parts);
      const isDir = e.type === '5' || e.name.endsWith('/');
      try {
        if (isDir) {
          c.vfs.mkdirp(target, c.cred(), e.mode & 0o7777 || 0o755);
          dirs.push({ path: target, mtime: e.mtime, mode: e.mode });
        } else if (e.type === '2') {
          const parent = target.slice(0, target.lastIndexOf('/')) || '/';
          c.vfs.mkdirp(parent, c.cred());
          try { c.vfs.unlink(target, c.cred()); } catch { /* ignore */ }
          c.vfs.symlink(e.linkname, target, c.cred());
        } else if (e.type === '1') {
          const linkParts = pathParts(e.linkname);
          const linkTarget = safeJoin(destRoot, strip ? linkParts.slice(strip) : linkParts);
          try { c.vfs.unlink(target, c.cred()); } catch { /* ignore */ }
          c.vfs.link(linkTarget, target, c.cred());
        } else {
          const parent = target.slice(0, target.lastIndexOf('/')) || '/';
          c.vfs.mkdirp(parent, c.cred());
          vfsWrite(c, target, e.data, e.mode & 0o7777 || 0o644);
          try { c.vfs.chmod(target, e.mode & 0o7777 || 0o644, c.cred()); } catch { /* ignore */ }
          try { c.vfs.utimes(target, e.mtime, e.mtime, c.cred()); } catch { /* ignore */ }
          try { if (e.uid != null && c.uid === 0) c.vfs.chown(target, e.uid, e.gid, c.cred()); } catch { /* ignore */ }
          if (verbose) c.out(`${e.name}\n`);
        }
      } catch (err) { exit = reportErr(c, `tar: ${e.name}: ${errnoText(err)}`, 2); }
    }
    for (const d of dirs.reverse()) {
      try { c.vfs.chmod(d.path, (d.mode & 0o7777) || 0o755, c.cred()); } catch { /* ignore */ }
      try { c.vfs.utimes(d.path, d.mtime, d.mtime, c.cred()); } catch { /* ignore */ }
    }
    return exit;
  });

  /* zip / unzip */
  reg(ctx, 'zip', 'package and compress (store) files into a zip archive', async (c) => {
    const args = c.args.filter((a) => !/^-[0-9]$/.test(a));
    const o = parseOpts(args, 'rqj', { recursive: 'r', quiet: 'q', junkpaths: 'j' });
    if (o._.length < 1) return reportErr(c, 'zip: missing archive name', 2);
    const archive = o._.shift();
    if (!o._.length) return reportErr(c, 'zip: nothing to do (no input files)', 2);
    for (const op of o._) {
      let st;
      try { st = c.vfs.stat(resolvePath(c, op), c.cred(), { followFinal: false }); }
      catch (e) { return reportErr(c, `zip: ${op}: ${errnoText(e)}`, 2); }
      if (st.isDirectory() && !o.r) return reportErr(c, `zip: ${op} is a directory (use -r)`, 2);
    }
    const entries = collectEntries(c, o._, []);
    const files = [];
    for (const e of entries) {
      if (e.type === '5') { files.push({ ...e, data: new Uint8Array(0) }); continue; }
      if (e.type === '2') { c.err(`zip: warning: skipped symlink ${e.name}\n`); continue; }
      files.push(e);
    }
    const chunks = [];
    const central = [];
    let offset = 0;
    for (const e of files) {
      const z = zipEntryBytes({ ...e, data: e.data || new Uint8Array(0) }, offset);
      chunks.push(z.local);
      central.push(zipCentral({ ...z, name: e.name, data: e.data || new Uint8Array(0) }, offset));
      offset += z.local.length;
      if (!o.q) c.out(`  adding: ${e.name.replace(/\/+$/, '')}${e.type === '5' ? '/' : ''} (stored)\n`);
    }
    const centralBytes = concat(central);
    const eocd = new Uint8Array([
      ...LE32(0x06054b50), ...LE16(0), ...LE16(0), ...LE16(files.length), ...LE16(files.length),
      ...LE32(centralBytes.length), ...LE32(offset), ...LE16(0),
    ]);
    try { vfsWrite(c, archive, concat([...chunks, centralBytes, eocd]), 0o644); }
    catch (e) { return reportErr(c, `zip: ${archive}: ${errnoText(e)}`, 2); }
    return 0;
  });

  reg(ctx, 'unzip', 'list, test and extract zip archives', async (c) => {
    const o = parseOpts(c.args, 'lotpqd:', {
      list: 'l', overwrite: 'o', test: 't', quiet: 'q', pipe: 'p', directory: 'd:',
    });
    const archive = o._[0];
    if (!archive) return reportErr(c, 'unzip: missing archive name', 2);
    let bytes;
    try { bytes = vfsRead(c, archive); }
    catch (e) { return reportErr(c, `unzip: ${archive}: ${errnoText(e)}`, 9); }
    let entries;
    try { entries = parseZip(bytes); }
    catch (e) { return reportErr(c, `unzip: ${archive}: ${e.message}`, 9); }
    const pattern = o._[1];
    if (pattern) entries = entries.filter((e) => wildcardToRegex(pattern).test(e.name));
    if (!o.q && !o.p) {
      c.out(`Archive:  ${archive}\n`);
      if (o.l) c.out('  Length      Date    Time    Name\n---------  ---------- -----   ----\n');
    }
    if (o.l) {
      let total = 0;
      for (const e of entries) {
        const d = new Date(e.mtime || 0);
        const dt = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
        c.out(`${String(e.usize).padStart(9)}  ${dt}   ${e.name}\n`);
        total += e.usize;
      }
      c.out(`---------                     -------\n${String(total).padStart(9)}                     ${entries.length} files\n`);
      return 0;
    }
    const destRoot = resolvePath(c, o.d || '.');
    if (o.d) { try { c.vfs.mkdirp(destRoot, c.cred()); } catch { /* ignore */ } }
    let exit = 0;
    for (const e of entries) {
      let data;
      try { data = await extractZipEntry(bytes, e); }
      catch (err) { exit = reportErr(c, `unzip: ${e.name}: ${err.message}`, 9); continue; }
      if (crc32(data) !== e.crc) { exit = reportErr(c, `unzip: ${e.name}: bad CRC`, 9); continue; }
      if (o.t) { if (!o.q) c.out(`testing: ${e.name}   OK\n`); continue; }
      const parts = pathParts(e.name);
      if (!parts.length) continue;
      if (parts.includes('..')) { exit = reportErr(c, `unzip: ${e.name}: path traversal is not allowed`, 9); continue; }
      const target = safeJoin(destRoot, parts);
      if (e.name.endsWith('/')) {
        try { c.vfs.mkdirp(target, c.cred()); } catch (err) { exit = reportErr(c, `unzip: ${e.name}: ${errnoText(err)}`, 9); }
        continue;
      }
      if (o.p) { outBytes(c, data); continue; }
      if (!o.o && c.vfs.exists(target, c.cred())) {
        c.err(`replace ${e.name}? [y]es, [n]o, [A]ll, [N]one, [r]ename: unzip: cannot prompt in a non-interactive session; skipping ${e.name}\n`);
        exit = 1;
        continue;
      }
      try {
        const parent = target.slice(0, target.lastIndexOf('/')) || '/';
        c.vfs.mkdirp(parent, c.cred());
        vfsWrite(c, target, data, 0o644);
        if (!o.q) c.out(`  inflating: ${e.name}\n`);
      } catch (err) { exit = reportErr(c, `unzip: ${e.name}: ${errnoText(err)}`, 9); }
    }
    return exit;
  });

  /* cpio */
  reg(ctx, 'cpio', 'copy files to and from archives (newc)', async (c) => {
    const o = parseOpts(c.args, 'oitvdF:', { create: 'o', extract: 'i', list: 't', verbose: 'v', directory: 'd', file: 'F:' });
    const verbose = !!o.v;
    if (o.o) {
      let files = o._.slice();
      if (!files.length) files = dec.decode(await c.readBytes()).split('\n').map((s) => s.trim()).filter(Boolean);
      if (!files.length) return reportErr(c, 'cpio: no input files specified (give operands or a file list on stdin)', 2);
      const entries = collectEntries(c, files, []).filter((e) => e.type !== '5' || e.name !== '.');
      const chunks = [];
      let ino = 1;
      for (const e of entries) {
        const hm = cpioHeader({
          ...e, ino: ino++, nlink: e.type === '5' ? 2 : 1, data: e.type === '5' ? null : e.data,
        });
        chunks.push(hm.bytes);
        if (e.type !== '5' && e.data) {
          chunks.push(e.data);
          const pad = (4 - (e.data.length % 4)) % 4;
          if (pad) chunks.push(new Uint8Array(pad));
        }
        if (verbose) c.err(`${e.name}\n`);
      }
      chunks.push(cpioHeader({ name: 'TRAILER!!!', ino: 0, mode: 0, uid: 0, gid: 0, nlink: 1, mtime: 0, data: null }).bytes);
      const bytes = concat(chunks);
      if (o.F) { try { vfsWrite(c, o.F, bytes, 0o644); } catch (e) { return reportErr(c, `cpio: ${o.F}: ${errnoText(e)}`); } }
      else outBytes(c, bytes);
      return 0;
    }
    if (!o.i && !o.t) return reportErr(c, 'cpio: you must specify one of -o, -i or -t', 2);
    let bytes;
    try { bytes = o.F ? vfsRead(c, o.F) : await c.readBytes(); }
    catch (e) { return reportErr(c, `cpio: ${errnoText(e)}`, 2); }
    const entries = parseCpio(bytes);
    const destRoot = resolvePath(c, '.');
    let exit = 0;
    for (const e of entries) {
      if (e.name === 'TRAILER!!!') break;
      if (o.t) { c.out(`${verbose ? modeString(e.mode) + ' ' : ''}${e.name}\n`); continue; }
      const parts = pathParts(e.name);
      if (!parts.length) continue;
      if (parts.includes('..')) { exit = reportErr(c, `cpio: ${e.name}: path traversal is not allowed`, 2); continue; }
      const target = safeJoin(destRoot, parts);
      const isDir = e.name.endsWith('/') || (e.mode & 0o170000) === 0o040000;
      try {
        if (isDir) { c.vfs.mkdirp(target, c.cred(), e.mode & 0o7777); }
        else {
          const parent = target.slice(0, target.lastIndexOf('/')) || '/';
          c.vfs.mkdirp(parent, c.cred());
          vfsWrite(c, target, e.data, e.mode & 0o777 || 0o644);
          try { c.vfs.chmod(target, e.mode & 0o7777, c.cred()); } catch { /* ignore */ }
          try { c.vfs.utimes(target, e.mtime, e.mtime, c.cred()); } catch { /* ignore */ }
        }
        if (verbose) c.out(`${e.name}\n`);
      } catch (err) { exit = reportErr(c, `cpio: ${e.name}: ${errnoText(err)}`, 2); }
    }
    return exit;
  });

  /* ar */
  reg(ctx, 'ar', 'create, modify and extract from archives', async (c) => {
    const raw = c.args.slice();
    if (!raw.length) return reportErr(c, 'ar: no operation specified', 1);
    let op = null, archive = null, rest = [];
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i];
      if (!op && !a.startsWith('-') && /^[a-z]+$/.test(a)) { op = a; continue; }
      if (!op && a.startsWith('-') && /^-[a-z]+$/.test(a)) { op = a.slice(1); continue; }
      if (!archive) { archive = a; continue; }
      rest.push(a);
    }
    if (!op || !archive) return reportErr(c, 'ar: usage: ar [rcsqt x] ARCHIVE [FILES...]', 1);
    if (op.includes('r') || op.includes('q')) {
      let members = [];
      if (c.vfs.exists(resolvePath(c, archive), c.cred())) {
        try { members = parseAr(vfsRead(c, archive)).filter((m) => !rest.some((f) => f === m.name)); } catch { /* ignore */ }
      }
      for (const f of rest) {
        try {
          const st = c.vfs.stat(resolvePath(c, f), c.cred());
          members.push({ name: f.replace(/^.*\//, ''), st, data: vfsRead(c, f) });
        } catch (e) { return reportErr(c, `ar: ${f}: ${errnoText(e)}`, 1); }
      }
      const chunks = [enc.encode('!<arch>\n')];
      for (const m of members) {
        chunks.push(arHeader(m.name, m.st || { mtimeMs: Date.now(), mode: 0o644, uid: 0, gid: 0 }, m.data.length));
        chunks.push(m.data);
        if (m.data.length % 2) chunks.push(new Uint8Array([10]));
      }
      try { vfsWrite(c, archive, concat(chunks), 0o644); } catch (e) { return reportErr(c, `ar: ${archive}: ${errnoText(e)}`); }
      return 0;
    }
    if (!c.vfs.exists(resolvePath(c, archive), c.cred())) return reportErr(c, `ar: ${archive}: No such file or directory`, 1);
    let members;
    try { members = parseAr(vfsRead(c, archive)); } catch (e) { return reportErr(c, `ar: ${archive}: ${e.message}`, 1); }
    if (op.includes('t')) {
      for (const m of members) c.out(`${m.name}\n`);
      return 0;
    }
    if (op.includes('x')) {
      let exit = 0;
      for (const m of members) {
        if (rest.length && !rest.includes(m.name)) continue;
        try { vfsWrite(c, m.name, m.data, 0o644); } catch (e) { exit = reportErr(c, `ar: ${m.name}: ${errnoText(e)}`); }
      }
      return exit;
    }
    return reportErr(c, `ar: unsupported operation '${op}'`, 1);
  });

  /* uuencode / uudecode */
  reg(ctx, 'uuencode', 'encode a binary file as uuencoded text', async (c) => {
    const o = parseOpts(c.args, 'm', { base64: 'm' });
    let infile = o._[0] || null;
    let remotename = o._[1] || (infile ? infile.split('/').pop() : 'stdin');
    const data = infile ? vfsRead(c, infile) : await c.readBytes();
    if (o.m) {
      c.out(`begin-base64 644 ${remotename}\n`);
      const b = b64encode(data);
      for (let i = 0; i < b.length; i += 76) c.out(b.slice(i, i + 76) + '\n');
      c.out('====\n');
      return 0;
    }
    c.out(`begin 644 ${remotename}\n`);
    for (let i = 0; i < data.length; i += 45) {
      const chunk = data.subarray(i, i + 45);
      c.out(String.fromCharCode(chunk.length + 32));
      for (let j = 0; j < chunk.length; j += 3) {
        const a = chunk[j], b = chunk[j + 1] ?? 0, cc = chunk[j + 2] ?? 0;
        const v = ((a << 16) | (b << 8) | cc);
        for (const shift of [18, 12, 6, 0]) {
          const six = (v >> shift) & 0x3f;
          c.out(String.fromCharCode(six === 0 ? 96 : six + 32));
        }
      }
      c.out('\n');
    }
    c.out('`\nend\n');
    return 0;
  });

  reg(ctx, 'uudecode', 'decode a uuencoded file', async (c) => {
    const o = parseOpts(c.args, 'o:', { output: 'o:' });
    const infile = o._[0];
    let text;
    try { text = infile ? dec.decode(vfsRead(c, infile)) : dec.decode(await c.readBytes()); }
    catch (e) { return reportErr(c, `uudecode: ${infile}: ${errnoText(e)}`); }
    const out = [];
    const lines = text.split(/\r?\n/);
    let mode = 0o644, name = null, base64 = false;
    let i = 0;
    if (!lines.length) return reportErr(c, 'uudecode: empty input');
    const begin = lines[0].match(/^begin(-base64)?\s+([0-7]+)\s+(.*)$/);
    if (!begin) return reportErr(c, 'uudecode: no `begin` line');
    base64 = !!begin[1];
    mode = parseInt(begin[2], 8);
    name = begin[3].trim();
    i = 1;
    if (base64) {
      let b64 = '';
      for (; i < lines.length; i++) {
        if (lines[i].startsWith('====')) break;
        b64 += lines[i];
      }
      try { out.push(b64decode(b64)); } catch (e) { return reportErr(c, `uudecode: ${e.message}`); }
    } else {
      let done = false;
      for (; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line === '`' || line === 'end') { done = true; break; }
        const n = (line.charCodeAt(0) - 32) & 0x3f;
        if (!n) break;
        const bytes = [];
        for (let j = 1; j + 3 < line.length + 1 && bytes.length < n; j += 4) {
          const vals = [0, 1, 2, 3].map((k) => ((line.charCodeAt(j + k) || 32) - 32) & 0x3f);
          const v = (vals[0] << 18) | (vals[1] << 12) | (vals[2] << 6) | vals[3];
          bytes.push((v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff);
        }
        out.push(new Uint8Array(bytes.slice(0, n)));
      }
      if (!done && !out.length) return reportErr(c, 'uudecode: no data lines found');
    }
    const data = concat(out);
    const dest = o.o || name || 'uudecode.out';
    try {
      vfsWrite(c, dest, data, mode & 0o777);
      c.out(`uudecode: wrote ${data.length} bytes to ${dest}\n`);
      return 0;
    } catch (e) { return reportErr(c, `uudecode: ${dest}: ${errnoText(e)}`); }
  });
}
