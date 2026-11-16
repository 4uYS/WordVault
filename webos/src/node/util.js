/* `util` module: formatting, inspection, promisify and assorted helpers. */

export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;

const customInspect = Symbol.for('nodejs.util.inspect.custom');
const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');

function inspectValue(value, depth, seen, opts) {
  const showHidden = !!opts?.showHidden;
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'undefined') return 'undefined';
  if (t === 'string') return depth === 0 && opts?.compact === false ? value : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
  if (t === 'number') return Object.is(value, -0) ? '-0' : String(value);
  if (t === 'bigint') return `${value}n`;
  if (t === 'boolean') return String(value);
  if (t === 'symbol') return value.toString();
  if (t === 'function') return value.name ? `[Function: ${value.name}]` : '[Function (anonymous)]';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return value.toString();
  if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`;
  if (value && typeof value[customInspect] === 'function') {
    try { return String(value[customInspect](depth, opts)); } catch { /* fall through */ }
  }
  if (value instanceof Uint8Array && value.constructor?.name === 'Buffer') {
    return `<Buffer ${Array.from(value).map((b) => b.toString(16).padStart(2, '0')).join(' ')}>`;
  }
  if (seen.includes(value)) return '[Circular]';
  const maxDepth = opts?.depth === null ? Infinity : (opts?.depth ?? 2);
  if (depth > maxDepth) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen = seen.concat([value]);
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    return `[ ${value.map((v) => inspectValue(v, depth + 1, seen, opts)).join(', ')} ]`;
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([k, v]) => `${inspectValue(k, depth + 1, seen, opts)} => ${inspectValue(v, depth + 1, seen, opts)}`);
    return entries.length ? `Map(${entries.length}) { ${entries.join(', ')} }` : 'Map(0) {}';
  }
  if (value instanceof Set) {
    const items = [...value].map((v) => inspectValue(v, depth + 1, seen, opts));
    return items.length ? `Set(${items.length}) { ${items.join(', ')} }` : 'Set(0) {}';
  }
  if (value instanceof ArrayBuffer) return `ArrayBuffer { byteLength: ${value.byteLength} }`;
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${value.length}) [ ${Array.from(value).join(', ')} ]`;
  if (value instanceof Promise) return 'Promise { <pending> }';
  if (value instanceof WeakMap) return 'WeakMap { <items unknown> }';
  if (value instanceof WeakSet) return 'WeakSet { <items unknown> }';
  const keys = Object.keys(value);
  if (showHidden) for (const s of Object.getOwnPropertySymbols(value)) keys.push(s);
  if (!keys.length) return '{}';
  const prefix = value.constructor && value.constructor.name && value.constructor.name !== 'Object'
    ? `${value.constructor.name} ` : '';
  const body = keys.map((k) => {
    const key = typeof k === 'symbol' ? `[${k.toString()}]` : /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
    let v;
    try { v = value[k]; } catch (e) { v = `<Inspection threw (${e.message})>`; }
    return `${key}: ${inspectValue(v, depth + 1, seen, opts)}`;
  });
  return `${prefix}{ ${body.join(', ')} }`;
}

export function inspect(value, opts = {}) {
  if (typeof opts === 'number') opts = { depth: opts };
  if (typeof opts === 'boolean') opts = { showHidden: opts };
  return inspectValue(value, 0, [], opts);
}
inspect.custom = customInspect;
inspect.defaultOptions = { depth: 2 };

export function format(...args) {
  if (!args.length) return '';
  const first = args[0];
  if (typeof first !== 'string') return args.map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
  let i = 1;
  const out = first.replace(/%[sdifjoOc%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case '%s': return typeof a === 'string' ? a : typeof a === 'bigint' ? `${a}n` : inspect(a, { depth: 0 });
      case '%d': return typeof a === 'bigint' ? `${a}n` : String(Number(a));
      case '%i': return String(parseInt(a, 10));
      case '%f': return String(parseFloat(a));
      case '%j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
      case '%o': case '%O': return inspect(a, { showHidden: true, depth: 4 });
      case '%c': return '';
      default: return m;
    }
  });
  const rest = args.slice(i).map((a) => (typeof a === 'string' ? a : inspect(a)));
  return rest.length ? `${out} ${rest.join(' ')}` : out;
}

export function formatWithOptions(inspectOptions, ...args) {
  if (!args.length) return '';
  const first = args[0];
  if (typeof first !== 'string') return args.map((a) => (typeof a === 'string' ? a : inspect(a, inspectOptions))).join(' ');
  let i = 1;
  const out = first.replace(/%[sdifjoOc%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case '%s': return typeof a === 'string' ? a : inspect(a, { ...inspectOptions, depth: 0 });
      case '%d': return String(Number(a));
      case '%i': return String(parseInt(a, 10));
      case '%f': return String(parseFloat(a));
      case '%j': try { return JSON.stringify(a); } catch { return '[Circular]'; }
      case '%o': case '%O': return inspect(a, inspectOptions);
      case '%c': return '';
      default: return m;
    }
  });
  const rest = args.slice(i).map((a) => (typeof a === 'string' ? a : inspect(a, inspectOptions)));
  return rest.length ? `${out} ${rest.join(' ')}` : out;
}

export function promisify(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type function');
  if (fn[promisifyCustom]) return fn[promisifyCustom];
  const p = function (...args) {
    return new Promise((resolve, reject) => {
      fn.call(this, ...args, (err, ...values) => {
        if (err) { reject(err); return; }
        resolve(values.length > 1 ? values : values[0]);
      });
    });
  };
  Object.setPrototypeOf(p, Object.getPrototypeOf(fn));
  return p;
}
promisify.custom = promisifyCustom;

export function callbackify(fn) {
  if (typeof fn !== 'function') throw new TypeError('The "original" argument must be of type function');
  const cb = function (...args) {
    const callback = args.pop();
    if (typeof callback !== 'function') throw new TypeError('The last argument must be of type function');
    fn.apply(this, args).then(
      (value) => queueMicrotask(() => callback(null, value)),
      (err) => queueMicrotask(() => callback(err || new Error('Promise was rejected with a falsy value'))),
    );
  };
  Object.setPrototypeOf(cb, Object.getPrototypeOf(fn));
  return cb;
}

export function inherits(ctor, superCtor) {
  if (typeof ctor !== 'function') throw new TypeError('The "ctor" argument must be of type function');
  if (typeof superCtor !== 'function') throw new TypeError('The "superCtor" argument must be of type function');
  Object.defineProperty(ctor, 'super_', { value: superCtor, writable: true, configurable: true });
  ctor.prototype = Object.create(superCtor.prototype, {
    constructor: { value: ctor, writable: true, configurable: true },
  });
}

export function isDeepStrictEqual(a, b) {
  return deepEqual(a, b, []);
}

function deepEqual(a, b, seen) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;
  for (const pair of seen) if (pair[0] === a && pair[1] === b) return true;
  seen = seen.concat([[a, b]]);
  const tag = Object.prototype.toString.call(a);
  if (tag !== Object.prototype.toString.call(b)) return false;
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (a instanceof Error) return a.name === b.name && a.message === b.message;
  if (a instanceof Map) {
    if (a.size !== b.size) return false;
    const ea = [...a.entries()], eb = [...b.entries()];
    return ea.every(([k, v], i) => deepEqual(k, eb[i][0], seen) && deepEqual(v, eb[i][1], seen));
  }
  if (a instanceof Set) {
    if (a.size !== b.size) return false;
    const va = [...a.values()], vb = [...b.values()];
    return va.every((v, i) => deepEqual(v, vb[i], seen));
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.constructor !== b.constructor || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof ArrayBuffer || b instanceof ArrayBuffer) {
    if (!(a instanceof ArrayBuffer) || !(b instanceof ArrayBuffer)) return false;
    if (a.byteLength !== b.byteLength) return false;
    const ua = new Uint8Array(a), ub = new Uint8Array(b);
    for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) return false;
    return true;
  }
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual(a[k], b[k], seen)) return false;
  }
  return true;
}

const warned = new Set();
export function deprecate(fn, msg, code) {
  let done = false;
  return function (...args) {
    if (!done) {
      done = true;
      const text = `DeprecationWarning: ${msg}${code ? ` [${code}]` : ''}`;
      if (!warned.has(text)) {
        warned.add(text);
        const p = globalThis.process;
        if (typeof p?.emitWarning === 'function') p.emitWarning(text, 'DeprecationWarning', code);
      }
    }
    return fn.apply(this, args);
  };
}

export function debuglog(section) {
  const flag = globalThis.process?.env?.NODE_DEBUG || '';
  const enabled = flag.split(/[\s,]+/).some((s) => s.toLowerCase() === String(section).toLowerCase());
  return function debug(...args) {
    if (!enabled) return;
    const p = globalThis.process;
    if (typeof p?.stderr?.write === 'function') {
      p.stderr.write(`${String(section).toUpperCase()} ${Date.now()}: ${format(...args)}\n`);
    }
  };
}

export function stripVTControlCharacters(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
}

const types = {
  isDate: (v) => v instanceof Date,
  isRegExp: (v) => v instanceof RegExp,
  isPromise: (v) => !!v && typeof v.then === 'function',
  isTypedArray: (v) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isArrayBufferView: (v) => ArrayBuffer.isView(v),
  isArrayBuffer: (v) => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v) => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
  isAnyArrayBuffer: (v) => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),
  isUint8Array: (v) => v instanceof Uint8Array,
  isUint16Array: (v) => v instanceof Uint16Array,
  isUint32Array: (v) => v instanceof Uint32Array,
  isInt8Array: (v) => v instanceof Int8Array,
  isInt16Array: (v) => v instanceof Int16Array,
  isInt32Array: (v) => v instanceof Int32Array,
  isFloat32Array: (v) => v instanceof Float32Array,
  isFloat64Array: (v) => v instanceof Float64Array,
  isBigInt64Array: (v) => typeof BigInt64Array !== 'undefined' && v instanceof BigInt64Array,
  isBigUint64Array: (v) => typeof BigUint64Array !== 'undefined' && v instanceof BigUint64Array,
  isMap: (v) => v instanceof Map,
  isSet: (v) => v instanceof Set,
  isWeakMap: (v) => v instanceof WeakMap,
  isWeakSet: (v) => v instanceof WeakSet,
  isNativeError: (v) => v instanceof Error,
  isFunction: (v) => typeof v === 'function',
  isAsyncFunction: (v) => typeof v === 'function' && v.constructor?.name === 'AsyncFunction',
  isGeneratorFunction: (v) => typeof v === 'function' && v.constructor?.name === 'GeneratorFunction',
  isNumberObject: (v) => v instanceof Number,
  isStringObject: (v) => v instanceof String,
  isBooleanObject: (v) => v instanceof Boolean,
  isBoxedPrimitive: (v) => v instanceof Number || v instanceof String || v instanceof Boolean,
  isSymbolObject: (v) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Symbol]',
  isBigIntObject: (v) => typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object BigInt]',
  isDataView: (v) => v instanceof DataView,
  isProxy: () => false,
};

export function parseArgs(config = {}) {
  const { args = [], options = {}, strict = true, allowPositionals = false } = config;
  const values = Object.create(null);
  const positionals = [];
  const byShort = new Map();
  for (const [name, spec] of Object.entries(options)) {
    values[name] = spec.multiple ? [] : spec.default;
    if (spec.short) byShort.set(spec.short, name);
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    let name = null, inline = null;
    if (arg === '--') { positionals.push(...args.slice(i + 1)); break; }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      if (eq >= 0) inline = arg.slice(eq + 1);
      if (!options[name]) {
        if (strict) throw new Error(`Unknown option '--${name}'`);
        continue;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      name = byShort.get(arg[1]);
      if (!name) {
        if (strict) throw new Error(`Unknown option '${arg}'`);
        continue;
      }
      if (arg.length > 2) inline = arg.slice(2);
    } else {
      if (!allowPositionals && strict) throw new Error(`Unexpected argument '${arg}'`);
      positionals.push(arg);
      continue;
    }
    const spec = options[name];
    if (spec.type === 'boolean') { values[name] = true; continue; }
    let value = inline;
    if (value === null) {
      value = args[++i];
      if (value === undefined) throw new Error(`Option '--${name}' argument missing`);
    }
    if (spec.multiple) {
      if (!Array.isArray(values[name])) values[name] = [];
      values[name].push(value);
    } else values[name] = value;
  }
  return { values, positionals };
}

export { types };
export const debug = debuglog;
export const _extend = Object.assign;
export const isArray = Array.isArray;
export const isBoolean = (v) => typeof v === 'boolean';
export const isNull = (v) => v === null;
export const isNullOrUndefined = (v) => v == null;
export const isNumber = (v) => typeof v === 'number';
export const isString = (v) => typeof v === 'string';
export const isSymbol = (v) => typeof v === 'symbol';
export const isUndefined = (v) => v === undefined;
export const isObject = (v) => typeof v === 'object' && v !== null;
export const isError = (v) => v instanceof Error;
export const isFunction = (v) => typeof v === 'function';
export const isPrimitive = (v) => v === null || (typeof v !== 'object' && typeof v !== 'function');
export const isRegExp = (v) => v instanceof RegExp;
export const isDate = (v) => v instanceof Date;

export const util = {
  format, formatWithOptions, inspect, promisify, callbackify, inherits,
  isDeepStrictEqual, types, parseArgs, TextEncoder, TextDecoder, deprecate,
  debuglog, stripVTControlCharacters,
  isArray, isBoolean, isNull, isNullOrUndefined, isNumber, isString,
  isSymbol, isUndefined, isObject, isError, isFunction, isPrimitive, isRegExp, isDate,
};
