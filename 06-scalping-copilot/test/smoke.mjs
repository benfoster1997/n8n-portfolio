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
 * prime, final stretch, an NFP blackout), walks every tab on both instruments
 * in both the simple and the full view, and reports page errors, horizontal
 * overflow at iPhone width, and any "undefined" or "NaN" that reaches the screen.
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
  'before the open 07:30': Date.UTC(2026, 6, 15, 6, 30),
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

  const leaks = [];
  const checkText = async (where) => {
    const bad = await p.evaluate(() => {
      const t = document.body.innerText;
      const m = t.match(/.{0,40}\b(undefined|NaN)\b.{0,40}/);
      return m ? m[0] : null;
    });
    if (bad) leaks.push(`${where}: "${bad.trim()}"`);
  };
  const setView = (v) => p.evaluate((v) => {
    const e = document.getElementById('view-mode');
    e.value = v; e.dispatchEvent(new Event('change'));
  }, v);

  for (const view of ['simple', 'full']) {
    await setView(view);
    for (const pair of ['XAUUSD', 'BTCUSD']) {
      await p.evaluate((x) => document.getElementById('pair-' + x).click(), pair);
      await p.waitForTimeout(500);
      for (const tab of ['read', 'news', 'risk', 'setup', 'read']) {
        await p.evaluate((t) => document.getElementById('nav-' + t).click(), tab);
        await p.waitForTimeout(150);
        await checkText(`${view}/${pair}/${tab}`);
      }
    }
  }
  // The brief: fill the plan in, then tap the trade counter past the plan.
  await p.evaluate(() => document.getElementById('nav-read').click());
  await p.evaluate(() => {
    const click = (sel) => { const e = document.querySelector(sel); if (e) e.click(); };
    const set = (id, v) => { const e = document.getElementById(id); if (e) { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true })); } };
    click('[data-brief="open-form"]');
    click('[data-brief="set"]');                    // refused: nothing chosen yet
    click('[data-brief="chip"]');
    set('brief-max', '2');
    set('brief-hi', '4402.5'); set('brief-lo', '4380'); set('brief-now', '4399');
    click('[data-brief="set"]');
    for (let k = 0; k < 3; k++) click('[data-brief="inc"]');
    click('[data-brief="dec"]');
  });
  await p.waitForTimeout(200);
  await checkText('brief');

  // The how-to card, every step opened, must read cleanly too.
  await p.evaluate(() => {
    document.getElementById('nav-setup').click();
    document.querySelectorAll('#howto details').forEach((d) => { d.open = true; });
  });
  await p.waitForTimeout(150);
  await checkText('how-to card');
  if (!(await p.evaluate(() => document.querySelectorAll('#howto details').length === 5))) leaks.push('how-to card: expected 5 steps');
  await p.evaluate(() => document.getElementById('nav-read').click());

  // The simple read must say something, in either instrument.
  await setView('simple');
  const answer = await p.evaluate(() => document.getElementById('simple-read').innerText.trim());
  if (!answer) leaks.push('simple view: the answer card is empty');

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
    set('live-spread', '0.05'); set('stop-dist', '3.00'); set('commission', '2.75');
    set('max-volume', '100'); set('live-balance', '5000'); set('size-from', 'shadow');
    set('rec-planned', '300'); set('rec-trades', '30'); set('rec-wins', '18');
  });
  await p.waitForTimeout(500);
  await checkText('size tab with inputs');
  for (const e of leaks) errors.push(e);

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
