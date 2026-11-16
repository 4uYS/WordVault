/*
 * Network modules. HTTP(S) clients are implemented over `fetch`. Anything
 * requiring listening sockets (servers, TCP, UDP, TLS termination) fails with
 * explicit, specific errors instead of pretending to work.
 */

import { EventEmitter } from './events.js';
import { Readable } from './stream.js';
import { Buffer } from './buffer.js';

const err = (message, code) => {
  const e = new Error(message);
  e.code = code;
  return e;
};

/* --------------------------------- http --------------------------------- */

class IncomingMessage extends Readable {
  constructor(statusCode, statusMessage, headers, body, url) {
    super();
    this.statusCode = statusCode;
    this.statusMessage = statusMessage;
    this.headers = headers;
    this.rawHeaders = Object.entries(headers).flat();
    this.httpVersion = '1.1';
    this.httpVersionMajor = 1;
    this.httpVersionMinor = 1;
    this.complete = false;
    this.url = url || '';
    this.method = null;
    this._body = body;
    this._delivered = false;
  }
  _read() {
    if (this._delivered) return;
    this._delivered = true;
    queueMicrotask(() => {
      if (this._body && this._body.length) this.push(this._body);
      this.complete = true;
      this.push(null);
    });
  }
  setTimeout(ms, cb) { if (cb) this.once('timeout', cb); return this; }
}

class ClientRequest extends EventEmitter {
  constructor(options, cb) {
    super();
    this.method = (options.method || 'GET').toUpperCase();
    this.path = options.path || '/';
    this.headers = { ...(options.headers || {}) };
    this.host = options.hostname || options.host || 'localhost';
    this.port = options.port || (options.protocol === 'https:' ? 443 : 80);
    this.protocol = options.protocol || 'http:';
    this._chunks = [];
    this._ended = false;
    this._aborted = false;
    this.res = null;
    this.socket = null;
    this.aborted = false;
    if (typeof cb === 'function') this.once('response', cb);
  }
  setHeader(name, value) { this.headers[name] = value; return this; }
  getHeader(name) { return this.headers[name]; }
  getHeaders() { return { ...this.headers }; }
  removeHeader(name) { delete this.headers[name]; }
  flushHeaders() {}
  setTimeout(ms, cb) { if (typeof cb === 'function') this.once('timeout', cb); return this; }
  setNoDelay() { return this; }
  setSocketKeepAlive() { return this; }
  write(chunk, encoding, cb) {
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    this._chunks.push(Buffer.from(chunk, encoding));
    if (typeof cb === 'function') queueMicrotask(() => cb(null));
    return true;
  }
  end(chunk, encoding, cb) {
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; }
    if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    if (typeof cb === 'function') this.once('finish', cb);
    this._send();
    return this;
  }
  _send() {
    if (this._ended) return;
    this._ended = true;
    const fetchFn = globalThis.fetch;
    const url = `${this.protocol}//${this.host}${this.port && !String(this.host).includes(':') && !(this.protocol === 'http:' && Number(this.port) === 80) && !(this.protocol === 'https:' && Number(this.port) === 443) ? ':' + this.port : ''}${this.path}`;
    if (typeof fetchFn !== 'function') {
      queueMicrotask(() => this.emit('error', err(
        'fetch() is unavailable in this environment; HTTP requests cannot be made. The WebOS sandbox requires a host fetch implementation.',
        'ENETUNREACH',
      )));
      return;
    }
    const init = { method: this.method, headers: this.headers };
    if (this._chunks.length && this.method !== 'GET' && this.method !== 'HEAD') init.body = Buffer.concat(this._chunks);
    fetchFn(url, init).then(async (res) => {
      if (this._aborted) return;
      const headers = {};
      res.headers.forEach((v, k) => { headers[k] = v; });
      const body = Buffer.from(await res.arrayBuffer());
      const incoming = new IncomingMessage(res.status, res.statusText, headers, body, url);
      incoming.method = this.method;
      this.res = incoming;
      this.emit('response', incoming);
      this.emit('finish');
    }).catch((e) => {
      if (this._aborted) return;
      const wrapped = err(`request to ${url} failed: ${e.message}`, 'ENETUNREACH');
      wrapped.cause = e;
      this.emit('error', wrapped);
    });
  }
  abort() {
    if (this._aborted) return;
    this._aborted = true;
    this.aborted = true;
    this.emit('abort');
    this.emit('close');
  }
  destroy(e) { if (e) this.emit('error', e); this.abort(); return this; }
}

function normalizeRequestArgs(input, options, cb) {
  let opts = {};
  if (typeof input === 'string' || (typeof URL !== 'undefined' && input instanceof URL)) {
    const u = new URL(String(input));
    opts = {
      protocol: u.protocol, hostname: u.hostname, port: u.port || undefined,
      path: u.pathname + u.search, method: 'GET',
    };
    if (u.username) {
      const token = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
      opts.headers = { authorization: `Basic ${token}` };
    }
  } else if (input && typeof input === 'object') {
    opts = { ...input };
  }
  if (typeof options === 'function') cb = options;
  else if (options && typeof options === 'object') Object.assign(opts, options);
  return { opts, cb };
}

export function createHttpModules() {
  function request(...args) {
    const { opts, cb } = normalizeRequestArgs(...args);
    return new ClientRequest(opts, cb);
  }
  function get(...args) {
    const req = request(...args);
    req.end();
    return req;
  }
  function createServer() {
    throw err(
      'http.createServer is not supported in the browser sandbox: listening sockets cannot be created. Outbound fetch() based clients are available via http.request/http.get.',
      'ERR_LISTEN_UNSUPPORTED',
    );
  }
  const http = {
    request, get, createServer,
    Agent: class Agent { constructor(o = {}) { this.options = o; } destroy() {} },
    globalAgent: { destroy() {} },
    STATUS_CODES: {
      200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently',
      302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized',
      403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
      500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable',
    },
    METHODS: ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'OPTIONS', 'PATCH'],
    IncomingMessage, ClientRequest,
    validateHeaderName: (name) => { if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new TypeError(`Invalid header name: ${name}`); },
    validateHeaderValue: (name, value) => { if (value === undefined) throw new TypeError(`Invalid value for header "${name}"`); },
  };
  const https = { ...http, protocol: 'https:' };
  return { http, https };
}

/* ---------------------------------- net ---------------------------------- */

function failingSocket(message) {
  const s = new EventEmitter();
  s.connecting = true;
  s.destroyed = false;
  s.remoteAddress = undefined;
  s.connect = () => s;
  s.setEncoding = () => s;
  s.setTimeout = (ms, cb) => { if (cb) s.once('timeout', cb); return s; };
  s.setNoDelay = () => s;
  s.setKeepAlive = () => s;
  s.write = () => false;
  s.end = () => s;
  s.pause = () => s;
  s.resume = () => s;
  s.destroy = () => { s.destroyed = true; };
  s.ref = () => s;
  s.unref = () => s;
  queueMicrotask(() => { s.connecting = false; s.emit('error', err(message, 'ENETUNREACH')); });
  return s;
}

const listenError = (name) => () => {
  throw err(
    `${name} is not supported in the browser sandbox: listening sockets cannot be created.`,
    'ERR_LISTEN_UNSUPPORTED',
  );
};

export const net = {
  createServer: listenError('net.createServer'),
  createConnection: () => failingSocket('connect ENETUNREACH: outbound TCP sockets are not available in the browser sandbox'),
  connect: () => failingSocket('connect ENETUNREACH: outbound TCP sockets are not available in the browser sandbox'),
  isIP: (s) => (/^\d{1,3}(\.\d{1,3}){3}$/.test(s) ? 4 : /^[0-9a-f:]+$/i.test(s) && s.includes(':') ? 6 : 0),
  isIPv4: (s) => /^\d{1,3}(\.\d{1,3}){3}$/.test(s),
  isIPv6: (s) => /^[0-9a-f:]+$/i.test(s) && s.includes(':'),
  Socket: class Socket extends EventEmitter {
    constructor() { super(); this.destroyed = false; }
    connect() { queueMicrotask(() => this.emit('error', err('connect ENETUNREACH: outbound TCP sockets are not available in the browser sandbox', 'ENETUNREACH'))); return this; }
    write() { return false; }
    end() { return this; }
    destroy() { this.destroyed = true; }
    setTimeout() { return this; }
    setNoDelay() { return this; }
    setKeepAlive() { return this; }
  },
  Server: class Server extends EventEmitter {
    listen() { throw err('net.Server.listen is not supported in the browser sandbox: listening sockets cannot be created.', 'ERR_LISTEN_UNSUPPORTED'); }
    close() {}
  },
};

export const tls = {
  createServer: listenError('tls.createServer'),
  connect: () => failingSocket('connect ENETUNREACH: TLS sockets are not available in the browser sandbox'),
  createSecureContext: () => ({}),
  TLSSocket: class TLSSocket extends EventEmitter { connect() { return failingSocket('connect ENETUNREACH: TLS sockets are not available in the browser sandbox'); } },
  DEFAULT_MIN_VERSION: 'TLSv1.2',
  DEFAULT_MAX_VERSION: 'TLSv1.3',
};

export function createDgram() {
  function createSocket(type) {
    const s = new EventEmitter();
    s.type = type || 'udp4';
    s.bind = (port, address, cb) => {
      const callback = [port, address, cb].find((x) => typeof x === 'function');
      s.address = () => ({ address: '0.0.0.0', family: type === 'udp6' ? 'IPv6' : 'IPv4', port: typeof port === 'number' ? port : 0 });
      if (callback) queueMicrotask(() => callback());
      return s;
    };
    s.send = (...sendArgs) => {
      const callback = sendArgs.find((x) => typeof x === 'function');
      const e = err('dgram.send is not supported in the browser sandbox: UDP sockets are unavailable', 'ENETUNREACH');
      if (callback) queueMicrotask(() => callback(e));
      else queueMicrotask(() => s.emit('error', e));
    };
    s.close = (cb) => { if (cb) queueMicrotask(() => cb()); s.emit('close'); };
    s.address = () => ({ address: '0.0.0.0', family: 'IPv4', port: 0 });
    s.setBroadcast = () => {};
    s.setTTL = () => {};
    s.addMembership = () => {};
    s.dropMembership = () => {};
    s.ref = () => s;
    s.unref = () => s;
    return s;
  }
  return { createSocket, Socket: class Socket extends EventEmitter {} };
}

export const dgram = createDgram();

/* ---------------------------------- dns ---------------------------------- */

function makeLookup(cbStyle = true) {
  const lookup = (hostname, options, cb) => {
    if (typeof options === 'function') { cb = options; options = {}; }
    options = options || {};
    queueMicrotask(() => {
      if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        cb(null, options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1', 4);
      } else {
        const e = err(`getaddrinfo ENOTFOUND ${hostname}: DNS resolution is not available in the browser sandbox`, 'ENOTFOUND');
        e.hostname = hostname;
        cb(e);
      }
    });
  };
  return lookup;
}

const notResolvable = (hostname) => err(`getaddrinfo ENOTFOUND ${hostname}: DNS resolution is not available in the browser sandbox`, 'ENOTFOUND');

const lookup = makeLookup();

export const dnsModule = {
  lookup,
  lookupService: (address, port, cb) => queueMicrotask(() => cb(notResolvable(address))),
  resolve: (hostname, rrtype, cb) => {
    if (typeof rrtype === 'function') cb = rrtype;
    queueMicrotask(() => cb(notResolvable(hostname)));
  },
  resolve4: (h, o, cb) => { if (typeof o === 'function') cb = o; queueMicrotask(() => cb(notResolvable(h))); },
  resolve6: (h, o, cb) => { if (typeof o === 'function') cb = o; queueMicrotask(() => cb(notResolvable(h))); },
  resolveAny: (h, cb) => queueMicrotask(() => cb(notResolvable(h))),
  resolveCname: (h, cb) => queueMicrotask(() => cb(notResolvable(h))),
  resolveMx: (h, cb) => queueMicrotask(() => cb(notResolvable(h))),
  resolveTxt: (h, cb) => queueMicrotask(() => cb(notResolvable(h))),
  resolveSrv: (h, cb) => queueMicrotask(() => cb(notResolvable(h))),
  reverse: (ip, cb) => queueMicrotask(() => cb(notResolvable(ip))),
  getServers: () => [],
  setServers: () => {},
  promises: {
    lookup: (hostname, options = {}) => new Promise((resolve, reject) => {
      lookup(hostname, options, (e, address, family) => {
        if (e) reject(e);
        else resolve(options.all ? address : { address, family });
      });
    }),
    resolve: async (h) => { throw notResolvable(h); },
    resolve4: async (h) => { throw notResolvable(h); },
    resolve6: async (h) => { throw notResolvable(h); },
    reverse: async (ip) => { throw notResolvable(ip); },
    getServers: () => [],
    setServers: () => {},
  },
};

export const httpModule = createHttpModules();
