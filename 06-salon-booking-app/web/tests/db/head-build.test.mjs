// The page head's build step (vite.config.ts) against a stand-in for Supabase: what it asks for,
// what it takes from the reply, and that anything going wrong gives the generic head and one
// warning, never a failed deploy. Loads the real config through Vite, as `vite build` does, and
// runs its index.html step, without building the whole app. No database needed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile } from 'vite';

const WEB = fileURLToPath(new URL('../..', import.meta.url));
const INDEX = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const KEY = 'sb_publishable_TestKey_123';
const SETTINGS = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY', 'VITE_DEMO', 'VITE_PUBLIC_NAME', 'VITE_PUBLIC_DESCRIPTION',
  'VITE_SITE_URL', 'VITE_GOOGLE_SITE_VERIFICATION', 'URL'];
const GENERIC_TITLE = '<title>Book an appointment</title>';
const GENERIC_DESCRIPTION = '<meta name="description" content="See free times and book your appointment online." />';

// The stand-in answers each request as `answer` says, and remembers it.
let answer = (res) => res.end('{}');
const requests = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    answer(res);
  });
});
const json = (value) => (res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); };
let base;
before(async () => {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});
const live = () => ({ VITE_SUPABASE_URL: base, VITE_SUPABASE_ANON_KEY: KEY });

/**
 * Loads vite.config.ts as `vite build` (or the dev server, for 'serve') would with these settings
 * (every other one blank), and returns the page it makes, its warnings and the requests it sent.
 */
async function build(settings, command = 'build') {
  for (const k of SETTINGS) process.env[k] = settings[k] ?? '';
  requests.length = 0;
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const env = { command, mode: command === 'build' ? 'production' : 'development', isSsrBuild: false, isPreview: false };
    const { config } = await loadConfigFromFile(env, `${WEB}/vite.config.ts`, WEB, 'silent');
    const plugin = config.plugins.flat(Infinity).find((p) => p?.name === 'booking-head');
    assert.equal(plugin.transformIndexHtml.order, 'pre');
    const html = await plugin.transformIndexHtml.handler(INDEX, { path: '/index.html', filename: `${WEB}/index.html` });
    return { html, warnings, requests: [...requests] };
  } finally {
    console.warn = warn;
  }
}

test('a real build reads the business details once, from public_booking_info, with the tidied address and key', async () => {
  answer = json({
    business_name: 'Demo Nail Studio', tagline: 'Happy hands, happy you', strapline: 'Gel, BIAB, Nail art', location_note: 'Exampletown',
    // Public too, but not for the head: none of these may appear in it.
    booking_intro: 'INTRO-NOT-USED', legal_name: 'Sam Example', contact_email: 'sam@example.com', cancellation_policy: 'POLICY-NOT-USED',
    instagram_handle: 'demo.nails.example', services: [{ name: 'SERVICE-NOT-USED' }],
  });
  // Pasted from a phone: quote marks, /rest/v1 on the end, and the whole line from Supabase's Connect panel.
  const { html, warnings, requests } = await build({
    VITE_SUPABASE_URL: ` "${base}/rest/v1/" `, VITE_SUPABASE_ANON_KEY: `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}`, URL: 'https://book.example.com',
  });
  assert.equal(requests.length, 1);
  const [r] = requests;
  assert.equal(r.method, 'POST');
  assert.equal(r.url, '/rest/v1/rpc/public_booking_info');
  assert.equal(r.headers.apikey, KEY);
  assert.equal(r.headers.authorization, `Bearer ${KEY}`);
  assert.match(r.headers['content-type'], /^application\/json/);
  assert.equal(r.body, '{}');
  assert.deepEqual(warnings, []);

  // In place of the marker, at its indent, with the rest of index.html as it was.
  assert.ok(html.includes([
    '    <meta name="apple-mobile-web-app-title" content="Bookings" />',
    '    <title>Demo Nail Studio · Book online</title>',
    '    <meta name="description" content="Gel, BIAB, Nail art · Exampletown" />',
    '    <link rel="canonical" href="https://book.example.com/book" />',
  ].join('\n')), html);
  assert.ok(html.includes('    <meta property="og:image" content="https://book.example.com/og/booking-card.jpg" />\n'));
  assert.ok(html.includes('    <meta name="twitter:card" content="summary_large_image" />\n    <link rel="manifest" href="/manifest.webmanifest" />'));
  assert.ok(!html.includes('<!-- booking-head -->'));
  assert.equal(html.match(/<title>/g).length, 1);
  for (const unused of ['NOT-USED', 'Sam Example', 'sam@example.com', 'demo.nails.example', 'Happy hands', KEY, '127.0.0.1']) {
    assert.ok(!html.includes(unused), unused);
  }
});

test('her own words (VITE_PUBLIC_*) win; with both set nothing is fetched', async () => {
  answer = json({ business_name: 'Name In Settings', strapline: 'Words in Settings' });
  const both = await build({ ...live(), VITE_PUBLIC_NAME: "Jess & Amy's $& Nails", VITE_PUBLIC_DESCRIPTION: '  Nails by Jess and Amy in Exampletown.  ' });
  assert.equal(both.requests.length, 0);
  assert.deepEqual(both.warnings, []);
  // "$&" stays as typed: it's never read as a replacement pattern.
  assert.ok(both.html.includes('<title>Jess &amp; Amy&#39;s $&amp; Nails · Book online</title>'), both.html);
  assert.ok(both.html.includes('<meta name="description" content="Nails by Jess and Amy in Exampletown." />'));

  // Only the name: the description still comes from Settings.
  const name = await build({ ...live(), VITE_PUBLIC_NAME: 'Amy’s Nails' });
  assert.equal(name.requests.length, 1);
  assert.ok(name.html.includes('<title>Amy’s Nails · Book online</title>'));
  assert.ok(name.html.includes('<meta name="description" content="Words in Settings" />'));

  // Only the description: the name still comes from Settings.
  const words = await build({ ...live(), VITE_PUBLIC_DESCRIPTION: 'Nails by Amy.' });
  assert.equal(words.requests.length, 1);
  assert.ok(words.html.includes('<title>Name In Settings · Book online</title>'));
  assert.ok(words.html.includes('<meta name="description" content="Nails by Amy." />'));
});

test('the starting name in Settings is never advertised', async () => {
  answer = json({ business_name: 'My Nail Studio', strapline: 'Gel, BIAB' });
  const { html, warnings } = await build(live());
  assert.ok(html.includes(GENERIC_TITLE));
  assert.ok(!html.includes('My Nail Studio'));
  assert.ok(html.includes('<meta name="description" content="Gel, BIAB" />'));
  assert.deepEqual(warnings, []);
});

test('the demo build and the dev server never ask the database, and get the generic head', async () => {
  answer = json({ business_name: 'Name In Settings' });
  for (const [settings, command] of [[{ ...live(), VITE_DEMO: '1' }, 'build'], [live(), 'serve']]) {
    const { html, warnings, requests } = await build(settings, command);
    assert.equal(requests.length, 0, command);
    assert.deepEqual(warnings, [], command);
    assert.ok(html.includes(GENERIC_TITLE) && html.includes(GENERIC_DESCRIPTION), command);
  }
});

test('anything wrong gives the generic head and one warning line, never a failed build', async () => {
  const closed = createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const nobody = `http://127.0.0.1:${closed.address().port}`;
  await new Promise((resolve) => closed.close(resolve));

  const cases = [
    ['no Supabase details', {}, null, /no Supabase address and key/],
    ['an address that can’t be used', { VITE_SUPABASE_URL: 'my supabase address', VITE_SUPABASE_ANON_KEY: KEY }, null, /can’t be used/],
    ['nothing answering', { VITE_SUPABASE_URL: nobody, VITE_SUPABASE_ANON_KEY: KEY }, null, /couldn’t read the business details \(.+\)/],
    ['a server error', live(), (res) => { res.statusCode = 500; res.end('{"message":"oops"}'); }, /answered 500/],
    ['a wrong key', live(), (res) => { res.statusCode = 401; res.end('{"message":"Invalid API key"}'); }, /answered 401/],
    ['a page instead of JSON', live(), (res) => res.end('<html>Project paused</html>'), /couldn’t read the business details/],
    ['no settings', live(), json(null), /no business details/],
    ['a list', live(), json([{ business_name: 'Name In A List' }]), /no business details/],
  ];
  for (const [what, settings, reply, why] of cases) {
    if (reply) answer = reply;
    const { html, warnings } = await build(settings);
    assert.ok(html.includes(GENERIC_TITLE) && html.includes(GENERIC_DESCRIPTION), what);
    assert.equal(warnings.length, 1, `${what}: ${warnings.join(' | ')}`);
    assert.match(warnings[0], /^booking-head: .+, so the page head uses the generic title and description\.$/, what);
    assert.match(warnings[0], why, what);
    assert.ok(!warnings[0].includes('\n') && !warnings[0].includes(KEY), what);
  }
});

test('a database that never answers is given up on after 5 seconds', async () => {
  answer = () => { /* never answers */ };
  const started = Date.now();
  const { html, warnings, requests } = await build(live());
  const took = Date.now() - started;
  assert.equal(requests.length, 1);
  // Loading the config takes a moment too, more on a busy machine.
  assert.ok(took >= 4900 && took < 20000, `took ${took} ms`);
  assert.ok(html.includes(GENERIC_TITLE));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /didn’t answer within 5 seconds/);
});

test('the site address is VITE_SITE_URL, else Netlify’s URL, and only https', async () => {
  const canonical = (html) => /<link rel="canonical" href="([^"]+)" \/>/.exec(html)?.[1] ?? null;
  const own = await build({ VITE_DEMO: '1', VITE_SITE_URL: 'https://book.example.com/', URL: 'https://netlify-site.example.org' });
  assert.equal(canonical(own.html), 'https://book.example.com/book');
  assert.deepEqual(own.warnings, []);
  const netlify = await build({ VITE_DEMO: '1', URL: 'https://netlify-site.example.org' });
  assert.equal(canonical(netlify.html), 'https://netlify-site.example.org/book');

  // http isn't used (Netlify's address is, when there is one), and she's told why.
  const http = await build({ VITE_DEMO: '1', VITE_SITE_URL: 'http://book.example.com', URL: 'https://netlify-site.example.org' });
  assert.equal(canonical(http.html), 'https://netlify-site.example.org/book');
  assert.equal(http.warnings.length, 1);
  assert.match(http.warnings[0], /VITE_SITE_URL/);
  const none = await build({ VITE_DEMO: '1', VITE_SITE_URL: 'http://book.example.com' });
  assert.equal(canonical(none.html), null);
  assert.ok(!/og:url|og:image/.test(none.html));
});

test('the Google verification tag goes in only with a valid code', async () => {
  const good = await build({ VITE_DEMO: '1', VITE_GOOGLE_SITE_VERIFICATION: '<meta name="google-site-verification" content="AbC123-_x" />' });
  assert.ok(good.html.includes('<meta name="google-site-verification" content="AbC123-_x" />'));
  assert.deepEqual(good.warnings, []);
  const bad = await build({ VITE_DEMO: '1', VITE_GOOGLE_SITE_VERIFICATION: 'not a code!' });
  assert.ok(!bad.html.includes('google-site-verification'));
  assert.equal(bad.warnings.length, 1);
  assert.match(bad.warnings[0], /VITE_GOOGLE_SITE_VERIFICATION/);
});
