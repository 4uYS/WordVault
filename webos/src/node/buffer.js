/*
 * Browser-safe Node Buffer implementation.
 * Extends Uint8Array, supports the Node encodings and the binary
 * read/write helpers used by real Node programs.
 */

const ENC = new TextEncoder();
const DEC = new TextDecoder('utf-8');
const DEC2 = new TextDecoder('utf-16le');

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function normalizeEncoding(enc) {
  if (!enc) return 'utf8';
  const k = String(enc).toLowerCase();
  switch (k) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'hex': return 'hex';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'ascii': return 'ascii';
    case 'latin1': case 'binary': return 'latin1';
    case 'utf16le': case 'utf-16le': case 'ucs2': case 'ucs-2': return 'utf16le';
    default: throw new TypeError(`Unknown encoding: ${enc}`);
  }
}

export function isEncoding(enc) {
  try { normalizeEncoding(enc); return true; } catch { return false; }
}

export function base64Encode(bytes, urlSafe = false) {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  if (i < bytes.length) {
    const rem = bytes.length - i;
    const n = (bytes[i] << 16) | (rem === 2 ? bytes[i + 1] << 8 : 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += rem === 2 ? B64[(n >> 6) & 63] : '=';
    out += '=';
  }
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return out;
}

const B64_LOOKUP = (() => {
  const t = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function base64Decode(str) {
  let s = String(str).replace(/[\s\r\n]+/g, '');
  s = s.replace(/=+$/, '');
  let bits = 0, acc = 0;
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const v = B64_LOOKUP[s.charCodeAt(i)];
    if (v < 0) throw new TypeError('Invalid character in base64 string');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); }
  }
  return new Uint8Array(out);
}

export function hexEncode(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
  return s;
}

export function hexDecode(str) {
  const s = String(str);
  const len = s.length >>> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const b = parseInt(s.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(b)) throw new TypeError('Invalid hex string');
    out[i] = b;
  }
  return out;
}

export function utf16leEncode(str) {
  const s = String(str);
  const out = new Uint8Array(s.length * 2);
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out[i * 2] = c & 0xff; out[i * 2 + 1] = (c >>> 8) & 0xff;
  }
  return out;
}

export function utf16leDecode(bytes) { return DEC2.decode(bytes); }

function stringToBytes(str, encoding) {
  switch (encoding) {
    case 'utf8': return ENC.encode(str);
    case 'hex': return hexDecode(str);
    case 'base64': return base64Decode(str);
    case 'base64url': return base64Decode(str);
    case 'latin1': case 'ascii': {
      const out = new Uint8Array(str.length);
      for (let i = 0; i < str.length; i++) out[i] = str.charCodeAt(i) & 0xff;
      return out;
    }
    case 'utf16le': return utf16leEncode(str);
    default: return ENC.encode(str);
  }
}

function bytesToString(bytes, encoding) {
  switch (encoding) {
    case 'utf8': return DEC.decode(bytes);
    case 'hex': return hexEncode(bytes);
    case 'base64': return base64Encode(bytes, false);
    case 'base64url': return base64Encode(bytes, true);
    case 'ascii': {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] & 0x7f);
      return s;
    }
    case 'latin1': {
      let s = '';
      for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
    case 'utf16le': return utf16leDecode(bytes);
    default: return DEC.decode(bytes);
  }
}

const isArrayBuffer = (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer);

export class Buffer extends Uint8Array {
  constructor(arg = 0, byteOffset, length) {
    if (typeof arg === 'number') super(arg);
    else if (isArrayBuffer(arg)) super(arg, byteOffset || 0, length);
    else if (arg instanceof ArrayBuffer || ArrayBuffer.isView(arg)) super(arg, byteOffset || 0, length);
    else if (Array.isArray(arg) || (arg && typeof arg[Symbol.iterator] === 'function')) super(arg);
    else super(arg);
  }

  /* ------------------------------ statics ------------------------------ */

  static from(value, encodingOrOffset, length) {
    if (typeof value === 'string') {
      const enc = normalizeEncoding(encodingOrOffset);
      const bytes = stringToBytes(value, enc);
      return Buffer._copyOf(bytes);
    }
    if (value instanceof Buffer) return Buffer._copyOf(value);
    if (isArrayBuffer(value)) {
      const off = encodingOrOffset || 0;
      const len = length === undefined ? value.byteLength - off : length;
      return new Buffer(value, off, len);
    }
    if (ArrayBuffer.isView(value)) return Buffer._copyOf(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (Array.isArray(value)) return Buffer._copyOf(Uint8Array.from(value));
    if (value && typeof value[Symbol.iterator] === 'function') return Buffer._copyOf(Uint8Array.from(value));
    if (value && typeof value.length === 'number') {
      const out = new Buffer(value.length);
      for (let i = 0; i < value.length; i++) out[i] = value[i];
      return out;
    }
    throw new TypeError('The first argument must be a string, Buffer, ArrayBuffer, Array or array-like object');
  }

  static _copyOf(bytes) {
    const b = new Buffer(bytes.length);
    b.set(bytes);
    return b;
  }

  static alloc(size, fill = 0, encoding) {
    if (typeof size !== 'number') throw new TypeError('size must be a number');
    const b = new Buffer(size);
    if (fill !== 0 && fill !== undefined) {
      if (typeof fill === 'string') {
        const pat = stringToBytes(fill, normalizeEncoding(encoding));
        if (pat.length) for (let i = 0; i < size; i++) b[i] = pat[i % pat.length];
      } else if (typeof fill === 'number') b.fill(fill & 0xff);
      else if (fill instanceof Uint8Array) {
        if (fill.length) for (let i = 0; i < size; i++) b[i] = fill[i % fill.length];
      }
    }
    return b;
  }

  static allocUnsafe(size) { return new Buffer(size); }
  static allocUnsafeSlow(size) { return new Buffer(size); }

  static byteLength(value, encoding) {
    if (typeof value !== 'string') {
      if (isArrayBuffer(value)) return value.byteLength;
      if (ArrayBuffer.isView(value)) return value.byteLength;
      return Buffer.from(value).length;
    }
    const enc = normalizeEncoding(encoding);
    switch (enc) {
      case 'hex': return value.length >>> 1;
      case 'base64': case 'base64url': {
        const s = value.replace(/[\s\r\n]+/g, '').replace(/=+$/, '');
        return Math.floor((s.length * 3) / 4);
      }
      case 'latin1': case 'ascii': return value.length;
      case 'utf16le': return value.length * 2;
      default: return ENC.encode(value).length;
    }
  }

  static isBuffer(v) { return v instanceof Buffer; }
  static isEncoding(e) { return isEncoding(e); }

  static compare(a, b) {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
  }

  static concat(list, totalLength) {
    if (!Array.isArray(list)) throw new TypeError('list must be an Array of Buffers');
    if (!list.length) return new Buffer(0);
    let total = totalLength;
    if (total === undefined) {
      total = 0;
      for (const b of list) total += b.length;
    }
    const out = new Buffer(total);
    let off = 0;
    for (const b of list) {
      if (off >= total) break;
      const bytes = b instanceof Uint8Array ? b : Buffer.from(b);
      const n = Math.min(bytes.length, total - off);
      out.set(bytes.subarray(0, n), off);
      off += n;
    }
    return out;
  }

  /* ------------------------------ instance ------------------------------ */

  toString(encoding = 'utf8', start = 0, end = this.length) {
    const enc = normalizeEncoding(encoding);
    return bytesToString(this.subarray(start, end), enc);
  }

  toJSON() { return { type: 'Buffer', data: Array.from(this) }; }

  write(string, offset = 0, length, encoding) {
    if (typeof length === 'string') { encoding = length; length = undefined; }
    const enc = normalizeEncoding(encoding);
    const bytes = stringToBytes(String(string), enc);
    const len = length === undefined ? Math.min(bytes.length, this.length - offset) : Math.min(bytes.length, length);
    if (offset < 0 || offset > this.length) throw new RangeError('offset is out of bounds');
    if (len < 0 || offset + len > this.length) throw new RangeError('length is out of bounds');
    this.set(bytes.subarray(0, len), offset);
    return len;
  }

  slice(start, end) {
    const s = Math.max(0, start | 0);
    const e = Math.max(s, end === undefined ? this.length : Math.min(this.length, end | 0));
    return new Buffer(this.buffer, this.byteOffset + s, e - s);
  }

  subarray(start, end) {
    const s = Math.max(0, start | 0);
    const e = Math.max(s, end === undefined ? this.length : Math.min(this.length, end | 0));
    return new Buffer(this.buffer, this.byteOffset + s, e - s);
  }

  copy(target, targetStart = 0, sourceStart = 0, sourceEnd = this.length) {
    const src = this.subarray(sourceStart, sourceEnd);
    const n = Math.min(src.length, target.length - targetStart);
    target.set(src.subarray(0, n), targetStart);
    return n;
  }

  fill(value, offset = 0, end = this.length, encoding) {
    if (typeof offset === 'string') { encoding = offset; offset = 0; end = this.length; }
    const s = offset | 0, e = Math.min(this.length, end | 0);
    if (typeof value === 'number') {
      for (let i = s; i < e; i++) this[i] = value & 0xff;
    } else if (typeof value === 'string') {
      const pat = stringToBytes(value, normalizeEncoding(encoding));
      if (!pat.length) return this;
      for (let i = s; i < e; i++) this[i] = pat[(i - s) % pat.length];
    } else {
      const pat = Buffer.from(value);
      if (!pat.length) return this;
      for (let i = s; i < e; i++) this[i] = pat[(i - s) % pat.length];
    }
    return this;
  }

  equals(other) { return Buffer.compare(this, other) === 0; }

  compare(other) { return Buffer.compare(this, other); }

  indexOf(value, byteOffset = 0, encoding) {
    let needle;
    if (typeof value === 'number') needle = Buffer.from([value & 0xff]);
    else if (typeof value === 'string') needle = Buffer.from(value, encoding || 'utf8');
    else needle = Buffer.from(value);
    if (!needle.length) return Math.min(byteOffset, this.length);
    for (let i = Math.max(0, byteOffset); i <= this.length - needle.length; i++) {
      let hit = true;
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) { hit = false; break; }
      if (hit) return i;
    }
    return -1;
  }

  includes(value, byteOffset, encoding) { return this.indexOf(value, byteOffset, encoding) !== -1; }

  lastIndexOf(value, byteOffset = this.length, encoding) {
    let needle;
    if (typeof value === 'number') needle = Buffer.from([value & 0xff]);
    else if (typeof value === 'string') needle = Buffer.from(value, encoding || 'utf8');
    else needle = Buffer.from(value);
    for (let i = Math.min(byteOffset, this.length - needle.length); i >= 0; i--) {
      let hit = true;
      for (let j = 0; j < needle.length; j++) if (this[i + j] !== needle[j]) { hit = false; break; }
      if (hit) return i;
    }
    return -1;
  }

  /* numeric accessors */
  _dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
  readUInt8(o = 0) { return this._dv().getUint8(o); }
  readUInt16LE(o = 0) { return this._dv().getUint16(o, true); }
  readUInt16BE(o = 0) { return this._dv().getUint16(o, false); }
  readUInt32LE(o = 0) { return this._dv().getUint32(o, true); }
  readUInt32BE(o = 0) { return this._dv().getUint32(o, false); }
  readInt8(o = 0) { return this._dv().getInt8(o); }
  readInt16LE(o = 0) { return this._dv().getInt16(o, true); }
  readInt16BE(o = 0) { return this._dv().getInt16(o, false); }
  readInt32LE(o = 0) { return this._dv().getInt32(o, true); }
  readInt32BE(o = 0) { return this._dv().getInt32(o, false); }
  readFloatLE(o = 0) { return this._dv().getFloat32(o, true); }
  readFloatBE(o = 0) { return this._dv().getFloat32(o, false); }
  readDoubleLE(o = 0) { return this._dv().getFloat64(o, true); }
  readDoubleBE(o = 0) { return this._dv().getFloat64(o, false); }
  readBigInt64LE(o = 0) { return this._dv().getBigInt64(o, true); }
  readBigInt64BE(o = 0) { return this._dv().getBigInt64(o, false); }
  readBigUInt64LE(o = 0) { return this._dv().getBigUint64(o, true); }
  readBigUInt64BE(o = 0) { return this._dv().getBigUint64(o, false); }

  readUIntLE(o, n) { let v = 0; for (let i = n - 1; i >= 0; i--) v = v * 256 + this[o + i]; return v; }
  readUIntBE(o, n) { let v = 0; for (let i = 0; i < n; i++) v = v * 256 + this[o + i]; return v; }
  readIntLE(o, n) { const v = this.readUIntLE(o, n); const max = 2 ** (n * 8 - 1); return v >= max ? v - max * 2 : v; }
  readIntBE(o, n) { const v = this.readUIntBE(o, n); const max = 2 ** (n * 8 - 1); return v >= max ? v - max * 2 : v; }

  writeUInt8(v, o = 0) { this._dv().setUint8(o, v); return o + 1; }
  writeUInt16LE(v, o = 0) { this._dv().setUint16(o, v, true); return o + 2; }
  writeUInt16BE(v, o = 0) { this._dv().setUint16(o, v, false); return o + 2; }
  writeUInt32LE(v, o = 0) { this._dv().setUint32(o, v, true); return o + 4; }
  writeUInt32BE(v, o = 0) { this._dv().setUint32(o, v, false); return o + 4; }
  writeInt8(v, o = 0) { this._dv().setInt8(o, v); return o + 1; }
  writeInt16LE(v, o = 0) { this._dv().setInt16(o, v, true); return o + 2; }
  writeInt16BE(v, o = 0) { this._dv().setInt16(o, v, false); return o + 2; }
  writeInt32LE(v, o = 0) { this._dv().setInt32(o, v, true); return o + 4; }
  writeInt32BE(v, o = 0) { this._dv().setInt32(o, v, false); return o + 4; }
  writeFloatLE(v, o = 0) { this._dv().setFloat32(o, v, true); return o + 4; }
  writeFloatBE(v, o = 0) { this._dv().setFloat32(o, v, false); return o + 4; }
  writeDoubleLE(v, o = 0) { this._dv().setFloat64(o, v, true); return o + 8; }
  writeDoubleBE(v, o = 0) { this._dv().setFloat64(o, v, false); return o + 8; }
  writeBigInt64LE(v, o = 0) { this._dv().setBigInt64(o, v, true); return o + 8; }
  writeBigUInt64LE(v, o = 0) { this._dv().setBigUint64(o, v, true); return o + 8; }

  writeUIntLE(v, o, n) { for (let i = 0; i < n; i++) { this[o + i] = v & 0xff; v = Math.floor(v / 256); } return o + n; }
  writeUIntBE(v, o, n) { for (let i = n - 1; i >= 0; i--) { this[o + i] = v & 0xff; v = Math.floor(v / 256); } return o + n; }
  writeIntLE(v, o, n) { let x = v < 0 ? v + 2 ** (n * 8) : v; return this.writeUIntLE(x, o, n); }
  writeIntBE(v, o, n) { let x = v < 0 ? v + 2 ** (n * 8) : v; return this.writeUIntBE(x, o, n); }
}

export const SlowBuffer = Buffer;
export const kMaxLength = 0x7fffffff;
export const INSPECT_MAX_BYTES = 50;

export function transcode(source, fromEnc, toEnc) {
  return Buffer.from(Buffer.from(source, fromEnc).toString(toEnc), toEnc);
}

/* Internal helper shared with the loader: turn anything into a Buffer. */
export function toBuffer(value, encoding) {
  return Buffer.isBuffer(value) ? value : Buffer.from(value, encoding);
}
