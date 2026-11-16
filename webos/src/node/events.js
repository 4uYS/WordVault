/* Node-compatible EventEmitter, plus the promise helpers from `events`. */

const kErrorMonitor = Symbol('events.errorMonitor');

export class EventEmitter {
  constructor(opts = {}) {
    this._events = new Map();
    this._maxListeners = undefined;
    this._captureRejections = !!(opts && opts.captureRejections);
  }

  _list(name) {
    let list = this._events.get(name);
    if (!list) { list = []; this._events.set(name, list); }
    return list;
  }

  on(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('The "listener" argument must be of type function');
    this._list(name).push(fn);
    return this;
  }
  addListener(name, fn) { return this.on(name, fn); }

  prependListener(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('The "listener" argument must be of type function');
    this._list(name).unshift(fn);
    return this;
  }

  once(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('The "listener" argument must be of type function');
    const self = this;
    function wrapper(...args) {
      self.off(name, wrapper);
      return fn.apply(this, args);
    }
    wrapper.listener = fn;
    return this.on(name, wrapper);
  }

  prependOnceListener(name, fn) {
    if (typeof fn !== 'function') throw new TypeError('The "listener" argument must be of type function');
    const self = this;
    function wrapper(...args) {
      self.off(name, wrapper);
      return fn.apply(this, args);
    }
    wrapper.listener = fn;
    return this.prependListener(name, wrapper);
  }

  off(name, fn) { return this.removeListener(name, fn); }

  removeListener(name, fn) {
    const list = this._events.get(name);
    if (!list) return this;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i] === fn || list[i].listener === fn) { list.splice(i, 1); break; }
    }
    if (!list.length) this._events.delete(name);
    return this;
  }

  removeAllListeners(name) {
    if (name === undefined) this._events.clear();
    else this._events.delete(name);
    return this;
  }

  emit(name, ...args) {
    const list = this._events.get(name);
    if (name === 'error' && !list) {
      const monitors = this._events.get(kErrorMonitor);
      if (monitors) for (const m of monitors.slice()) m(args[0]);
      const err = args[0];
      throw err instanceof Error ? err : new Error(`Unhandled error. (${String(err)})`);
    }
    if (!list || !list.length) {
      if (name === kErrorMonitor) return false;
      return false;
    }
    for (const fn of list.slice()) {
      try {
        const r = fn.apply(this, args);
        if (this._captureRejections && r && typeof r.then === 'function') {
          r.then(undefined, (e) => {
            try { this.emit('error', e); } catch { /* surface via queueMicrotask */ }
          });
        }
      } catch (e) {
        if (name === 'error') throw e;
        if (this._captureRejections) {
          try { this.emit('error', e); } catch { queueMicrotask(() => { throw e; }); }
        } else throw e;
      }
    }
    return true;
  }

  listenerCount(name) {
    const list = this._events.get(name);
    return list ? list.length : 0;
  }
  eventNames() { return [...this._events.keys()]; }
  listeners(name) { return (this._events.get(name) || []).map((f) => f.listener || f); }
  rawListeners(name) { return (this._events.get(name) || []).slice(); }
  setMaxListeners(n) { this._maxListeners = n; return this; }
  getMaxListeners() { return this._maxListeners ?? EventEmitter.defaultMaxListeners; }
}

EventEmitter.defaultMaxListeners = 10;
EventEmitter.errorMonitor = kErrorMonitor;

export function once(emitter, name, options = {}) {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) { reject(signal.reason || new Error('The operation was aborted')); return; }
    function onEvent(...args) { cleanup(); resolve(args); }
    function onError(err) { cleanup(); reject(err); }
    function onAbort() { cleanup(); reject(signal.reason || new Error('The operation was aborted')); }
    const cleanup = () => {
      emitter.removeListener(name, onEvent);
      emitter.removeListener('error', onError);
      if (signal) signal.removeEventListener?.('abort', onAbort);
    };
    emitter.once(name, onEvent);
    if (name !== 'error') emitter.once('error', onError);
    if (signal) signal.addEventListener?.('abort', onAbort);
  });
}

export function on(emitter, name) {
  const queue = [];
  let ended = false;
  let wake = null;
  const it = {
    [Symbol.asyncIterator]() { return this; },
    async next() {
      for (;;) {
        if (queue.length) return { value: queue.shift(), done: false };
        if (ended) return { value: undefined, done: true };
        await new Promise((r) => { wake = r; });
      }
    },
    async return() { ended = true; if (wake) wake(); return { value: undefined, done: true }; },
  };
  emitter.on(name, (...args) => { queue.push(args); if (wake) { const w = wake; wake = null; w(); } });
  emitter.on('end', () => { ended = true; if (wake) { const w = wake; wake = null; w(); } });
  return it;
}

export function getEventListeners(emitter, name) {
  if (emitter && typeof emitter.rawListeners === 'function') return emitter.rawListeners(name);
  return [];
}

export function addAbortListener(signal, fn) {
  signal.addEventListener('abort', fn, { once: true });
  return { [Symbol.dispose]() { signal.removeEventListener('abort', fn); } };
}

export default EventEmitter;
