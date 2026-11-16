/* `vm` module: JavaScript evaluation in a Function-constructor sandbox.
 * Note: the sandbox is not a security boundary and `timeout` is ignored.
 * This is documented behaviour, not a silent no-op. */

const kContext = Symbol('webos.vm.context');

export function createVm(makeGlobals) {
  function createContext(sandbox = {}) {
    if (typeof sandbox !== 'object' || sandbox === null) throw new TypeError('The sandbox argument must be an object');
    Object.defineProperty(sandbox, kContext, { value: true, enumerable: false });
    return sandbox;
  }

  function isContext(value) {
    return !!(value && value[kContext]);
  }

  function runCode(code, context, filename) {
    const sandbox = context || {};
    const globals = makeGlobals ? makeGlobals(sandbox) : {};
    const scope = { ...globals };
    for (const key of Object.keys(sandbox)) scope[key] = sandbox[key];
    const names = Object.keys(scope).filter((n) => /^[A-Za-z_$][\w$]*$/.test(n));
    let fn;
    try {
      fn = new Function(
        ...names,
        `"use strict";\nreturn eval(${JSON.stringify(code)});\n//# sourceURL=${filename}`,
      );
    } catch (e) {
      if (e instanceof SyntaxError) throw e;
      throw e;
    }
    return fn(...names.map((n) => scope[n]));
  }

  class Script {
    constructor(code, options = {}) {
      if (typeof code !== 'string' && !(code instanceof Uint8Array)) {
        throw new TypeError('The "code" argument must be of type string or an instance of Buffer or Uint8Array');
      }
      this.code = typeof code === 'string' ? code : new TextDecoder().decode(code);
      this.filename = options.filename || 'evalmachine.<anonymous>';
      this.lineOffset = options.lineOffset || 0;
    }
    runInContext(contextifiedObject = {}, options = {}) {
      return runCode(this.code, contextifiedObject, this.filename);
    }
    runInNewContext(contextObject = {}, options = {}) { return this.runInContext(contextObject, options); }
    runInThisContext(options = {}) { return this.runInContext({}, options); }
    createCachedData() { return new Uint8Array(0); }
  }

  return {
    Script,
    createContext,
    isContext,
    runInContext: (code, context) => runCode(String(code), context, 'evalmachine.<anonymous>'),
    runInNewContext: (code, context) => runCode(String(code), context, 'evalmachine.<anonymous>'),
    runInThisContext: (code, options = {}) => runCode(String(code), {}, options.filename || 'evalmachine.<anonymous>'),
    compileFunction: (code, params = [], options = {}) => {
      const fn = new Function(...params, code);
      return fn;
    },
    constants: {
      USE_MAIN_CONTEXT_DEFAULT_LOADER: 1,
    },
    measureMemory: async () => ({ total: { jsMemoryEstimate: 0, jsMemoryRange: [0, 0] }, other: [] }),
  };
}
