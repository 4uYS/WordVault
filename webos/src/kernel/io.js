/* Byte channels, sources and sinks used by the shell, commands and Node streams. */

const enc = new TextEncoder();

export function toBytes(data) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return enc.encode(String(data));
}

export function concatBytes(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

export const decode = (b) => new TextDecoder().decode(b);

/** An in-memory byte pipe with close propagation. */
export class Channel {
  constructor() {
    this.chunks = [];
    this.ended = false;
    this.writeClosed = false;
    this.error = null;
    this._waiter = null;
    this._onWriterGone = null;
  }
  write(data) {
    if (this.writeClosed || this.ended) return false;
    const b = toBytes(data);
    if (!b.length) return true;
    this.chunks.push(b);
    this._wake();
    return true;
  }
  end() {
    if (this.ended) return;
    this.ended = true;
    this._wake();
  }
  fail(err) {
    this.error = err;
    this.end();
  }
  /** Consumer stopped reading: signal EPIPE to the writer. */
  closeRead() {
    if (this.writeClosed) return;
    this.writeClosed = true;
    if (this._onWriterGone) { try { this._onWriterGone(); } catch { /* noop */ } }
    this.chunks.length = 0;
  }
  get closed() { return this.writeClosed; }
  _wake() {
    if (this._waiter) { const w = this._waiter; this._waiter = null; w(); }
  }
  async read() {
    // concatenate available data for fewer wakeups
    while (!this.chunks.length) {
      if (this.error) throw this.error;
      if (this.ended) return null;
      await new Promise((r) => { this._waiter = r; });
    }
    if (this.chunks.length === 1) return this.chunks.shift();
    const all = concatBytes(this.chunks);
    this.chunks.length = 0;
    return all;
  }
  async collect() {
    const out = [];
    for (;;) {
      const c = await this.read();
      if (c === null) break;
      out.push(c);
    }
    return concatBytes(out);
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const c = await this.read();
      if (c === null) return;
      yield c;
    }
  }
}

/** A readable source. Implements async iteration + read(). */
export class Source {
  constructor(read, closeRead) {
    this._read = read;
    this._closeRead = closeRead || (() => {});
    this._buffer = null;
    this._ended = false;
  }
  async read() {
    if (this._buffer) { const b = this._buffer; this._buffer = null; return b; }
    if (this._ended) return null;
    return this._read();
  }
  async *[Symbol.asyncIterator]() {
    for (;;) {
      const c = await this.read();
      if (c === null) return;
      yield c;
    }
  }
  closeRead() { try { this._closeRead(); } catch { /* noop */ } }
  async collect() {
    const out = [];
    for await (const c of this) out.push(c);
    return concatBytes(out);
  }
}

export class Sink {
  constructor(write, end, closed) {
    this._write = write;
    this._end = end || (() => {});
    this._closed = closed || (() => false);
  }
  write(data) { return this._write(toBytes(data)); }
  end() { this._end(); }
  get closed() { return this._closed(); }
}

export function sourceFromBytes(data) {
  let done = false;
  return new Source(async () => {
    if (done) return null;
    done = true;
    const b = toBytes(data);
    return b.length ? b : null;
  });
}

export function sourceFromText(text) { return sourceFromBytes(text); }

export function sourceFromAsyncIterable(iterable) {
  const it = iterable[Symbol.asyncIterator] ? iterable[Symbol.asyncIterator]() : iterable[Symbol.iterator]();
  return new Source(async () => {
    const r = await it.next();
    if (r.done) return null;
    return toBytes(r.value);
  });
}

export function sourceFromChannel(ch) {
  return new Source(() => ch.read(), () => ch.closeRead());
}

/** Source over a VFS file handle, streaming 64 KiB blocks. */
export function sourceFromFile(handle) {
  return new Source(async () => {
    if (handle.device === 'zero') return new Uint8Array(65536);
    if (handle.device === 'null' || handle.device === 'full') return null;
    if (handle.device === 'random' || handle.device === 'urandom') {
      const b = new Uint8Array(65536); globalThis.crypto.getRandomValues(b); return b;
    }
    const b = handle.read(65536);
    return b.length ? b : null;
  }, () => { try { handle.close(); } catch { /* noop */ } });
}

export function channelSourcePipe(ch, sink) {
  (async () => {
    try {
      for await (const c of ch) {
        if (!sink.write(c)) break;
      }
    } catch { /* noop */ }
    sink.end();
  })();
}

export function sinkFromChannel(ch) {
  return new Sink((b) => ch.write(b), () => ch.end(), () => ch.writeClosed);
}

export function sinkFromHandle(handle, { autoClose = true } = {}) {
  return new Sink((b) => {
    if (handle.device === 'null') return true;
    if (handle.device === 'full') throw new Error('ENOSPC: no space left on device');
    if (handle.device === 'zero' || handle.device === 'random' || handle.device === 'urandom') return true;
    handle.write(b); return true;
  }, () => { if (autoClose) { try { handle.close(); } catch { /* noop */ } } }, () => false);
}

export function sourceFromHandle(handle) { return sourceFromFile(handle); }

export function sinkFromCallback(fn) {
  let closed = false;
  return new Sink((b) => { if (!closed) fn(b); return !closed; }, () => { closed = true; }, () => closed);
}

export async function readAll(source) {
  return source.collect();
}

export async function readText(source) {
  return decode(await source.collect());
}

export async function* lines(source) {
  let acc = '';
  const dec = new TextDecoder();
  for await (const chunk of source) {
    acc += dec.decode(chunk, { stream: true });
    let i;
    while ((i = acc.indexOf('\n')) >= 0) {
      yield acc.slice(0, i).replace(/\r$/, '');
      acc = acc.slice(i + 1);
    }
  }
  acc += dec.decode();
  if (acc.length) yield acc.replace(/\r$/, '');
}

export function sinkNull() { return new Sink(() => true, () => {}, () => false); }
