/*
 * CommonJS / ESM module loader and resolver over the WebOS VFS.
 * - CommonJS wrapper with cache and circular-dependency support.
 * - ESM is transformed into a generated CJS wrapper (static imports/exports,
 *   dynamic import() and import.meta).
 * - Node resolution algorithm incl. node_modules walking, scoped packages,
 *   package.json "main"/"exports" and extension probing.
 */

import { pathToFileURL } from './misc.js';
import { Buffer } from './buffer.js';

export class Module {
  constructor(id, filename, runtime) {
    this.id = id;
    this.filename = filename;
    this.path = filename.slice(0, filename.lastIndexOf('/')) || '/';
    this.exports = {};
    this.loaded = false;
    this.children = [];
    this.parent = null;
    this.require = null;
    this.runtime = runtime;
  }

  get paths() {
    const out = [];
    let dir = this.path;
    for (;;) {
      out.push(`${dir === '/' ? '' : dir}/node_modules`);
      if (dir === '/') break;
      dir = dir.slice(0, dir.lastIndexOf('/')) || '/';
    }
    return out;
  }
}

const stripShebang = (code) => (code.startsWith('#!') ? '//' + code.slice(2) : code);
const dirnameOf = (p) => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
const joinPath = (a, b) => (b.startsWith('/') ? b : (a === '/' ? '/' + b : `${a}/${b}`));

function splitTopLevel(text, sep) {
  const parts = [];
  let depth = 0, quote = null, cur = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      cur += ch;
      if (ch === quote && text[i - 1] !== '\\') quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function declaredNames(decl) {
  const names = [];
  for (let part of splitTopLevel(decl, ',')) {
    const eq = part.indexOf('=');
    if (eq >= 0) part = part.slice(0, eq);
    part = part.trim();
    if (!part) continue;
    if (part.startsWith('{') || part.startsWith('[')) {
      for (const m of part.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[,}\]=:]|$)/g)) names.push(m[1]);
    } else {
      const m = part.match(/^([A-Za-z_$][\w$]*)/);
      if (m) names.push(m[1]);
    }
  }
  return names;
}

function parseImportClause(clause, v, out) {
  const rest = clause.trim();
  const brace = rest.match(/\{([\s\S]*?)\}/);
  const star = rest.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  const def = rest.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
  if (def) out.push(`const ${def[1]} = ${v}.default !== undefined ? ${v}.default : ${v};`);
  if (star) out.push(`const ${star[1]} = ${v};`);
  if (brace) {
    for (const spec of brace[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [orig, alias] = spec.split(/\s+as\s+/);
      out.push(`const ${alias || orig} = ${v}[${JSON.stringify(orig)}];`);
    }
  }
}

export function transformESM(source, filename) {
  let code = stripShebang(source);
  const head = [];
  const tail = [];
  let n = 0;
  const uid = () => `__esm_i${n++}`;

  code = code.replace(/\bimport\.meta\b/g, '__esm_meta__');

  // import ... from '...'
  code = code.replace(/^[ \t]*import\s+([^;'"]+?)\s+from\s*(['"])([^'"]+)\2\s*;?/gm, (m, clause, q, spec) => {
    const v = uid();
    head.push(`const ${v} = __require(${JSON.stringify(spec)});`);
    parseImportClause(clause, v, head);
    return '';
  });
  // side-effect import '...'
  code = code.replace(/^[ \t]*import\s*(['"])([^'"]+)\1\s*;?/gm, (m, q, spec) => {
    head.push(`__require(${JSON.stringify(spec)});`);
    return '';
  });

  // export * as ns from
  code = code.replace(/^[ \t]*export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*(['"])([^'"]+)\2\s*;?/gm, (m, name, q, spec) => {
    tail.push(`__exports[${JSON.stringify(name)}] = __require(${JSON.stringify(spec)});`);
    return '';
  });
  // export * from
  code = code.replace(/^[ \t]*export\s+\*\s+from\s*(['"])([^'"]+)\1\s*;?/gm, (m, q, spec) => {
    tail.push(`Object.assign(__exports, __require(${JSON.stringify(spec)}));`);
    return '';
  });
  // export { ... } from
  code = code.replace(/^[ \t]*export\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/gm, (m, names, q, spec) => {
    const v = uid();
    head.push(`const ${v} = __require(${JSON.stringify(spec)});`);
    for (const s of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [orig, alias] = s.split(/\s+as\s+/);
      tail.push(`__exports[${JSON.stringify(alias || orig)}] = ${v}[${JSON.stringify(orig)}];`);
    }
    return '';
  });
  // export { ... }
  code = code.replace(/^[ \t]*export\s*\{([^}]*)\}\s*;?/gm, (m, names) => {
    for (const s of names.split(',').map((x) => x.trim()).filter(Boolean)) {
      const [orig, alias] = s.split(/\s+as\s+/);
      tail.push(`__exports[${JSON.stringify(alias || orig)}] = ${orig};`);
    }
    return '';
  });

  // export default
  code = code.replace(/^[ \t]*export\s+default\s+(async\s+function\s*\*?|function\s*\*?|class)\s+/gm, (m, kw) => `__exports.default = ${kw} `);
  code = code.replace(/^[ \t]*export\s+default\s+/gm, '__exports.default = ');

  // export named declarations
  code = code.replace(/^[ \t]*export\s+(async\s+function\s*\*?\s*|function\s*\*?\s*|class\s+)([A-Za-z_$][\w$]*)/gm, (m, kw, name) => {
    tail.push(`__exports[${JSON.stringify(name)}] = ${name};`);
    return `${kw}${name}`;
  });
  code = code.replace(/^[ \t]*export\s+(const|let|var)\s+([^;\n]+)/gm, (m, kind, decl) => {
    for (const name of declaredNames(decl)) tail.push(`__exports[${JSON.stringify(name)}] = ${name};`);
    return `${kind} ${decl}`;
  });

  // dynamic import()
  code = code.replace(/\bimport\s*\(/g, '__dynamicImport(');

  if (/^[ \t]*export\s+/m.test(code) || /^[ \t]*import\s+[^.(]/m.test(code)) {
    throw new SyntaxError(`Unable to transform ESM syntax in ${filename}: unsupported import/export form`);
  }

  const header = [
    'const __require = (require && require.__esmRequire) || require;',
    'const __exports = {};',
    'Object.defineProperty(__exports, "__esModule", { value: true });',
    `const __esm_meta__ = { url: ${JSON.stringify(pathToFileURL(filename).href)}, filename: ${JSON.stringify(filename)}, dirname: ${JSON.stringify(dirnameOf(filename))} };`,
    'const __dynamicImport = (spec) => Promise.resolve().then(() => __require(spec));',
    ...head,
  ].join('\n');
  const footer = [...tail, 'module.exports = __exports;'].join('\n');
  return `${header}\n${code}\n${footer}`;
}

export function createLoader(runtime) {
  const cache = Object.create(null);
  const packageCache = new Map();

  const readText = (filename) => runtime.readFileText(filename);
  const existsFile = (p) => {
    try { return runtime.vfs.stat(p, runtime.cred(), { followFinal: true }).isFile(); } catch { return false; }
  };
  const existsDir = (p) => {
    try { return runtime.vfs.stat(p, runtime.cred(), { followFinal: true }).isDirectory(); } catch { return false; }
  };

  function readPackage(dir) {
    if (packageCache.has(dir)) return packageCache.get(dir);
    let pkg = null;
    try {
      if (runtime.vfs.stat(joinPath(dir, 'package.json'), runtime.cred()).isFile()) {
        pkg = JSON.parse(readText(joinPath(dir, 'package.json')));
      }
    } catch { pkg = null; }
    packageCache.set(dir, pkg);
    return pkg;
  }

  function notFound(request, parent) {
    const e = new Error(`Cannot find module '${request}'${parent ? `\nRequire stack:\n- ${parent}` : ''}`);
    e.code = 'MODULE_NOT_FOUND';
    e.requireStack = parent ? [parent] : [];
    return e;
  }

  function resolveAsFile(base) {
    base = base.replace(/\/+$/, '') || '/';
    if (existsFile(base)) return base;
    for (const ext of ['.js', '.cjs', '.json', '.mjs', '.node']) {
      if (existsFile(base + ext)) return base + ext;
    }
    return null;
  }

  function resolveAsDirectory(dir, esm) {
    if (!existsDir(dir)) return null;
    const pkg = readPackage(dir);
    if (pkg && esm && pkg.exports !== undefined) {
      // handled by caller via resolvePackageExports
    }
    if (pkg && typeof pkg.main === 'string') {
      const mainPath = joinPath(dir, pkg.main);
      const asFile = resolveAsFile(mainPath);
      if (asFile) return asFile;
      const asIndex = resolveAsFile(joinPath(mainPath.replace(/\/+$/, ''), 'index'));
      if (asIndex) return asIndex;
    }
    for (const candidate of ['index.js', 'index.cjs', 'index.json', 'index.mjs', 'index.node']) {
      const p = joinPath(dir, candidate);
      if (existsFile(p)) return p;
    }
    return null;
  }

  function resolveAsFileOrDir(base, esm = false) {
    if (existsDir(base) && !base.endsWith('.js')) {
      const dir = resolveAsDirectory(base.replace(/\/+$/, ''), esm);
      if (dir) return dir;
    }
    return resolveAsFile(base);
  }

  const CONDITIONS = (esm) => (esm ? ['import', 'node', 'default', 'require'] : ['require', 'node', 'default', 'import']);

  function pickConditional(target, esm) {
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) {
      for (const t of target) { const r = pickConditional(t, esm); if (r) return r; }
      return null;
    }
    if (target && typeof target === 'object') {
      for (const cond of CONDITIONS(esm)) {
        if (Object.prototype.hasOwnProperty.call(target, cond)) {
          const r = pickConditional(target[cond], esm);
          if (r) return r;
        }
      }
    }
    return null;
  }

  function resolveExportsField(exportsField, subpath, esm) {
    if (typeof exportsField === 'string' || Array.isArray(exportsField)) {
      return subpath === '.' ? pickConditional(exportsField, esm) : null;
    }
    if (!exportsField || typeof exportsField !== 'object') return null;
    const keys = Object.keys(exportsField);
    const isSubpathMap = keys.some((k) => k.startsWith('.'));
    if (!isSubpathMap) {
      return subpath === '.' ? pickConditional(exportsField, esm) : null;
    }
    if (Object.prototype.hasOwnProperty.call(exportsField, subpath)) {
      return pickConditional(exportsField[subpath], esm);
    }
    for (const key of keys) {
      if (key.includes('*')) {
        const [pre, post] = key.split('*');
        if (subpath.startsWith(pre) && subpath.endsWith(post) && subpath.length >= pre.length + post.length) {
          const star = subpath.slice(pre.length, subpath.length - post.length);
          const target = pickConditional(exportsField[key], esm);
          return target ? target.replace(/\*/g, star) : null;
        }
      }
    }
    return null;
  }

  function resolvePackage(pkgName, subpath, esm, startDir) {
    let dir = startDir || '/';
    for (;;) {
      const pkgDir = joinPath(joinPath(dir, 'node_modules'), pkgName);
      if (existsDir(pkgDir)) {
        const pkg = readPackage(pkgDir);
        if (pkg && pkg.exports !== undefined) {
          const target = resolveExportsField(pkg.exports, subpath, esm);
          if (!target) {
            const e = new Error(`Package subpath '${subpath}' is not defined by "exports" in ${joinPath(pkgDir, 'package.json')}`);
            e.code = 'ERR_PACKAGE_PATH_NOT_EXPORTED';
            throw e;
          }
          const resolved = resolveAsFileOrDir(joinPath(pkgDir, target), esm);
          if (resolved) return resolved;
        }
        const candidate = subpath === '.' ? pkgDir : joinPath(pkgDir, subpath);
        const found = resolveAsFileOrDir(candidate, esm);
        if (found) return found;
      }
      if (dir === '/') break;
      dir = dirnameOf(dir);
    }
    const globalDir = joinPath('/usr/lib/node_modules', pkgName);
    if (existsDir(globalDir)) {
      const candidate = subpath === '.' ? globalDir : joinPath(globalDir, subpath);
      const found = resolveAsFileOrDir(candidate, esm);
      if (found) return found;
    }
    return null;
  }

  function splitPackageRequest(request) {
    const parts = request.split('/');
    if (request.startsWith('@')) {
      return { pkgName: parts.slice(0, 2).join('/'), subpath: parts.length > 2 ? './' + parts.slice(2).join('/') : '.' };
    }
    return { pkgName: parts[0], subpath: parts.length > 1 ? './' + parts.slice(1).join('/') : '.' };
  }

  function resolveRequest(request, parentDir, esm = false) {
    const raw = String(request);
    const bare = raw.startsWith('node:') ? raw.slice(5) : raw;
    if (runtime.isBuiltin(bare)) return { builtin: bare };
    if (raw === '.' || raw === '..' || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('/')) {
      const base = raw.startsWith('/') ? raw : joinPath(parentDir, raw);
      const found = resolveAsFileOrDir(base, esm);
      if (found) return { filename: found };
      throw notFound(raw, parentDir);
    }
    if (raw.startsWith('file:')) {
      const p = decodeURIComponent(new URL(raw).pathname);
      const found = resolveAsFileOrDir(p, esm);
      if (found) return { filename: found };
      throw notFound(raw, parentDir);
    }
    const { pkgName, subpath } = splitPackageRequest(raw);
    const found = resolvePackage(pkgName, subpath, esm, parentDir);
    if (found) return { filename: found };
    throw notFound(raw, parentDir);
  }

  function isEsmFile(filename) {
    if (filename.endsWith('.mjs')) return true;
    if (filename.endsWith('.cjs') || filename.endsWith('.json') || filename.endsWith('.node')) return false;
    let dir = dirnameOf(filename);
    for (;;) {
      const pkg = readPackage(dir);
      if (pkg) return pkg.type === 'module';
      if (dir === '/') return false;
      dir = dirnameOf(dir);
    }
  }

  function load(filename, parent) {
    const cached = cache[filename];
    if (cached) return cached.exports;
    if (filename.endsWith('.node')) {
      const e = new Error(`Cannot load native addon '${filename}': .node binaries are not supported in the browser sandbox. Rebuild the dependency in pure JavaScript or avoid the addon.`);
      e.code = 'ERR_DLOPEN_FAILED';
      throw e;
    }
    if (filename.endsWith('.json')) {
      const mod = new Module(filename, filename, runtime);
      mod.parent = parent || null;
      cache[filename] = mod;
      try {
        const text = readText(filename);
        mod.exports = JSON.parse(text);
        mod.loaded = true;
      } catch (e) {
        delete cache[filename];
        const err = new Error(`Invalid JSON in ${filename}: ${e.message}`);
        err.code = 'ERR_INVALID_JSON';
        throw err;
      }
      return mod.exports;
    }

    const mod = new Module(filename, filename, runtime);
    mod.parent = parent || null;
    cache[filename] = mod;
    const dirname = dirnameOf(filename);
    const requireFn = makeRequire(mod, dirname);
    mod.require = requireFn;
    try {
      let source = readText(filename);
      source = stripShebang(source);
      if (isEsmFile(filename)) {
        const transformed = transformESM(source, filename);
        runtime.executeModule(mod, requireFn, transformed, filename, true);
        if (mod.__execPromise) {
          const e = new Error(`Cannot require() ${filename}: the module uses top-level await, which only works through the async entry point.`);
          e.code = 'ERR_REQUIRE_ASYNC_MODULE';
          delete cache[filename];
          throw e;
        }
      } else {
        runtime.executeModule(mod, requireFn, source, filename, false);
      }
      mod.loaded = true;
    } catch (e) {
      delete cache[filename];
      throw e;
    }
    return mod.exports;
  }

  function makeRequire(mod, dirname) {
    const requireFn = (request) => {
      const resolved = resolveRequest(request, dirname, false);
      if (resolved.builtin) return runtime.getBuiltin(resolved.builtin);
      return load(resolved.filename, mod);
    };
    requireFn.resolve = (request) => {
      const resolved = resolveRequest(request, dirname, false);
      return resolved.builtin ? resolved.builtin : resolved.filename;
    };
    requireFn.resolve.paths = () => mod.paths;
    requireFn.cache = cache;
    requireFn.main = runtime.mainModule;
    // Used by transformed ESM `import` statements so conditional "exports"
    // resolve the `import` branch instead of the `require` branch.
    requireFn.__esmRequire = (request) => {
      const resolved = resolveRequest(request, dirname, true);
      if (resolved.builtin) return runtime.getBuiltin(resolved.builtin);
      return load(resolved.filename, mod);
    };
    requireFn.extensions = {
      '.js': () => {}, '.cjs': () => {}, '.json': () => {}, '.mjs': () => {},
    };
    return requireFn;
  }

  function createRequireFrom(filename) {
    const abs = filename.startsWith('/') ? filename : joinPath(runtime.cwdDir(), filename);
    const mod = new Module(abs, abs, runtime);
    return makeRequire(mod, dirnameOf(abs));
  }

  /** Synchronous require() entry point used outside a module wrapper. */
  function requireModule(request, parentFilename, parentDir) {
    const startDir = parentDir || (parentFilename ? dirnameOf(parentFilename) : runtime.cwdDir());
    const resolved = resolveRequest(request, startDir, false);
    if (resolved.builtin) return runtime.getBuiltin(resolved.builtin);
    return load(resolved.filename, null);
  }

  return {
    cache,
    resolveRequest,
    load,
    require: requireModule,
    makeRequire,
    createRequireFrom,
    isEsmFile,
    readPackage,
    transformESM,
    resolveAsFileOrDir,
    notFound,
  };
}
