/*
 * Minimal zero-dependency ESM bundler for WebOS-JS.
 *
 * All source modules are relative imports and use a small subset of ESM
 * (named/default imports, declarations, export lists). This script converts
 * every module into a scoped factory and emits one self-contained ESM file:
 * dist/webos.js. No Node built-ins are required at runtime.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, join, resolve, relative, sep } from 'path';
import { fileURLToPath } from 'url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const ENTRY = 'src/index.js';
const OUT = join(ROOT, 'dist', 'webos.js');

const modules = new Map();
const order = [];
const visiting = new Set();

const toId = (abs) => relative(ROOT, abs).split(sep).join('/');
const fromId = (id) => join(ROOT, id);

function load(id) {
  if (modules.has(id)) return;
  const abs = fromId(id);
  const source = readFileSync(abs, 'utf8');
  const deps = [];
  const importRe = /^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm;
  const bareRe = /^import\s+['"]([^'"]+)['"]\s*;?/gm;
  let m;
  while ((m = importRe.exec(source))) deps.push(resolveSpecifier(m[2], id));
  while ((m = bareRe.exec(source))) deps.push(resolveSpecifier(m[1], id));
  modules.set(id, { source, deps });
  for (const dep of deps) load(dep);
  order.push(id);
}

function resolveSpecifier(spec, importer) {
  if (!spec.startsWith('.')) throw new Error(`${importer}: bare module specifier not supported: ${spec}`);
  const abs = resolve(dirname(fromId(importer)), spec);
  if (!abs.startsWith(ROOT)) throw new Error(`${importer}: import escapes project root: ${spec}`);
  return toId(abs);
}

let seq = 0;

function transform(id) {
  let src = modules.get(id).source;
  const lines = [];

  src = src.replace(/^import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]\s*;?/gm, (all, clause, spec) => {
    const dep = JSON.stringify(resolveSpecifier(spec, id));
    const varName = `__m${seq++}`;
    let out = `const ${varName} = __req(${dep});\n`;
    let rest = clause.trim();
    if (!rest.startsWith('{') && !rest.startsWith('*')) {
      const dm = rest.match(/^([A-Za-z_$][\w$]*)\s*(?:,\s*|$)/);
      if (dm) {
        out += `const ${dm[1]} = ${varName}.default;\n`;
        rest = rest.slice(dm[0].length).trim();
      }
    }
    if (rest.startsWith('*')) {
      const nm = rest.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (!nm) throw new Error(`${id}: unsupported namespace import: ${clause}`);
      out += `const ${nm[1]} = ${varName};\n`;
    } else if (rest.startsWith('{')) {
      const body = rest.slice(1, rest.lastIndexOf('}'));
      const pairs = body.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
        const am = x.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
        if (!am) throw new Error(`${id}: unsupported import specifier: ${x}`);
        return am[2] ? `${am[1]}: ${am[2]}` : am[1];
      });
      if (pairs.length) out += `const { ${pairs.join(', ')} } = ${varName};\n`;
    }
    return out;
  });

  src = src.replace(/^import\s+['"]([^'"]+)['"]\s*;?/gm, (all, spec) => `__req(${JSON.stringify(resolveSpecifier(spec, id))});\n`);

  // export { a, b as c } [from './x.js'];
  src = src.replace(/^export\s*\{([\s\S]*?)\}\s*(?:from\s+['"]([^'"]+)['"])?\s*;?/gm, (all, body, spec) => {
    const pairs = body.split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const am = x.match(/^([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/);
      if (!am) throw new Error(`${id}: unsupported export specifier: ${x}`);
      return [am[1], am[2] || am[1]];
    });
    if (spec) {
      const dep = `__re${seq++}`;
      let out = `const ${dep} = __req(${JSON.stringify(resolveSpecifier(spec, id))});\n`;
      for (const [from, as] of pairs) out += `exports[${JSON.stringify(as)}] = ${dep}[${JSON.stringify(from)}];\n`;
      return out;
    }
    return pairs.map(([from, as]) => `exports[${JSON.stringify(as)}] = ${from};\n`).join('');
  });

  const exported = [];
  src = src.replace(/^export\s+default\s+([\s\S]*?);?\s*$/gm, (all, expr) => {
    const e = expr.trim();
    return `exports.default = ${e};\n`;
  });

  src = src.replace(/^export\s+(async\s+)?function\s*(\*)?\s*([A-Za-z_$][\w$]*)/gm, (all, asyncKw, star, name) => {
    exported.push(name);
    return `${asyncKw || ''}function${star || ''} ${name}`;
  });
  src = src.replace(/^export\s+class\s+([A-Za-z_$][\w$]*)/gm, (all, name) => {
    exported.push(name);
    return `class ${name}`;
  });
  src = src.replace(/^export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm, (all, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });

  for (const name of exported) lines.push(`exports[${JSON.stringify(name)}] = ${name};`);
  return `${src}\n${lines.join('\n')}\n`;
}

/* ------------------------------- build -------------------------------- */

load(ENTRY);
// Loader order must place dependencies first; `order` is DFS post-order.
// Cyclic imports are handled lazily by __req and still work for functions.

let out = `/* WebOS-JS — single-file build. Generated by tools/bundle.mjs; do not edit. */\n`;
out += `const __defs = Object.create(null);\nconst __cache = Object.create(null);\n`;
out += `function __req(id) {\n  if (__cache[id]) return __cache[id].exports;\n`;
out += `  const module = { exports: {} };\n  __cache[id] = module;\n`;
out += `  const def = __defs[id];\n  if (!def) throw new Error('WebOS bundle: missing module ' + id);\n`;
out += `  def(module.exports, __req);\n  return module.exports;\n}\n\n`;

const ids = new Set(order);
for (const id of order) {
  if (!ids.has(id)) continue;
  out += `__defs[${JSON.stringify(id)}] = function (exports, __req) {\n${transform(id)}};\n\n`;
}

out += `const __entry = __req(${JSON.stringify(ENTRY)});\n`;
for (const name of ['createWebOS', 'Kernel', 'Shell']) out += `export const ${name} = __entry[${JSON.stringify(name)}];\n`;
out += `export default __entry.default;\n`;

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);
console.log(`bundled ${order.length} modules -> ${relative(ROOT, OUT)} (${out.length} bytes)`);
