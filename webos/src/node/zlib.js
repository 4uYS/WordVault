/*
 * Minimal synchronous DEFLATE / INFLATE / gzip in pure JS.
 * - deflate emits "stored" (uncompressed) blocks, which is valid DEFLATE.
 * - inflate handles stored, fixed-Huffman and dynamic-Huffman blocks, so it
 *   can decompress real gzip streams produced by other tools.
 *
 * All compression entry points are synchronous; callback variants merely
 * delegate, and the central directory of streaming variants buffers input and
 * transforms on flush.
 */

import { Transform } from './stream.js';
import { Buffer } from './buffer.js';

/* ------------------------------- CRC32 ------------------------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(data, seed = 0) {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------ utilities ------------------------------ */

const toBytes = (v) => {
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('zlib input must be a string, Buffer, TypedArray or ArrayBuffer');
};

class BitReader {
  constructor(data) { this.data = data; this.pos = 0; this.buf = 0; this.cnt = 0; }
  bits(n) {
    while (this.cnt < n) {
      if (this.pos >= this.data.length) throw new Error('unexpected end of DEFLATE stream');
      this.buf |= this.data[this.pos++] << this.cnt;
      this.cnt += 8;
    }
    const v = this.buf & ((1 << n) - 1);
    this.buf >>>= n;
    this.cnt -= n;
    return v;
  }
  align() { this.buf = 0; this.cnt = 0; }
  byte() {
    if (this.cnt === 0) {
      if (this.pos >= this.data.length) throw new Error('unexpected end of DEFLATE stream');
      return this.data[this.pos++];
    }
    return this.bits(8);
  }
}

function buildHuffman(lengths) {
  let maxLen = 0;
  for (const l of lengths) if (l > maxLen) maxLen = l;
  const counts = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) counts[l]++;
  const next = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + counts[bits - 1]) << 1;
    next[bits] = code;
  }
  const table = new Map();
  for (let sym = 0; sym < lengths.length; sym++) {
    const len = lengths[sym];
    if (!len) continue;
    table.set((len << 16) | next[len], sym);
    next[len]++;
  }
  return { table, maxLen };
}

function decodeSym(reader, huff) {
  let code = 0;
  for (let len = 1; len <= huff.maxLen; len++) {
    code = (code << 1) | reader.bits(1);
    const sym = huff.table.get((len << 16) | code);
    if (sym !== undefined) return sym;
  }
  throw new Error('invalid Huffman code in DEFLATE stream');
}

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const FIXED_LIT = (() => {
  const l = new Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  return l;
})();
const FIXED_DIST = new Array(30).fill(5);

/* ------------------------------ inflate ------------------------------ */

class Growable {
  constructor(size = 65536) { this.buf = new Uint8Array(size); this.len = 0; }
  push(b) {
    if (this.len + 1 > this.buf.length) this.grow(this.len + 1);
    this.buf[this.len++] = b;
  }
  grow(need) {
    let size = this.buf.length * 2;
    while (size < need) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }
  copyBack(dist, length) {
    if (dist > this.len) throw new Error('invalid distance too far back in DEFLATE stream');
    let src = this.len - dist;
    for (let i = 0; i < length; i++) this.push(this.buf[src++]);
  }
  result() { return this.buf.slice(0, this.len); }
}

function inflateRawInto(data, out) {
  const r = new BitReader(data);
  let final = 0;
  while (!final) {
    final = r.bits(1);
    const type = r.bits(2);
    if (type === 0) {
      r.align();
      const len = r.byte() | (r.byte() << 8);
      const nlen = r.byte() | (r.byte() << 8);
      if (((len ^ 0xffff) & 0xffff) !== nlen) throw new Error('invalid stored block length');
      for (let i = 0; i < len; i++) out.push(r.byte());
    } else if (type === 1 || type === 2) {
      let litHuff, distHuff;
      if (type === 1) {
        litHuff = buildHuffman(FIXED_LIT);
        distHuff = buildHuffman(FIXED_DIST);
      } else {
        const hlit = r.bits(5) + 257;
        const hdist = r.bits(5) + 1;
        const hclen = r.bits(4) + 4;
        const order = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
        const clLens = new Array(19).fill(0);
        for (let i = 0; i < hclen; i++) clLens[order[i]] = r.bits(3);
        const clHuff = buildHuffman(clLens);
        const lens = [];
        while (lens.length < hlit + hdist) {
          const sym = decodeSym(r, clHuff);
          if (sym < 16) lens.push(sym);
          else if (sym === 16) {
            if (!lens.length) throw new Error('invalid repeat code in DEFLATE code lengths');
            const prev = lens[lens.length - 1];
            const rep = 3 + r.bits(2);
            for (let i = 0; i < rep; i++) lens.push(prev);
          } else if (sym === 17) {
            const rep = 3 + r.bits(3);
            for (let i = 0; i < rep; i++) lens.push(0);
          } else {
            const rep = 11 + r.bits(7);
            for (let i = 0; i < rep; i++) lens.push(0);
          }
        }
        litHuff = buildHuffman(lens.slice(0, hlit));
        distHuff = buildHuffman(lens.slice(hlit, hlit + hdist));
      }
      for (;;) {
        const sym = decodeSym(r, litHuff);
        if (sym < 256) { out.push(sym); continue; }
        if (sym === 256) break;
        const li = sym - 257;
        if (li >= LENGTH_BASE.length) throw new Error('invalid length code in DEFLATE stream');
        const length = LENGTH_BASE[li] + (LENGTH_EXTRA[li] ? r.bits(LENGTH_EXTRA[li]) : 0);
        const ds = decodeSym(r, distHuff);
        if (ds >= DIST_BASE.length) throw new Error('invalid distance code in DEFLATE stream');
        const dist = DIST_BASE[ds] + (DIST_EXTRA[ds] ? r.bits(DIST_EXTRA[ds]) : 0);
        out.copyBack(dist, length);
      }
    } else {
      throw new Error('invalid DEFLATE block type 3');
    }
  }
  return out;
}

export function inflateRawSync(input) {
  const out = new Growable(Math.max(65536, toBytes(input).length * 4));
  return Buffer.from(inflateRawInto(toBytes(input), out).result());
}

function zlibParseHeader(data) {
  if (data.length < 2) throw new Error('unexpected end of ZLIB stream');
  const cmf = data[0], flg = data[1];
  if ((cmf & 0x0f) !== 8) throw new Error('unsupported compression method in ZLIB header');
  if (((cmf << 8) | flg) % 31 !== 0) throw new Error('invalid ZLIB header checksum');
  if (flg & 0x20) throw new Error('preset dictionaries are not supported by the WebOS zlib implementation');
  let start = 2;
  if (flg & 0x20) start += 4;
  return start;
}

export function inflateSync(input) {
  const data = toBytes(input);
  const start = zlibParseHeader(data);
  const out = new Growable(Math.max(65536, data.length * 4));
  return Buffer.from(inflateRawInto(data.subarray(start), out).result());
}

export function gunzipSync(input) {
  const data = toBytes(input);
  if (data.length < 10 || data[0] !== 0x1f || data[1] !== 0x8b) throw new Error('not in gzip format');
  if (data[2] !== 8) throw new Error('unsupported gzip compression method');
  const flg = data[3];
  let pos = 10;
  if (flg & 4) { if (pos + 2 > data.length) throw new Error('truncated gzip header'); const xlen = data[pos] | (data[pos + 1] << 8); pos += 2 + xlen; }
  if (flg & 8) { while (pos < data.length && data[pos] !== 0) pos++; pos++; }
  if (flg & 16) { while (pos < data.length && data[pos] !== 0) pos++; pos++; }
  if (flg & 2) pos += 2;
  if (pos > data.length) throw new Error('truncated gzip header');
  const out = new Growable(Math.max(65536, data.length * 4));
  inflateRawInto(data.subarray(pos, data.length - 8), out);
  const result = out.result();
  if (data.length >= 8) {
    const dv = new DataView(data.buffer, data.byteOffset + data.length - 8, 8);
    const crc = dv.getUint32(0, true);
    const isize = dv.getUint32(4, true);
    if (isize !== (result.length >>> 0)) throw new Error('incorrect gzip length');
    if (crc !== crc32(result)) throw new Error('incorrect gzip data check');
  }
  return Buffer.from(result);
}

/* ------------------------------ deflate ------------------------------ */

function writeStored(data, { level = 6 } = {}) {
  const chunks = [];
  let pos = 0;
  do {
    const n = Math.min(65535, data.length - pos);
    const final = pos + n >= data.length ? 1 : 0;
    if (n === 0 && data.length > 0) break;
    const head = new Uint8Array(5);
    head[0] = final;
    head[1] = n & 0xff;
    head[2] = (n >>> 8) & 0xff;
    head[3] = ~n & 0xff;
    head[4] = (~n >>> 8) & 0xff;
    chunks.push(head);
    if (n) chunks.push(data.subarray(pos, pos + n));
    pos += n;
  } while (pos < data.length);
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export function deflateRawSync(input) {
  return Buffer.from(writeStored(toBytes(input)));
}

export function deflateSync(input) {
  const body = deflateRawSync(input);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x01; // CM=8, 32K window, level 0 -> FCHECK 1
  out.set(body, 2);
  const dv = new DataView(out.buffer);
  let a = 1, b = 0;
  const bytes = toBytes(input);
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  dv.setUint32(out.length - 4, ((b << 16) | a) >>> 0, false);
  return Buffer.from(out);
}

export function gzipSync(input, opts = {}) {
  const bytes = toBytes(input);
  const body = deflateRawSync(bytes, opts);
  const out = new Uint8Array(10 + body.length + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 0xff], 0);
  out.set(body, 10);
  const dv = new DataView(out.buffer);
  dv.setUint32(10 + body.length, crc32(bytes), true);
  dv.setUint32(10 + body.length + 4, bytes.length >>> 0, true);
  return Buffer.from(out);
}

/* ------------------------- callback / stream API ------------------------- */

function cbify(syncFn) {
  return function (input, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = {}; }
    if (typeof cb !== 'function') return syncFn(input, opts);
    queueMicrotask(() => {
      try { cb(null, syncFn(input, opts)); } catch (e) { cb(e); }
    });
  };
}

export const gzip = cbify(gzipSync);
export const gunzip = cbify(gunzipSync);
export const deflate = cbify(deflateSync);
export const inflate = cbify(inflateSync);
export const deflateRaw = cbify(deflateRawSync);
export const inflateRaw = cbify(inflateRawSync);

class ZlibTransform extends Transform {
  constructor(fn, opts) {
    super(opts);
    this._fn = fn;
    this._chunks = [];
  }
  _transform(chunk, enc, cb) {
    this._chunks.push(Buffer.from(chunk));
    cb();
  }
  _flush(cb) {
    try {
      const all = Buffer.concat(this._chunks);
      this.push(Buffer.from(this._fn(all)));
      cb();
    } catch (e) { cb(e); }
  }
}

export class Gzip extends ZlibTransform { constructor(opts) { super(gzipSync, opts); } }
export class Gunzip extends ZlibTransform { constructor(opts) { super(gunzipSync, opts); } }
export class Deflate extends ZlibTransform { constructor(opts) { super(deflateSync, opts); } }
export class Inflate extends ZlibTransform { constructor(opts) { super(inflateSync, opts); } }
export class DeflateRaw extends ZlibTransform { constructor(opts) { super(deflateRawSync, opts); } }
export class InflateRaw extends ZlibTransform { constructor(opts) { super(inflateRawSync, opts); } }

export const createGzip = (opts) => new Gzip(opts);
export const createGunzip = (opts) => new Gunzip(opts);
export const createDeflate = (opts) => new Deflate(opts);
export const createInflate = (opts) => new Inflate(opts);
export const createDeflateRaw = (opts) => new DeflateRaw(opts);
export const createInflateRaw = (opts) => new InflateRaw(opts);

export const constants = {
  Z_NO_FLUSH: 0, Z_PARTIAL_FLUSH: 1, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4,
  Z_BLOCK: 5, Z_OK: 0, Z_STREAM_END: 1, Z_NEED_DICT: 2, Z_ERRNO: -1,
  Z_STREAM_ERROR: -2, Z_DATA_ERROR: -3, Z_BUF_ERROR: -5, Z_DEFAULT_COMPRESSION: -1,
  Z_DEFAULT_STRATEGY: 0, Z_FIXED: 4, Z_DEFAULT_WINDOWBITS: 15,
};
