/*
 * `crypto` module: synchronous hashes/HMAC, PBKDF2, random helpers and
 * AES-CBC ciphers. Signing and scrypt are explicitly unsupported.
 */

import { Buffer } from './buffer.js';
import { HASH_INFO, hmac as hmacBytes, digest as digestBytes } from './crypto-hash.js';
import { encryptBlock, decryptBlock, pad, unpad } from './aes.js';

const ENC = new TextEncoder();

const toBytes = (v, encoding) => {
  if (typeof v === 'string') return encoding ? Buffer.from(v, encoding) : ENC.encode(v);
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new TypeError('data must be a string, Buffer, TypedArray or DataView');
};

const normalizeAlgo = (algo) => String(algo).toLowerCase().replace(/-/g, '');

const randomBytesBytes = (n) => {
  const out = new Uint8Array(n);
  if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(out);
  else for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
};

class Hash {
  constructor(algo) {
    const name = normalizeAlgo(algo);
    if (!HASH_INFO[name]) throw new Error(`Digest method not supported: ${algo}`);
    this._algo = name;
    this._chunks = [];
    this._finished = false;
  }
  update(data, encoding) {
    if (this._finished) throw new Error('Digest already called');
    this._chunks.push(Buffer.from(toBytes(data, encoding)));
    return this;
  }
  digest(encoding) {
    if (this._finished) throw new Error('Digest already called');
    this._finished = true;
    const all = Buffer.concat(this._chunks);
    const out = Buffer.from(digestBytes(this._algo, all));
    return encoding ? out.toString(encoding) : out;
  }
  copy() {
    const h = new Hash(this._algo);
    h._chunks = this._chunks.map((c) => Buffer.from(c));
    return h;
  }
}

class Hmac {
  constructor(algo, key) {
    const name = normalizeAlgo(algo);
    if (!HASH_INFO[name]) throw new Error(`Digest method not supported: ${algo}`);
    this._algo = name;
    this._key = Buffer.from(toBytes(key));
    this._chunks = [];
    this._finished = false;
  }
  update(data, encoding) {
    if (this._finished) throw new Error('Digest already called');
    this._chunks.push(Buffer.from(toBytes(data, encoding)));
    return this;
  }
  digest(encoding) {
    if (this._finished) throw new Error('Digest already called');
    this._finished = true;
    const out = Buffer.from(hmacBytes(this._algo, this._key, Buffer.concat(this._chunks)));
    return encoding ? out.toString(encoding) : out;
  }
}

export function createHash(algo) { return new Hash(algo); }
export function createHmac(algo, key) {
  if (key === undefined) throw new TypeError('The "key" argument must be specified');
  return new Hmac(algo, key);
}

export function getHashes() { return Object.keys(HASH_INFO); }

/* -------------------------------- random -------------------------------- */

export function randomBytes(size, cb) {
  if (typeof size !== 'number' || size < 0) throw new TypeError('size must be a non-negative number');
  const bytes = Buffer.from(randomBytesBytes(size));
  if (typeof cb === 'function') { queueMicrotask(() => cb(null, bytes)); return; }
  return bytes;
}

export function randomFillSync(buffer, offset = 0, size) {
  const len = size === undefined ? buffer.length - offset : size;
  const bytes = randomBytesBytes(len);
  buffer.set(bytes, offset);
  return buffer;
}

export function randomFill(buffer, offset, size, cb) {
  if (typeof offset === 'function') { cb = offset; offset = 0; size = undefined; }
  else if (typeof size === 'function') { cb = size; size = undefined; }
  queueMicrotask(() => {
    try { cb(null, randomFillSync(buffer, offset, size)); } catch (e) { cb(e); }
  });
}

export function randomUUID(options) {
  const b = randomBytesBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (options?.disableEntropyCache === undefined && options && typeof options === 'object' && options.random) {
    return `${uuid}`;
  }
  return uuid;
}

export function randomInt(min, max, cb) {
  if (typeof min === 'number' && typeof max === 'function') { cb = max; max = min; min = 0; }
  if (typeof min === 'function') { cb = min; min = 0; max = 2 ** 48; }
  if (max === undefined) { max = min; min = 0; }
  if (min > max) throw new RangeError('The value of "max" is out of range. It must be greater than the value of "min"');
  const range = max - min;
  const value = min + Math.floor((randomBytesBytes(6).reduce((a, b) => a * 256 + b, 0) / 2 ** 48) * range);
  if (typeof cb === 'function') { queueMicrotask(() => cb(null, value)); return; }
  return value;
}

export function getRandomValues(array) {
  const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  view.set(randomBytesBytes(view.length));
  return array;
}

export function timingSafeEqual(a, b) {
  if (!a || !b || a.length !== b.length) {
    const e = new RangeError('Input buffers must have the same byte length');
    e.code = 'ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH';
    throw e;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* -------------------------------- pbkdf2 -------------------------------- */

export function pbkdf2Sync(password, salt, iterations, keylen, digest = 'sha1') {
  const algo = normalizeAlgo(digest);
  const info = HASH_INFO[algo];
  if (!info) throw new Error(`Digest method not supported: ${digest}`);
  const pw = Buffer.from(toBytes(password));
  const saltBytes = Buffer.from(toBytes(salt));
  const hLen = info.fn(new Uint8Array(0)).length;
  const blocks = Math.ceil(keylen / hLen);
  const out = Buffer.alloc(blocks * hLen);
  for (let i = 1; i <= blocks; i++) {
    const idx = Buffer.alloc(4);
    idx.writeUInt32BE(i, 0);
    let u = Buffer.from(hmacBytes(algo, pw, Buffer.concat([saltBytes, idx])));
    const t = Buffer.from(u);
    for (let j = 1; j < iterations; j++) {
      u = Buffer.from(hmacBytes(algo, pw, u));
      for (let k = 0; k < hLen; k++) t[k] ^= u[k];
    }
    t.copy(out, (i - 1) * hLen);
  }
  return Buffer.from(out.subarray(0, keylen));
}

export function pbkdf2(password, salt, iterations, keylen, digest, cb) {
  if (typeof digest === 'function') { cb = digest; digest = 'sha1'; }
  queueMicrotask(() => {
    try { cb(null, pbkdf2Sync(password, salt, iterations, keylen, digest)); } catch (e) { cb(e); }
  });
}

export function scryptSync() {
  const e = new Error('scrypt is not supported in the WebOS browser sandbox (no native memory-hard KDF)');
  e.code = 'ERR_CRYPTO_UNSUPPORTED';
  throw e;
}
export function scrypt(...args) {
  const cb = args[args.length - 1];
  const e = new Error('scrypt is not supported in the WebOS browser sandbox (no native memory-hard KDF)');
  e.code = 'ERR_CRYPTO_UNSUPPORTED';
  if (typeof cb === 'function') queueMicrotask(() => cb(e));
  else throw e;
}

/* -------------------------------- ciphers -------------------------------- */

const CIPHER_INFO = {
  'aes-128-cbc': { keyLen: 16, ivLen: 16 },
  'aes-192-cbc': { keyLen: 24, ivLen: 16 },
  'aes-256-cbc': { keyLen: 32, ivLen: 16 },
};

export function getCiphers() { return Object.keys(CIPHER_INFO); }

class CipherBase {
  constructor(name, key, iv, decrypt) {
    const info = CIPHER_INFO[String(name).toLowerCase()];
    if (!info) {
      const e = new Error(`Unsupported cipher: ${name}. WebOS supports ${Object.keys(CIPHER_INFO).join(', ')}`);
      e.code = 'ERR_CRYPTO_UNSUPPORTED';
      throw e;
    }
    if (key == null) throw new TypeError('The "key" argument must be specified');
    if (iv == null) throw new TypeError('The "iv" argument must be specified');
    this._key = Buffer.from(toBytes(key));
    this._iv = Buffer.from(toBytes(iv));
    if (this._key.length !== info.keyLen) throw new RangeError(`Invalid key length: ${this._key.length}, expected ${info.keyLen} for ${name}`);
    if (this._iv.length !== info.ivLen) throw new RangeError(`Invalid IV length: ${this._iv.length}, expected ${info.ivLen} for ${name}`);
    this._decrypt = decrypt;
    this._prev = Buffer.from(this._iv);
    this._pending = Buffer.alloc(0);
    this._autoPadding = true;
    this._finished = false;
  }

  setAutoPadding(autoPadding = true) { this._autoPadding = !!autoPadding; return this; }

  _processBlocks(bytes) {
    const out = Buffer.alloc(bytes.length);
    const key = this._key;
    for (let off = 0; off < bytes.length; off += 16) {
      const block = bytes.subarray(off, off + 16);
      if (this._decrypt) {
        const plain = Buffer.from(decryptBlock(block, key));
        for (let i = 0; i < 16; i++) out[off + i] = plain[i] ^ this._prev[i];
        this._prev = Buffer.from(block);
      } else {
        const xored = Buffer.alloc(16);
        for (let i = 0; i < 16; i++) xored[i] = block[i] ^ this._prev[i];
        const enc = Buffer.from(encryptBlock(xored, key));
        out.set(enc, off);
        this._prev = enc;
      }
    }
    return out;
  }

  update(data, inputEncoding, outputEncoding) {
    if (this._finished) throw new Error('Cipher already finalized');
    if (typeof inputEncoding === 'object') { outputEncoding = inputEncoding.outputEncoding; inputEncoding = inputEncoding.inputEncoding; }
    const bytes = Buffer.from(toBytes(data, inputEncoding));
    let buf = this._pending.length ? Buffer.concat([this._pending, bytes]) : bytes;
    const usable = this._autoPadding ? Math.floor(buf.length / 16) * 16 : buf.length - (buf.length % 16);
    const process = buf.subarray(0, usable);
    this._pending = Buffer.from(buf.subarray(usable));
    if (!this._autoPadding && this._pending.length) {
      const e = new Error('data length must be a multiple of 16 when autoPadding is disabled');
      e.code = 'ERR_CRYPTO_INVALID_INPUT';
      throw e;
    }
    const out = process.length ? this._processBlocks(process) : Buffer.alloc(0);
    return outputEncoding ? out.toString(outputEncoding) : out;
  }

  final(outputEncoding) {
    if (this._finished) throw new Error('Cipher already finalized');
    this._finished = true;
    let out;
    if (this._autoPadding) {
      const padded = Buffer.from(pad(this._pending));
      out = this._processBlocks(padded);
    } else {
      if (this._pending.length) throw new Error('data length must be a multiple of 16 when autoPadding is disabled');
      out = Buffer.alloc(0);
    }
    if (this._decrypt && this._autoPadding) out = Buffer.from(unpad(out));
    return outputEncoding ? out.toString(outputEncoding) : out;
  }
}

export function createCipheriv(name, key, iv, options) { return new CipherBase(name, key, iv, false, options); }
export function createDecipheriv(name, key, iv, options) { return new CipherBase(name, key, iv, true, options); }

function unsupported(name, feature) {
  return function () {
    const e = new Error(`${name} is not supported in the WebOS browser sandbox (${feature})`);
    e.code = 'ERR_CRYPTO_UNSUPPORTED';
    throw e;
  };
}

export const createSign = unsupported('crypto.createSign', 'no X.509/PKCS#1 implementation');
export const createVerify = unsupported('crypto.createVerify', 'no X.509/PKCS#1 implementation');
export const sign = unsupported('crypto.sign', 'no X.509/PKCS#1 implementation');
export const verify = unsupported('crypto.verify', 'no X.509/PKCS#1 implementation');
export const generateKeyPairSync = unsupported('crypto.generateKeyPairSync', 'no asymmetric key generation');
export const generateKeyPair = unsupported('crypto.generateKeyPair', 'no asymmetric key generation');
export const createECDH = unsupported('crypto.createECDH', 'no elliptic-curve primitives');
export const createDiffieHellman = unsupported('crypto.createDiffieHellman', 'no Diffie-Hellman primitives');

const webcrypto = globalThis.crypto || { getRandomValues, randomUUID };

export const constants = {
  OPENSSL_VERSION_NUMBER: 0x30000000,
  SSL_OP_ALL: 0, SSL_OP_NO_SSLv2: 1, SSL_OP_NO_SSLv3: 2,
  RSA_PKCS1_PADDING: 1, RSA_PKCS1_OAEP_PADDING: 4,
  RSA_NO_PADDING: 3, RSA_PKCS1_PSS_PADDING: 6,
  POINT_CONVERSION_UNCOMPRESSED: 4, POINT_CONVERSION_COMPRESSED: 2,
  DH_CHECK_P_NOT_PRIME: 1, DH_UNABLE_TO_CHECK_GENERATOR: 4,
};

const crypto = {
  createHash, createHmac, getHashes, getCiphers,
  randomBytes, randomFillSync, randomFill, randomUUID, randomInt,
  getRandomValues, timingSafeEqual, pbkdf2Sync, pbkdf2,
  scryptSync, scrypt, createCipheriv, createDecipheriv,
  createSign, createVerify, sign, verify,
  generateKeyPairSync, generateKeyPair, createECDH, createDiffieHellman,
  webcrypto, constants,
  Hash, Hmac,
  subtle: webcrypto.subtle,
  getDiffieHellman: unsupported('crypto.getDiffieHellman', 'no Diffie-Hellman primitives'),
  createSecretKey: (key) => ({ type: 'secret', export: () => Buffer.from(toBytes(key)) }),
  hash: (algo, data, encoding) => createHash(algo).update(data).digest(encoding),
};

export default crypto;
