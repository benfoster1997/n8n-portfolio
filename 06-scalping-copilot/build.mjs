/**
 * build.mjs — inline the ES modules into one self-contained index.html.
 *
 * Why a build step at all: the source stays modular and testable under node,
 * while what ships is a single file with no imports, no CORS problem and no
 * dependency on being served. That matters because the file has to work when
 * opened from anywhere, including offline — the news calendar, the session
 * clock and the risk maths need no network at all.
 *
 * Run: node build.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = (f) => join(here, 'src', f);

// Dependency order. Concatenated into one module scope, so this must be a
// valid topological order of the import graph.
const MODULES = [
  'timezone.js',
  'indicators.js',
  'instruments.js',
  'risk.js',
  'news-calendar.js',
  'sessions.js',
  'data-feeds.js',
  'signal-engine.js',
  'edge-test.js',
  'app.js',
];

const IMPORT_RE = /^import[\s\S]*?from\s+['"][^'"]+['"];[ \t]*$/gm;
const EXPORT_LIST_RE = /^export\s*\{[^}]*\};[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(?=(?:async\s+)?(?:function|const|let|var|class))/gm;

/** Top-level declaration names, used to catch shadowing between modules. */
function topLevelNames(code) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
}

let bundle = '';
const seen = new Map();
const collisions = [];

for (const file of MODULES) {
  let code = readFileSync(src(file), 'utf8');
  code = code.replace(IMPORT_RE, '').replace(EXPORT_LIST_RE, '').replace(EXPORT_DECL_RE, '');

  for (const n of topLevelNames(code)) {
    if (seen.has(n)) collisions.push(`${n}: ${seen.get(n)} and ${file}`);
    else seen.set(n, file);
  }

  bundle += `\n/* ======================= ${file} ======================= */\n${code.trim()}\n`;
}

if (collisions.length) {
  console.error('Refusing to build — duplicate top-level names would silently shadow:');
  for (const c of collisions) console.error('  ' + c);
  process.exit(1);
}

const leftoverImport = /^\s*import\s/m.test(bundle);
const leftoverExport = /^\s*export\s/m.test(bundle);
if (leftoverImport || leftoverExport) {
  console.error('Refusing to build — an import/export survived the strip.');
  const bad = bundle.split('\n').filter((l) => /^\s*(import|export)\s/.test(l));
  bad.slice(0, 10).forEach((l) => console.error('  ' + l.trim()));
  process.exit(1);
}

const template = readFileSync(src('index.template.html'), 'utf8');
if (!template.includes('/*__BUNDLE__*/')) {
  console.error('Refusing to build — the template has no /*__BUNDLE__*/ marker.');
  process.exit(1);
}

const html = template.replace('/*__BUNDLE__*/', () => bundle);
const out = join(here, 'index.html');
writeFileSync(out, html);

const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
console.log(`built index.html — ${kb} KB, ${MODULES.length} modules, ${seen.size} top-level names, no collisions`);
