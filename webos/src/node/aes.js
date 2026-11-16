/*
 * Minimal pure-JS AES (128/192/256) with CBC mode and PKCS#7 padding.
 * Supports what Node's createCipheriv('aes-*-cbc') exposes for buffers.
 */

/* Build S-box / inverse S-box from GF(2^8) inversion + affine transform. */
const SBOX = new Uint8Array(256);
const INV_SBOX = new Uint8Array(256);
(function buildSboxes() {
  const inv = new Uint8Array(256);
  let p = 1, q = 1;
  do {
    p = (p ^ (p << 1) ^ ((p & 0x80) ? 0x1b : 0)) & 0xff;
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff;
    if (q & 0x80) q ^= 0x09;
    inv[p] = q;
  } while (p !== 1);
  const rot = (x, n) => ((x << n) | (x >> (8 - n))) & 0xff;
  for (let i = 0; i < 256; i++) {
    const s = inv[i];
    const v = (s ^ rot(s, 1) ^ rot(s, 2) ^ rot(s, 3) ^ rot(s, 4) ^ 0x63) & 0xff;
    SBOX[i] = v;
    INV_SBOX[v] = i;
  }
})();

const RCON = [0, 1, 2, 4, 8, 16, 32, 64, 128, 27, 54];

const xtime = (a) => ((a << 1) ^ ((a & 0x80) ? 0x1b : 0)) & 0xff;
function mul(a, b) {
  let r = 0;
  while (b) { if (b & 1) r ^= a; a = xtime(a); b >>= 1; }
  return r & 0xff;
}

function expandKey(key) {
  const nk = key.length / 4;
  if (nk !== 4 && nk !== 6 && nk !== 8) throw new Error('Invalid key length: AES key must be 16, 24 or 32 bytes');
  const nr = nk + 6;
  const words = [];
  for (let i = 0; i < nk; i++) words.push([key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]]);
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = words[i - 1].slice();
    if (i % nk === 0) {
      t = [t[1], t[2], t[3], t[0]].map((b) => SBOX[b]);
      t[0] ^= RCON[i / nk];
    } else if (nk > 6 && i % nk === 4) {
      t = t.map((b) => SBOX[b]);
    }
    const prev = words[i - nk];
    words.push([prev[0] ^ t[0], prev[1] ^ t[1], prev[2] ^ t[2], prev[3] ^ t[3]]);
  }
  const roundKeys = new Uint8Array(16 * (nr + 1));
  for (let i = 0; i < 4 * (nr + 1); i++) roundKeys.set(words[i], i * 4);
  return { roundKeys, nr, nk };
}

function addRoundKey(s, rk, round) {
  const off = round * 16;
  for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
}

function subBytes(s, box) {
  for (let i = 0; i < 16; i++) s[i] = box[s[i]];
}

function shiftRows(s, inverse) {
  // state[r + 4c]; row r is rotated
  const t = s.slice();
  for (let r = 1; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const from = (c + (inverse ? 4 - r : r)) % 4;
      s[r + 4 * c] = t[r + 4 * from];
    }
  }
}

function mixColumns(s, inverse) {
  for (let c = 0; c < 4; c++) {
    const i = 4 * c;
    const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
    if (!inverse) {
      s[i] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3;
      s[i + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3;
      s[i + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3);
      s[i + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2);
    } else {
      s[i] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9);
      s[i + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13);
      s[i + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11);
      s[i + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14);
    }
  }
}

export function encryptBlock(block, key) {
  const { roundKeys, nr } = expandKey(key);
  const s = Uint8Array.from(block);
  addRoundKey(s, roundKeys, 0);
  for (let round = 1; round < nr; round++) {
    subBytes(s, SBOX);
    shiftRows(s, false);
    mixColumns(s, false);
    addRoundKey(s, roundKeys, round);
  }
  subBytes(s, SBOX);
  shiftRows(s, false);
  addRoundKey(s, roundKeys, nr);
  return s;
}

export function decryptBlock(block, key) {
  const { roundKeys, nr } = expandKey(key);
  const s = Uint8Array.from(block);
  addRoundKey(s, roundKeys, nr);
  for (let round = nr - 1; round > 0; round--) {
    shiftRows(s, true);
    subBytes(s, INV_SBOX);
    addRoundKey(s, roundKeys, round);
    mixColumns(s, true);
  }
  shiftRows(s, true);
  subBytes(s, INV_SBOX);
  addRoundKey(s, roundKeys, 0);
  return s;
}

function ensureKey(key) {
  if (!(key instanceof Uint8Array)) key = new Uint8Array(key);
  if (key.length !== 16 && key.length !== 24 && key.length !== 32) {
    throw new Error(`Invalid key length: ${key.length}. aes-128/192/256-cbc requires 16, 24 or 32 bytes`);
  }
  return key;
}

function ensureIv(iv) {
  if (!(iv instanceof Uint8Array)) iv = new Uint8Array(iv);
  if (iv.length !== 16) throw new Error(`Invalid IV length: ${iv.length}. CBC requires a 16-byte IV`);
  return iv;
}

export function pad(buf) {
  const n = 16 - (buf.length % 16 || 16);
  const size = buf.length % 16 === 0 ? 16 : n;
  const out = new Uint8Array(buf.length + size);
  out.set(buf);
  out.fill(size, buf.length);
  return out;
}

export function unpad(buf) {
  if (!buf.length || buf.length % 16 !== 0) return buf;
  const n = buf[buf.length - 1];
  if (n < 1 || n > 16) return buf;
  for (let i = buf.length - n; i < buf.length; i++) if (buf[i] !== n) return buf;
  return buf.subarray(0, buf.length - n);
}

export function aesCbcEncrypt(key, iv, data, autoPadding = true) {
  key = ensureKey(key); iv = ensureIv(iv);
  const input = autoPadding ? pad(data) : data;
  if (input.length % 16) throw new Error('data length must be a multiple of 16 when autoPadding is disabled');
  const out = new Uint8Array(input.length);
  let prev = Uint8Array.from(iv);
  for (let off = 0; off < input.length; off += 16) {
    const block = new Uint8Array(16);
    for (let i = 0; i < 16; i++) block[i] = input[off + i] ^ prev[i];
    prev = encryptBlock(block, key);
    out.set(prev, off);
  }
  return out;
}

export function aesCbcDecrypt(key, iv, data, autoPadding = true) {
  key = ensureKey(key); iv = ensureIv(iv);
  if (data.length % 16) throw new Error('data length must be a multiple of 16 for aes-cbc decryption');
  if (!data.length) return new Uint8Array(0);
  const out = new Uint8Array(data.length);
  let prev = Uint8Array.from(iv);
  for (let off = 0; off < data.length; off += 16) {
    const cipher = data.subarray(off, off + 16);
    const plain = decryptBlock(cipher, key);
    for (let i = 0; i < 16; i++) out[off + i] = plain[i] ^ prev[i];
    prev = Uint8Array.from(cipher);
  }
  return autoPadding ? unpad(out) : out;
}
