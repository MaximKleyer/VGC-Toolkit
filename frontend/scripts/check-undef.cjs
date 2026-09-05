// Undeclared-identifier check for the frontend (a minimal "no-undef").
//
// Vite/esbuild only transpile — they happily bundle `{metaStale ? '⚠' : ''}`
// even when `metaStale` was never declared, and React then throws a
// ReferenceError at render time and the whole tab goes blank. This script
// parses every src/**/*.js(x) file with Babel (already installed via
// @vitejs/plugin-react) and reports any identifier that is neither bound in
// scope nor a known browser/ES global.
//
// Usage:  npm run lint            (also runs automatically before `npm run build`)
//         node scripts/check-undef.cjs [dir]   (defaults to ./src)
// Exit code 1 when problems are found, so it fails the build.
const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;

const FRONT = path.resolve(__dirname, '..');
const ROOT = process.argv[2] ? path.resolve(process.argv[2]) : path.join(FRONT, 'src');

// Browser / runtime globals not covered by Babel's built-in ES globals list.
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage',
  'sessionStorage', 'fetch', 'console', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame',
  'queueMicrotask', 'AbortController', 'URL', 'URLSearchParams', 'Blob', 'File',
  'FormData', 'Headers', 'Request', 'Response', 'Event', 'CustomEvent',
  'ResizeObserver', 'IntersectionObserver', 'MutationObserver', 'performance',
  'crypto', 'alert', 'confirm', 'prompt', 'TextEncoder', 'TextDecoder',
  'structuredClone', 'globalThis', 'process', 'HTMLElement', 'Node', 'Element',
  'KeyboardEvent', 'MouseEvent', 'Image', 'Audio', 'getComputedStyle',
  'matchMedia', 'scrollTo', 'innerWidth', 'innerHeight',
]);

function walk(dir, out = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p, out);
    else if (/\.(jsx?|mjs)$/.test(f.name)) out.push(p);
  }
  return out;
}

const files = walk(ROOT);
let problems = 0;
for (const file of files) {
  const rel = path.relative(FRONT, file);
  let ast;
  try {
    ast = parser.parse(fs.readFileSync(file, 'utf8'), { sourceType: 'module', plugins: ['jsx'] });
  } catch (e) {
    console.log(`PARSE ERROR ${rel}: ${e.message}`);
    problems++;
    continue;
  }
  traverse(ast, {
    ReferencedIdentifier(p) {
      const n = p.node.name;
      if (p.scope.hasBinding(n) || GLOBALS.has(n)) return;
      console.log(`${rel}:${p.node.loc.start.line}  undefined identifier '${n}'`);
      problems++;
    },
  });
}

console.log(
  `check-undef: ${files.length} files, ` +
    (problems ? `${problems} problem(s) found.` : 'no undefined identifiers.')
);
process.exit(problems ? 1 : 0);
