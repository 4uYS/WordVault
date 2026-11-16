/*
 * Node-compatible streams (Readable / Writable / Duplex / Transform /
 * PassThrough) built on EventEmitter. Chunks are Buffers.
 */

import { EventEmitter } from './events.js';
import { Buffer } from './buffer.js';

function initWritable(stream, opts = {}) {
  stream._writableState = {
    ended: false, writing: false, length: 0, corked: 0, queue: [],
    highWaterMark: opts.highWaterMark ?? 16384, needDrain: false, finished: false,
  };
  stream.writableEnded = false;
  stream.writableFinished = false;
  stream.writable = true;
  stream.writableHighWaterMark = stream._writableState.highWaterMark;
}

function outputChunk(chunk, enc) {
  if (chunk === null || chunk === undefined) return Buffer.alloc(0);
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk, enc || 'utf8');
  return Buffer.from(chunk);
}

export class Stream extends EventEmitter {
  pipe(dest, opts = {}) {
    if (dest && typeof dest.emit === 'function') {
      this.on('data', (chunk) => {
        let ok = true;
        try { ok = dest.write(chunk); } catch (e) { this.destroy?.(e); return; }
        if (ok === false) {
          this.pause?.();
          dest.once('drain', () => this.resume?.());
        }
      });
      this.on('end', () => { if (opts.end !== false) dest.end(); });
      if (opts.end !== false) this.on('error', (e) => dest.destroy?.(e));
    }
    return dest;
  }
}

/* ------------------------------- Readable ------------------------------- */

export class Readable extends Stream {
  constructor(opts = {}) {
    super();
    this._readableState = {
      buffer: [], length: 0, flowing: null, ended: false, endEmitted: false,
      reading: false, objectMode: !!opts.objectMode,
      highWaterMark: opts.highWaterMark ?? 16384, encoding: opts.encoding || null,
    };
    this.readable = true;
    this.destroyed = false;
    if (typeof opts.read === 'function') this._read = opts.read;
  }

  _read() {}

  get readableEnded() { return this._readableState.ended; }
  get readableFlowing() { return this._readableState.flowing; }

  push(chunk, enc) {
    const st = this._readableState;
    if (chunk === null) {
      st.ended = true;
      this._maybeEnd();
      return false;
    }
    if (!st.objectMode) chunk = outputChunk(chunk, enc);
    else if (typeof chunk === 'string') chunk = Buffer.from(chunk);
    st.buffer.push(chunk);
    if (!st.objectMode) st.length += chunk.length;
    if (st.flowing) this._flow();
    else this.emit('readable');
    return st.length < st.highWaterMark;
  }

  unshift(chunk) {
    if (chunk !== null) this._readableState.buffer.unshift(outputChunk(chunk));
    return true;
  }

  _flow() {
    const st = this._readableState;
    while (st.flowing) {
      let chunk;
      if (st.buffer.length) {
        chunk = st.buffer.shift();
        if (!st.objectMode) st.length -= chunk.length;
      } else if (st.ended) {
        break;
      } else {
        chunk = this.read();
        if (chunk === null || !chunk.length) break;
      }
      this.emit('data', chunk);
    }
    this._maybeEnd();
  }

  _maybeEnd() {
    const st = this._readableState;
    if (st.ended && !st.buffer.length && !st.endEmitted) {
      st.endEmitted = true;
      queueMicrotask(() => {
        this.readable = false;
        this.emit('end');
        this.emit('close');
      });
    }
  }

  read(n) {
    const st = this._readableState;
    if (!st.buffer.length) {
      if (!st.ended) {
        if (!st.reading) {
          st.reading = true;
          queueMicrotask(() => { st.reading = false; });
          try { this._read(n); } catch (e) { this.destroy(e); }
        }
        // allow synchronous producers to fill the buffer
        if (!st.buffer.length) return null;
      } else {
        this._maybeEnd();
        return null;
      }
    }
    if (st.objectMode || n == null || n >= st.length) {
      const chunks = st.buffer;
      st.buffer = [];
      st.length = 0;
      return chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    }
    const all = Buffer.concat(st.buffer);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    st.buffer = [Buffer.from(rest)];
    st.length = rest.length;
    return Buffer.from(out);
  }

  resume() {
    const st = this._readableState;
    st.flowing = true;
    queueMicrotask(() => this._flow());
    return this;
  }

  pause() { this._readableState.flowing = false; return this; }

  setEncoding() { return this; }

  on(name, fn) {
    super.on(name, fn);
    if (name === 'data') this.resume();
    return this;
  }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (this._destroy) {
      try { this._destroy(err, () => {}); } catch { /* ignore */ }
    }
    if (err) queueMicrotask(() => this.emit('error', err));
    queueMicrotask(() => this.emit('close'));
    return this;
  }

  async *[Symbol.asyncIterator]() {
    for (;;) {
      const chunk = await new Promise((resolve) => {
        const st = this._readableState;
        if (st.buffer.length) { resolve(this.read()); return; }
        if (st.ended) { resolve(null); return; }
        const onData = (c) => { cleanup(); resolve(c); };
        const onEnd = () => { cleanup(); resolve(null); };
        const onErr = (e) => { cleanup(); rejectLater(e); };
        let rejectLater = () => {};
        const cleanup = () => {
          this.removeListener('data', onData);
          this.removeListener('end', onEnd);
          this.removeListener('error', onErr);
        };
        // convert to pull-based consumption
        this.pause();
        this.once('data', onData);
        this.once('end', onEnd);
        this.once('error', onErr);
        queueMicrotask(() => this.resume());
      });
      if (chunk === null) return;
      yield chunk;
    }
  }

  static from(iterable, opts = {}) {
    const r = new Readable(opts);
    (async () => {
      try {
        for await (const item of iterable) {
          if (r.destroyed) return;
          r.push(item);
          if (!r._readableState.flowing) await new Promise((res) => queueMicrotask(res));
        }
        r.push(null);
      } catch (e) { r.destroy(e); }
    })();
    return r;
  }
}

/* ------------------------------- Writable ------------------------------- */

export class Writable extends Stream {
  constructor(opts = {}) {
    super();
    initWritable(this, opts);
    if (typeof opts.write === 'function') this._write = opts.write;
    if (typeof opts.final === 'function') this._final = opts.final;
    if (typeof opts.destroy === 'function') this._destroy = opts.destroy;
  }

  _write(chunk, enc, cb) { cb(); }
  _final(cb) { cb(); }

  get writableLength() { return this._writableState.length; }
  get writableNeedDrain() { return this._writableState.needDrain; }

  write(chunk, enc, cb) {
    const st = this._writableState;
    if (typeof enc === 'function') { cb = enc; enc = null; }
    if (st.ended || st.finished) {
      const err = new Error('write after end');
      if (typeof cb === 'function') queueMicrotask(() => cb(err));
      else this.emit('error', err);
      return false;
    }
    const data = outputChunk(chunk, enc);
    st.length += data.length;
    st.needDrain = st.length >= st.highWaterMark;
    if (!st.writing && !st.corked) this._doWrite(data, cb);
    else st.queue.push([data, cb]);
    return !st.needDrain;
  }

  _doWrite(data, cb) {
    const st = this._writableState;
    st.writing = true;
    let called = false;
    const done = (err) => {
      if (called) return;
      called = true;
      st.writing = false;
      st.length = Math.max(0, st.length - data.length);
      if (typeof cb === 'function') { try { cb(err); } catch (e) { this.emit('error', e); } }
      if (err) { this.destroy(err); return; }
      if (st.needDrain && st.length < st.highWaterMark) {
        st.needDrain = false;
        this.emit('drain');
      }
      if (st.queue.length && !st.corked) {
        const [c, cback] = st.queue.shift();
        this._doWrite(c, cback);
      } else if (st.ended && !st.writing && !st.queue.length) {
        this._finish();
      }
    };
    try { this._write(data, 'buffer', done); } catch (e) { done(e); }
  }

  cork() { this._writableState.corked++; }
  uncork() {
    const st = this._writableState;
    st.corked = Math.max(0, st.corked - 1);
    if (!st.corked && !st.writing) {
      const next = st.queue.shift();
      if (next) this._doWrite(next[0], next[1]);
      else if (st.ended) this._finish();
    }
  }

  end(chunk, enc, cb) {
    const st = this._writableState;
    if (typeof chunk === 'function') { cb = chunk; chunk = null; }
    if (typeof enc === 'function') { cb = enc; enc = null; }
    if (chunk !== null && chunk !== undefined) this.write(chunk, enc);
    if (cb) this.once('finish', cb);
    st.ended = true;
    this.writableEnded = true;
    if (!st.writing && !st.queue.length) this._finish();
    return this;
  }

  _finish() {
    const st = this._writableState;
    if (st.finished) return;
    st.finished = true;
    const done = (err) => {
      if (err) { this.destroy(err); return; }
      queueMicrotask(() => {
        if (this.destroyed) return;
        this.writableFinished = true;
        this.emit('finish');
        this.emit('close');
      });
    };
    try { this._final(done); } catch (e) { done(e); }
  }

  setDefaultEncoding() { return this; }

  destroy(err) {
    if (this.destroyed) return this;
    this.destroyed = true;
    if (this._destroy) { try { this._destroy(err, () => {}); } catch { /* ignore */ } }
    if (err) queueMicrotask(() => this.emit('error', err));
    queueMicrotask(() => this.emit('close'));
    return this;
  }
}

/* ---------------------------- Duplex / Transform ---------------------------- */

export class Duplex extends Readable {
  constructor(opts = {}) {
    super(opts);
    initWritable(this, opts);
  }
}

for (const name of ['write', 'end', 'cork', 'uncork', 'setDefaultEncoding', '_doWrite', '_finish']) {
  Object.defineProperty(Duplex.prototype, name, {
    value: Writable.prototype[name], writable: true, configurable: true,
  });
}
Object.defineProperty(Duplex.prototype, 'destroy', {
  value: function destroy(err) {
    Writable.prototype.destroy.call(this, err);
    return this;
  }, writable: true, configurable: true,
});

export class Transform extends Duplex {
  constructor(opts = {}) {
    super(opts);
    if (typeof opts.transform === 'function') this._transform = opts.transform;
    if (typeof opts.flush === 'function') this._flush = opts.flush;
  }

  _write(chunk, enc, cb) {
    let called = false;
    const done = (err, data) => {
      if (called) return;
      called = true;
      if (err) { cb(err); return; }
      if (data !== null && data !== undefined) this.push(data);
      cb();
    };
    try { this._transform(chunk, enc, done); } catch (e) { done(e); }
  }

  _read() {}

  _final(cb) {
    if (typeof this._flush !== 'function') { this.push(null); cb(); return; }
    this._flush((err, data) => {
      if (err) { cb(err); return; }
      if (data !== null && data !== undefined) this.push(data);
      this.push(null);
      cb();
    });
  }

  _transform(chunk, enc, cb) { cb(null, chunk); }
}

export class PassThrough extends Transform {}

/* ----------------------------- helpers ----------------------------- */

export function finished(stream, cb) {
  let done = false;
  const cleanup = () => {
    stream.removeListener?.('end', onEnd);
    stream.removeListener?.('finish', onFinish);
    stream.removeListener?.('error', onError);
    stream.removeListener?.('close', onClose);
  };
  const settle = (err) => {
    if (done) return;
    done = true;
    cleanup();
    cb(err || null);
  };
  const onEnd = () => settle();
  const onFinish = () => settle();
  const onError = (err) => settle(err);
  const onClose = () => { if (stream._readableState?.ended || stream._writableState?.finished) settle(); };
  stream.on('end', onEnd);
  stream.on('finish', onFinish);
  stream.on('error', onError);
  stream.on('close', onClose);
  return () => { done = true; cleanup(); };
}

export function pipeline(...args) {
  let cb = null;
  if (typeof args[args.length - 1] === 'function') cb = args.pop();
  const streams = args.flat();
  const promise = new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      if (cb) cb(err); else reject(err);
    };
    const ok = () => {
      if (settled) return;
      settled = true;
      if (cb) cb(null); else resolve();
    };
    for (const s of streams) s.on?.('error', fail);
    const last = streams[streams.length - 1];
    if (last) { last.on('finish', ok); last.on('end', ok); }
    else { ok(); return; }
    for (let i = 0; i < streams.length - 1; i++) streams[i].pipe(streams[i + 1]);
  });
  return cb ? streams[streams.length - 1] : promise;
}

export default Stream;
