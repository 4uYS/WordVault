/* `readline` and `readline/promises` over a Readable input stream. */

import { EventEmitter } from './events.js';

const DEC = new TextDecoder('utf-8');

export class Interface extends EventEmitter {
  constructor(input, output, opts = {}) {
    super();
    this.input = input;
    this.output = output;
    this.terminal = !!opts.terminal;
    this.promptText = opts.prompt || '> ';
    this.closed = false;
    this.lineBuffer = '';
    this._waiters = [];
    this._paused = false;
    if (input) {
      this._onData = (chunk) => this._handleChunk(chunk);
      input.on('data', this._onData);
      input.on('end', () => this.close());
      input.on('error', (e) => this.emit('error', e));
      if (typeof input.resume === 'function') input.resume();
    }
  }

  _handleChunk(chunk) {
    const text = typeof chunk === 'string' ? chunk : DEC.decode(chunk);
    this.lineBuffer += text;
    let idx;
    while ((idx = this.lineBuffer.indexOf('\n')) >= 0) {
      let line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.emit('line', line);
      const waiter = this._waiters.shift();
      if (waiter) waiter(line);
    }
  }

  setPrompt(prompt) { this.promptText = prompt; }
  prompt(preserveCursor) {
    if (this.output && typeof this.output.write === 'function') this.output.write(this.promptText);
  }

  question(query, cb) {
    if (typeof cb !== 'function') throw new TypeError('The "callback" argument must be of type function');
    if (this.output && typeof this.output.write === 'function') this.output.write(query);
    this._waiters.push((answer) => cb(answer));
  }

  pause() {
    this._paused = true;
    this.input?.pause?.();
    this.emit('pause');
    return this;
  }

  resume() {
    this._paused = false;
    this.input?.resume?.();
    this.emit('resume');
    return this;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.input?.removeListener?.('data', this._onData);
    this.emit('close');
  }

  [Symbol.asyncIterator]() {
    const self = this;
    return {
      [Symbol.asyncIterator]() { return this; },
      next() {
        return new Promise((resolve) => {
          if (self.closed) { resolve({ value: undefined, done: true }); return; }
          const onLine = (line) => { self.removeListener('close', onClose); resolve({ value: line, done: false }); };
          const onClose = () => { self.removeListener('line', onLine); resolve({ value: undefined, done: true }); };
          self.once('line', onLine);
          self.once('close', onClose);
        });
      },
      return() { self.close(); return Promise.resolve({ value: undefined, done: true }); },
    };
  }
}

export function createInterface(inputOrOpts, output, opts = {}) {
  let input = inputOrOpts;
  let options = opts;
  if (inputOrOpts && typeof inputOrOpts === 'object' && typeof inputOrOpts.on !== 'function') {
    options = inputOrOpts;
    input = options.input;
    output = options.output;
  }
  return new Interface(input, output, options);
}

export function emitKeypressEvents() { /* no-op: no raw terminal in the browser sandbox */ }

export class PromiseInterface extends Interface {
  question(query) {
    this.output?.write?.(query);
    return new Promise((resolve) => this._waiters.push(resolve));
  }
}

export function createPromisesInterface(inputOrOpts, output, opts = {}) {
  let input = inputOrOpts;
  let options = opts;
  if (inputOrOpts && typeof inputOrOpts === 'object' && typeof inputOrOpts.on !== 'function') {
    options = inputOrOpts;
    input = options.input;
    output = options.output;
  }
  return new PromiseInterface(input, output, options);
}

export const promises = { createInterface: createPromisesInterface };

export default createInterface;
