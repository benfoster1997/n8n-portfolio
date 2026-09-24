/**
 * smoke.mjs — load the built page in a real browser and fail on any page error.
 *
 * Why this exists separately from run-all.mjs: the unit suites exercise the
 * modules, not the DOM. Twice during development they stayed fully green while
 * the page itself was broken — once when a careless edit deleted renderFeed and
 * renderRead, once when a variable was referenced outside its scope. Both were
 * caught only by loading the page at several frozen times of day and watching
 * for pageerror. This is that check, kept.
 *
 * It freezes the clock at a spread of London-session moments (open, dead zone,
 * prime, final stretch, an NFP blackout), walks every tab on both instruments,
 * and reports page errors and horizontal overflow at iPhone width.
 *
 *   node build.mjs && node test/smoke.mjs
 *
 * Needs playwright. It is not a project dependency (the tool itself has none),
 * so install it somewhere throwaway if it is not already resolvable:
 *   (cd /tmp && npm i --no-save playwright@1.47.2)
 * In the Claude Code cloud container, Chromium is preinstalled under
 * /opt/pw-browsers; the headless_shell build is used because playwright 1.47
 * launches in old-headless mode, which the full chrome binary no longer has.
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

let chromium;
try {
  const resolved = require.resolve('playwright', {
    paths: [join(here, '..'), process.cwd(), '/tmp', tmpdir()],
  });
  ({ chromium } = require(resolved));
} catch {
  console.error('playwright is not installed anywhere resolvable.');
  console.error('  (cd /tmp && npm i --no-save playwright@1.47.2)');
  process.exit(2);
}

/** Prefer an explicit path, then the preinstalled cloud-container shell. */
function browserPath() {
  if (process.env.PW_CHROMIUM) return process.env.PW_CHROMIUM;
  const base = '/opt/pw-browsers';
  if (!existsSync(base)) return undefined;
  const shell = readdirSync(base).find((d) => d.startsWith('chromium_headless_shell-'));
  const p = shell && join(base, shell, 'chrome-linux', 'headless_shell');
  return p && existsSync(p) ? p : undefined;
}

// Mimic the Artifact publish skeleton so the local render matches what ships.
const body = readFileSync(join(here, '..', 'index.html'), 'utf8');
const page = '<!doctype html><html><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
  + '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
  + 'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui;'
  + 'background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style>'
  + '</head><body>' + body + '</body></html>';
const harness = join(tmpdir(), 'scalp-desk-smoke.html');
writeFileSync(harness, page);

// 15 Jul 2026 is a Wednesday in BST, so London = UTC+1. 2 Jul 2026 is the
// real NFP date (a Thursday, because 3 Jul is the observed holiday).
const MOMENTS = {
  'London satellite 08:30': Date.UTC(2026, 6, 15, 7, 30),
  'dead zone 10:30': Date.UTC(2026, 6, 15, 9, 30),
  'prime 13:45': Date.UTC(2026, 6, 15, 12, 45),
  'final stretch 15:45': Date.UTC(2026, 6, 15, 14, 45),
  'NFP blackout 13:25': Date.UTC(2026, 6, 2, 12, 25),
  'Saturday': Date.UTC(2026, 6, 18, 12, 0),
};

const freezeClock = (ms) => `{
  const T = ${ms}; const R = Date;
  window.Date = class extends R {
    constructor(...a) { if (!a.length) super(T); else super(...a); }
    static now() { return T; }
  };
  Object.setPrototypeOf(window.Date, R);
  window.Date.UTC = R.UTC; window.Date.parse = R.parse;
}`;

const browser = await chromium.launch({ executablePath: browserPath() });
let failures = 0;

for (const [label, ms] of Object.entries(MOMENTS)) {
  const p = await browser.newPage({ viewport: { width: 440, height: 956 }, deviceScaleFactor: 2 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(freezeClock(ms));
  await p.goto('file://' + harness);
  await p.waitForTimeout(1200);

  for (const pair of ['XAUUSD', 'BTCUSD']) {
    await p.evaluate((x) => document.getElementById('pair-' + x).click(), pair);
    await p.waitForTimeout(500);
    for (const tab of ['read', 'news', 'risk', 'setup', 'read']) {
      await p.evaluate((t) => document.getElementById('nav-' + t).click(), tab);
      await p.waitForTimeout(150);
    }
  }

  // Exercise the Size tab with real inputs, which is where most logic lives.
  await p.evaluate(() => document.getElementById('nav-risk').click());
  await p.evaluate(() => {
    const set = (id, v) => {
      const e = document.getElementById(id);
      if (!e) return;
      e.value = v;
      e.dispatchEvent(new Event('input'));
      e.dispatchEvent(new Event('change'));
    };
    set('live-spread', '0.05'); set('stop-dist', '3.00'); set('commission', '7');
    set('max-volume', '100'); set('live-balance', '5000'); set('size-from', 'shadow');
    set('rec-planned', '300'); set('rec-trades', '30'); set('rec-wins', '18');
  });
  await p.waitForTimeout(500);

  const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  const unique = [...new Set(errors)];
  const ok = unique.length === 0 && !overflow;
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label}${overflow ? '  [horizontal overflow]' : ''}`);
  for (const e of unique) console.log('         ' + e);
  await p.close();
}

await browser.close();
console.log(`\n${Object.keys(MOMENTS).length - failures} of ${Object.keys(MOMENTS).length} moments clean\n`);
process.exit(failures ? 1 : 0);
