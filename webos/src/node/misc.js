/* Assorted small builtins: url, querystring, tty, StringDecoder, punycode,
 * domain, perf_hooks, timers, timers/promises and constants. */

import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';

/* --------------------------------- url --------------------------------- */

export const URL = globalThis.URL;
export const URLSearchParams = globalThis.URLSearchParams;

export function fileURLToPath(input) {
  const u = typeof input === 'string' ? new URL(input) : input;
  if (u.protocol !== 'file:') throw new TypeError('The URL must be of scheme file');
  let pathname = decodeURIComponent(u.pathname);
  if (u.hostname) pathname = `//${u.hostname}${pathname}`;
  return pathname;
}

export function pathToFileURL(path) {
  let p = String(path);
  if (!p.startsWith('/')) p = '/' + p;
  const u = new URL('file://');
  u.pathname = p;
  return u;
}

export function urlFormat(target) {
  if (target instanceof URL) return target.toString();
  if (!target || typeof target !== 'object') throw new TypeError('The "urlObject" argument must be an object');
  const protocol = target.protocol ? (target.protocol.endsWith(':') ? target.protocol : target.protocol + ':') : '';
  const slashes = target.slashes || (protocol && target.host) ? '//' : '';
  const auth = target.auth ? `${target.auth}@` : '';
  const host = target.host || (target.hostname ? target.hostname + (target.port ? ':' + target.port : '') : '');
  const pathname = target.pathname || '';
  const search = target.search || (target.query && typeof target.query === 'object' ? '?' + new URLSearchParams(target.query) : '');
  const hash = target.hash || '';
  return `${protocol}${slashes}${auth}${host}${pathname}${search}${hash}`;
}

export function urlParse(input, parseQueryString = false) {
  const u = new URL(input);
  const query = parseQueryString ? Object.fromEntries(u.searchParams) : u.search.replace(/^\?/, '');
  return {
    protocol: u.protocol,
    slashes: true,
    auth: u.username ? `${u.username}:${u.password}` : null,
    host: u.host,
    port: u.port || null,
    hostname: u.hostname,
    hash: u.hash || null,
    search: u.search || null,
    query,
    pathname: u.pathname,
    path: u.pathname + u.search,
    href: u.href,
  };
}

export function urlResolve(from, to) {
  return new URL(to, from).href;
}

export function domainToASCII(domain) {
  try { return new URL(`http://${domain}`).hostname; } catch { return ''; }
}

export function domainToUnicode(domain) {
  try {
    const host = new URL(`http://${domain}`).hostname;
    return decodeURIComponent(host.replace(/^xn--/gm, ''));
  } catch { return ''; }
}

export const urlModule = {
  URL, URLSearchParams, fileURLToPath, pathToFileURL,
  format: urlFormat, parse: urlParse, resolve: urlResolve,
  domainToASCII, domainToUnicode,
};

/* ------------------------------ querystring ------------------------------ */

function qsEscape(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function qsUnescape(str) {
  try { return decodeURIComponent(str.replace(/\+/g, ' ')); } catch { return str; }
}

function qsParse(str, sep = '&', eq = '=') {
  const out = Object.create(null);
  if (!str) return out;
  for (const part of String(str).split(sep)) {
    if (!part) continue;
    const idx = part.indexOf(eq);
    const key = qsUnescape(idx >= 0 ? part.slice(0, idx) : part);
    const value = idx >= 0 ? qsUnescape(part.slice(idx + eq.length)) : '';
    if (key in out) out[key] = [].concat(out[key], value);
    else out[key] = value;
  }
  return out;
}

function qsStringify(obj, sep = '&', eq = '=') {
  if (!obj || typeof obj !== 'object') return '';
  const parts = [];
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const list = Array.isArray(value) ? value : [value];
    for (const v of list) {
      parts.push(qsEscape(key) + eq + qsEscape(v === undefined || v === null ? '' : typeof v === 'object' ? '[object Object]' : v));
    }
  }
  return parts.join(sep);
}

export const querystring = {
  parse: qsParse, decode: qsParse,
  stringify: qsStringify, encode: qsStringify,
  escape: qsEscape, unescape: qsUnescape,
};

/* --------------------------------- tty --------------------------------- */

class TtyReadStream extends EventEmitter {
  constructor(fd) {
    super();
    this.fd = fd;
    this.isTTY = false;
    this.isRaw = false;
  }
  setRawMode(mode) { this.isRaw = !!mode; return this; }
  setEncoding() { return this; }
  pause() { return this; }
  resume() { return this; }
  ref() { return this; }
  unref() { return this; }
}

class TtyWriteStream extends EventEmitter {
  constructor(fd) { super(); this.fd = fd; this.isTTY = false; this.columns = 80; this.rows = 24; }
  write() { return true; }
  end() {}
  clearLine() { return true; }
  cursorTo() { return true; }
  moveCursor() { return true; }
  getColorDepth() { return 1; }
  hasColors() { return false; }
  getWindowSize() { return [80, 24]; }
  ref() { return this; }
  unref() { return this; }
}

export const tty = {
  isatty: () => false,
  ReadStream: TtyReadStream,
  WriteStream: TtyWriteStream,
  getColorDepth: () => 1,
  hasColors: () => false,
};

/* ----------------------------- StringDecoder ----------------------------- */

export class StringDecoder {
  constructor(encoding = 'utf8') {
    this.encoding = String(encoding).toLowerCase();
    this._decoder = this.encoding === 'utf8' || this.encoding === 'utf-8'
      ? new TextDecoder('utf-8') : null;
    this.lastChar = '';
  }
  write(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this._decoder) {
      const s = this._decoder.decode(bytes, { stream: true });
      this.lastChar = s;
      return s;
    }
    return bytes.toString(this.encoding);
  }
  end(chunk) {
    const head = chunk ? this.write(chunk) : '';
    const tail = this._decoder ? this._decoder.decode() : '';
    this.lastChar = head + tail;
    return head + tail;
  }
}

/* ------------------------------- punycode ------------------------------- */

export const punycode = {
  toASCII: (s) => domainToASCII(s) || String(s),
  toUnicode: (s) => {
    try { return decodeURIComponent(new URL(`http://${s}`).hostname); } catch { return String(s); }
  },
  encode: (s) => domainToASCII(s) || String(s),
  decode: (s) => {
    try { return decodeURIComponent(new URL(`http://${s}`).hostname); } catch { return String(s); }
  },
  ucs2: {
    decode: (s) => Array.from(s).map((c) => c.codePointAt(0)),
    encode: (arr) => String.fromCodePoint(...arr),
  },
};

/* -------------------------------- domain -------------------------------- */

export const domain = {
  create() {
    const d = new EventEmitter();
    d.members = [];
    d.run = (fn, ...args) => fn(...args);
    d.add = (e) => { d.members.push(e); return d; };
    d.remove = (e) => { d.members = d.members.filter((x) => x !== e); return d; };
    d.bind = (fn) => fn;
    d.intercept = (fn) => fn;
    d.dispose = () => d;
    d.enter = () => d;
    d.exit = () => d;
    d.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(d);
    return d;
  },
  active: null,
};

/* ------------------------------- perf_hooks ------------------------------- */

const timeOrigin = Date.now();
const performanceImpl = (() => {
  const host = globalThis.performance || {};
  const perf = {
    now: host.now ? () => host.now() : () => Date.now() - timeOrigin,
    timeOrigin: host.timeOrigin || timeOrigin,
    mark: host.mark ? host.mark.bind(host) : () => {},
    measure: host.measure ? host.measure.bind(host) : () => {},
    getEntries: host.getEntries ? host.getEntries.bind(host) : () => [],
    getEntriesByName: host.getEntriesByName ? host.getEntriesByName.bind(host) : () => [],
    getEntriesByType: host.getEntriesByType ? host.getEntriesByType.bind(host) : () => [],
    clearMarks: () => {},
    clearMeasures: () => {},
    toJSON: () => ({ timeOrigin: host.timeOrigin || timeOrigin }),
  };
  return perf;
})();

export class PerformanceObserver {
  constructor(cb) { this._cb = cb; }
  observe() {}
  disconnect() {}
  takeRecords() { return []; }
  static get supportedEntryTypes() { return []; }
}

export const perf_hooks = {
  performance: performanceImpl,
  PerformanceObserver,
  monitorEventLoopDelay: () => ({ enable() {}, disable() {}, reset() {}, percentile: () => 0, mean: 0, max: 0, min: 0 }),
  createHistogram: () => ({ record() {}, reset() {}, percentile: () => 0, mean: 0, max: 0, min: 0 }),
  constants: { NODE_PERFORMANCE_GC_MAJOR: 4, NODE_PERFORMANCE_GC_MINOR: 1 },
};

/* -------------------------------- timers -------------------------------- */

export const timers = {
  setTimeout: (...a) => setTimeout(...a),
  clearTimeout: (...a) => clearTimeout(...a),
  setInterval: (...a) => setInterval(...a),
  clearInterval: (...a) => clearInterval(...a),
  setImmediate: (...a) => setImmediate(...a),
  clearImmediate: (...a) => clearImmediate(...a),
  enroll: () => {},
  unenroll: () => {},
  active: () => [],
  _unrefActive: () => {},
};

const timersPromises = {
  setTimeout: (delay = 1, value, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason || new Error('The operation was aborted')); return; }
    const t = setTimeout(() => resolve(value), delay);
    options.signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(options.signal.reason || new Error('The operation was aborted')); }, { once: true });
  }),
  setImmediate: (value, options = {}) => new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(options.signal.reason || new Error('The operation was aborted')); return; }
    setImmediate(() => resolve(value));
  }),
  setInterval: async function* (delay = 1, value, options = {}) {
    for (;;) {
      if (options.signal?.aborted) return;
      await new Promise((r) => setTimeout(r, delay));
      yield value;
    }
  },
};
export { timersPromises };

/* ------------------------------- constants ------------------------------- */

export const constants = {
  F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512,
  O_APPEND: 1024, O_SYMLINK: 2097152, O_NOFOLLOW: 131072, O_DIRECTORY: 65536,
  S_IFMT: 0o170000, S_IFREG: 0o100000, S_IFDIR: 0o040000, S_IFLNK: 0o120000,
  S_IFCHR: 0o020000, S_IFBLK: 0o060000, S_IFIFO: 0o010000, S_IFSOCK: 0o140000,
  SIGTERM: 15, SIGKILL: 9, SIGINT: 2, SIGHUP: 1,
  ENOENT: 2, EACCES: 13, EEXIST: 17, ENOTDIR: 20, EISDIR: 21, EINVAL: 22,
  COPYFILE_EXCL: 1, COPYFILE_FICLONE: 2, COPYFILE_FICLONE_FORCE: 4,
};
