/* Node-compatible `assert` module. */

import { inspect, isDeepStrictEqual } from './util.js';

export class AssertionError extends Error {
  constructor(opts = {}) {
    const message = opts.message || `${opts.actual} ${opts.operator || '=='} ${opts.expected}`;
    super(message);
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.operator = opts.operator || '==';
    this.generatedMessage = !opts.message;
  }
}

function fail(message) {
  throw new AssertionError({ message: message ? String(message) : 'Failed', operator: 'fail' });
}

function ok(value, message) {
  if (!value) {
    throw new AssertionError({
      message: message || `The expression evaluated to a falsy value: ${inspect(value)}`,
      actual: value, expected: true, operator: '==',
    });
  }
}

function equal(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) {
    throw new AssertionError({ message, actual, expected, operator: '==' });
  }
}

function notEqual(actual, expected, message) {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) throw new AssertionError({ message, actual, expected, operator: '!=' });
}

function strictEqual(actual, expected, message) {
  if (!Object.is(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'strictEqual' });
}

function notStrictEqual(actual, expected, message) {
  if (Object.is(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'notStrictEqual' });
}

function deepEqual(actual, expected, message) {
  if (!looseDeepEqual(actual, expected, [])) throw new AssertionError({ message, actual, expected, operator: 'deepEqual' });
}

function notDeepEqual(actual, expected, message) {
  if (looseDeepEqual(actual, expected, [])) throw new AssertionError({ message, actual, expected, operator: 'notDeepEqual' });
}

function looseDeepEqual(a, b, seen) {
  if (a === b) return true;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a == b; // eslint-disable-line eqeqeq
  for (const [x, y] of seen) if (x === a && y === b) return true;
  seen = seen.concat([[a, b]]);
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => looseDeepEqual(a[k], b[k], seen));
}

function deepStrictEqual(actual, expected, message) {
  if (!isDeepStrictEqual(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'deepStrictEqual' });
}

function notDeepStrictEqual(actual, expected, message) {
  if (isDeepStrictEqual(actual, expected)) throw new AssertionError({ message, actual, expected, operator: 'notDeepStrictEqual' });
}

function matcherError(matcher, actual) {
  if (matcher instanceof RegExp) return !matcher.test(String(actual));
  if (typeof matcher === 'function') return !(actual instanceof matcher);
  if (matcher && typeof matcher === 'object') {
    return Object.keys(matcher).some((k) => actual?.[k] !== matcher[k]);
  }
  return actual !== matcher;
}

function throws(fn, expected, message) {
  if (typeof expected === 'string' && message === undefined) { message = expected; expected = undefined; }
  let threw = false;
  let err;
  try { fn(); } catch (e) { threw = true; err = e; }
  if (!threw) throw new AssertionError({ message: message || 'Missing expected exception.', actual: undefined, expected, operator: 'throws' });
  if (expected !== undefined && matcherError(expected, err)) {
    throw new AssertionError({
      message: message || `The error did not match the expected value: ${inspect(err)}`,
      actual: err, expected, operator: 'throws',
    });
  }
}

function doesNotThrow(fn, message) {
  try { fn(); } catch (e) {
    throw new AssertionError({
      message: message || `Got unwanted exception: ${e && e.message ? e.message : e}`,
      actual: e, expected: undefined, operator: 'doesNotThrow',
    });
  }
}

async function rejects(promiseOrFn, expected, message) {
  if (typeof expected === 'string' && message === undefined) { message = expected; expected = undefined; }
  let err;
  let didReject = false;
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (e) { didReject = true; err = e; }
  if (!didReject) {
    throw new AssertionError({ message: message || 'Missing expected rejection.', actual: undefined, expected, operator: 'rejects' });
  }
  if (expected !== undefined && matcherError(expected, err)) {
    throw new AssertionError({ message: message || `Rejection did not match: ${inspect(err)}`, actual: err, expected, operator: 'rejects' });
  }
  return err;
}

async function doesNotReject(promiseOrFn, message) {
  try {
    await (typeof promiseOrFn === 'function' ? promiseOrFn() : promiseOrFn);
  } catch (e) {
    throw new AssertionError({
      message: message || `Got unwanted rejection: ${e && e.message ? e.message : e}`,
      actual: e, expected: undefined, operator: 'doesNotReject',
    });
  }
}

function ifError(value, message) {
  if (value !== null && value !== undefined) {
    if (value instanceof Error) throw value;
    throw new AssertionError({ message: message || `ifError got unwanted exception: ${inspect(value)}`, actual: value, expected: null, operator: 'ifError' });
  }
}

function match(value, regexp, message) {
  if (!regexp.test(String(value))) throw new AssertionError({ message, actual: value, expected: regexp, operator: 'match' });
}

function doesNotMatch(value, regexp, message) {
  if (regexp.test(String(value))) throw new AssertionError({ message, actual: value, expected: regexp, operator: 'doesNotMatch' });
}

const assert = Object.assign(ok, {
  ok, equal, notEqual, strictEqual, notStrictEqual,
  deepEqual, notDeepEqual, deepStrictEqual, notDeepStrictEqual,
  throws, doesNotThrow, rejects, doesNotReject, ifError, fail, match, doesNotMatch,
  AssertionError,
  notEqualStrict: notStrictEqual,
});
assert.strict = assert;
assert.default = assert;

export default assert;
