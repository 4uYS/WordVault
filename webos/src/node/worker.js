/*
 * `worker_threads` without real parallelism: a Worker runs its module on the
 * same thread, communicating through MessagePort-like objects. This is honest
 * about the limitation while remaining functional for simple message passing.
 */

import { EventEmitter } from './events.js';

export class MessagePort extends EventEmitter {
  constructor() {
    super();
    this._peer = null;
    this._queue = [];
    this._started = false;
    this._closed = false;
  }

  postMessage(value) {
    if (this._closed) return;
    const peer = this._peer;
    if (!peer) return;
    queueMicrotask(() => peer._deliver(value));
  }

  _deliver(value) {
    if (this._closed) return;
    if (!this._started) { this._queue.push(value); return; }
    this.emit('message', value);
  }

  start() {
    if (this._started) return this;
    this._started = true;
    const queued = this._queue;
    this._queue = [];
    for (const v of queued) this.emit('message', v);
    return this;
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    queueMicrotask(() => this.emit('close'));
  }

  ref() { return this; }
  unref() { return this; }

  on(name, fn) {
    super.on(name, fn);
    if (name === 'message') this.start();
    return this;
  }
}

export class MessageChannel {
  constructor() {
    this.port1 = new MessagePort();
    this.port2 = new MessagePort();
    this.port1._peer = this.port2;
    this.port2._peer = this.port1;
  }
}

export function createWorkerThreads({ runFile, runCode, getContext }) {
  let nextThreadId = 1;

  class Worker extends EventEmitter {
    constructor(filename, options = {}) {
      super();
      this.threadId = nextThreadId++;
      this.workerData = options.workerData;
      this.resourceLimits = options.resourceLimits || {};
      this._terminated = false;
      this.stdout = null;
      this.stderr = null;
      const channel = new MessageChannel();
      this._port = channel.port1;
      this._workerPort = channel.port2;
      this._port.on('message', (msg) => this.emit('message', msg));
      this._port.on('close', () => this.emit('close'));
      queueMicrotask(() => {
        if (this._terminated) return;
        this.emit('online');
        const ctx = {
          parentPort: this._workerPort,
          workerData: this.workerData,
          threadId: this.threadId,
          isMainThread: false,
        };
        Promise.resolve()
          .then(() => (options.eval
            ? runCode(String(filename), {
              filename: '[worker eval]', esm: options.type === 'module', worker: ctx,
            })
            : runFile(filename, [], undefined, undefined, { worker: ctx })))
          .then((code) => {
            if (this._terminated) return;
            this.emit('exit', typeof code === 'number' ? code : 0);
          })
          .catch((err) => {
            if (this._terminated) return;
            this.emit('error', err);
            this.emit('exit', 1);
          });
      });
    }

    postMessage(value) { this._port.postMessage(value); }

    terminate() {
      this._terminated = true;
      this._port.close();
      this.emit('exit', 1);
      return Promise.resolve(1);
    }

    ref() { return this; }
    unref() { return this; }
  }

  const workerThreads = {
    Worker,
    MessageChannel,
    MessagePort,
    get isMainThread() { return !getContext(); },
    get threadId() { return getContext()?.threadId ?? 0; },
    get workerData() { return getContext()?.workerData; },
    get parentPort() { return getContext()?.parentPort ?? null; },
    get resourceLimits() { return {}; },
    getEnvironmentData: () => undefined,
    setEnvironmentData: () => {},
    markAsUntransferable: () => {},
    markAsUncloneable: () => {},
    isMarkedAsUntransferable: () => false,
    receiveMessageOnPort: () => undefined,
    moveMessagePortToContext: (port) => port,
  };
  return workerThreads;
}
