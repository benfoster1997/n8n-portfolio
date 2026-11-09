import { describe, expect, it } from 'vitest';
import {
  buildHead, CARD_ALT, cutAtWord, escapeHtml, FALLBACK_DESCRIPTION, FALLBACK_TITLE, headDescription, siteAddress,
  straplineText, verificationCode,
} from '../../src/lib/head';
import indexHtml from '../../index.html?raw';

// Invented business details, as in the demo.
const SITE = 'https://book.example.com';
const EVERY = {
  name: 'Demo Nail Studio',
  description: 'Gel, BIAB and nail art in Exampletown. See my free times and book online.',
  strapline: 'Gel, BIAB, Nail art',
  tagline: 'Happy hands, happy you',
  location: 'Exampletown — full address in your confirmation email',
  siteUrl: SITE,
  verification: 'AbC123exampleCode-_xyz',
};
const line = (head: string, has: string) => head.split('\n').find((l) => l.includes(has)) ?? null;

describe('buildHead (the booking page’s head, written into index.html when the app is built)', () => {
  it('writes the full set with every value, one tag per line', () => {
    expect(buildHead(EVERY).split('\n')).toEqual([
      '<title>Demo Nail Studio · Book online</title>',
      '<meta name="description" content="Gel, BIAB and nail art in Exampletown. See my free times and book online." />',
      '<link rel="canonical" href="https://book.example.com/book" />',
      '<meta property="og:type" content="website" />',
      '<meta property="og:site_name" content="Demo Nail Studio" />',
      '<meta property="og:title" content="Demo Nail Studio · Book online" />',
      '<meta property="og:description" content="Gel, BIAB and nail art in Exampletown. See my free times and book online." />',
      '<meta property="og:url" content="https://book.example.com/book" />',
      '<meta property="og:image" content="https://book.example.com/og/booking-card.jpg" />',
      '<meta property="og:image:type" content="image/jpeg" />',
      '<meta property="og:image:width" content="1200" />',
      '<meta property="og:image:height" content="630" />',
      `<meta property="og:image:alt" content="${CARD_ALT}" />`,
      '<meta property="og:locale" content="en_GB" />',
      '<meta name="twitter:card" content="summary_large_image" />',
      '<meta name="google-site-verification" content="AbC123exampleCode-_xyz" />',
    ]);
  });

  it('makes the description from the Settings words when there is no description of her own', () => {
    const head = buildHead({ ...EVERY, description: null });
    const words = 'Gel, BIAB, Nail art · Exampletown — full address in your confirmation email';
    expect(line(head, 'name="description"')).toBe(`<meta name="description" content="${words}" />`);
    expect(line(head, 'og:description')).toBe(`<meta property="og:description" content="${words}" />`);
  });

  it('falls back to generic words with nothing set, with no canonical link or picture without a site address', () => {
    const head = buildHead({});
    expect(head.split('\n')).toEqual([
      `<title>${FALLBACK_TITLE}</title>`,
      `<meta name="description" content="${FALLBACK_DESCRIPTION}" />`,
      '<meta property="og:type" content="website" />',
      `<meta property="og:title" content="${FALLBACK_TITLE}" />`,
      `<meta property="og:description" content="${FALLBACK_DESCRIPTION}" />`,
      '<meta property="og:locale" content="en_GB" />',
      '<meta name="twitter:card" content="summary_large_image" />',
    ]);
    expect(head).not.toContain('%VITE_');
    expect(head).not.toMatch(/canonical|og:url|og:image|og:site_name|undefined|null/);
    // With every value but the site address, still no links that need it.
    expect(buildHead({ ...EVERY, siteUrl: null })).not.toMatch(/canonical|og:url|og:image/);
  });

  it('counts blank or spaces-only values as unset', () => {
    const blank = { name: '   ', description: ' \n ', strapline: '', tagline: '\t', location: '  ', siteUrl: ' ', verification: '  ' };
    expect(buildHead(blank)).toBe(buildHead({}));
    expect(buildHead({ name: null, description: undefined })).toBe(buildHead({}));
  });

  it('escapes & < > " \' in every value, so nothing of hers can open a tag or end an attribute', () => {
    const head = buildHead({
      name: `Sam & Amy's "<Nails>"`,
      strapline: `Gel & BIAB`,
      location: `<b>Exampletown</b> "near the 'green'"`,
      siteUrl: SITE,
    });
    expect(line(head, '<title>')).toBe('<title>Sam &amp; Amy&#39;s &quot;&lt;Nails&gt;&quot; · Book online</title>');
    expect(line(head, 'og:site_name')).toBe('<meta property="og:site_name" content="Sam &amp; Amy&#39;s &quot;&lt;Nails&gt;&quot;" />');
    expect(line(head, 'name="description"')).toBe(
      '<meta name="description" content="Gel &amp; BIAB · &lt;b&gt;Exampletown&lt;/b&gt; &quot;near the &#39;green&#39;&quot;" />',
    );
    for (const m of head.matchAll(/content="([^"]*)"/g)) expect(m[1]).not.toMatch(/[<>"']/);
    expect(head).not.toContain('<b>');
    // Her description is escaped the same way.
    expect(line(buildHead({ description: `Tom & Jess's <i>"best"</i>` }), 'name="description"'))
      .toBe('<meta name="description" content="Tom &amp; Jess&#39;s &lt;i&gt;&quot;best&quot;&lt;/i&gt;" />');
  });

  it('never leaves %VITE_ text, even when her words contain it (Vite would swap it for a setting)', () => {
    const head = buildHead({ name: '100%VITE_SUPABASE_URL% Nails', description: '20% off %VITE_DEMO%', siteUrl: SITE });
    expect(head).not.toContain('%VITE_');
    expect(head).toContain('<title>100&#37;VITE_SUPABASE_URL&#37; Nails · Book online</title>');
    expect(escapeHtml('a & b < c > d " e \' f % g')).toBe('a &amp; b &lt; c &gt; d &quot; e &#39; f &#37; g');
  });

  it('never advertises the schema’s starting name, "My Nail Studio"', () => {
    for (const name of ['My Nail Studio', '  my nail  studio ', 'MY NAIL STUDIO']) {
      const head = buildHead({ name, strapline: 'Gel, BIAB', siteUrl: SITE });
      expect(line(head, '<title>'), name).toBe(`<title>${FALLBACK_TITLE}</title>`);
      expect(head, name).not.toMatch(/nail\s+studio/i);
      expect(head, name).not.toContain('og:site_name');
      // The rest of the Settings words still count.
      expect(line(head, 'name="description"'), name).toBe('<meta name="description" content="Gel, BIAB" />');
    }
    // A name that only starts the same way is her own.
    expect(line(buildHead({ name: 'My Nail Studio Exampletown' }), '<title>')).toBe('<title>My Nail Studio Exampletown · Book online</title>');
  });

  it('adds the Google verification tag only for a code of letters, digits, - and _', () => {
    const tag = (v: string) => line(buildHead({ verification: v }), 'google-site-verification');
    const good = '<meta name="google-site-verification" content="AbC123exampleCode-_xyz" />';
    expect(tag('AbC123exampleCode-_xyz')).toBe(good);
    expect(tag('  AbC123exampleCode-_xyz \n')).toBe(good);
    // Search Console's copy button gives the whole tag: the code is taken out of it.
    expect(tag('<meta name="google-site-verification" content="AbC123exampleCode-_xyz" />')).toBe(good);
    expect(tag('google-site-verification=AbC123exampleCode-_xyz')).toBe(good);
    for (const bad of ['', '   ', 'abc def', 'abc"><script>alert(1)</script>', 'abc.def', 'abc/def', 'café', '%VITE_CODE%', 'a'.repeat(201)]) {
      expect(tag(bad), bad).toBeNull();
      expect(verificationCode(bad), bad).toBeNull();
    }
  });
});

describe('headDescription (what Google shows under the title)', () => {
  it('uses her description first, then the strapline (or tagline) with the location', () => {
    expect(headDescription({ description: 'Nails by Sam.', strapline: 'Gel', location: 'Exampletown' })).toBe('Nails by Sam.');
    expect(headDescription({ strapline: 'Gel ♥ BIAB ♥ Nail art', tagline: 'Happy hands', location: 'Exampletown' }))
      .toBe('Gel, BIAB, Nail art · Exampletown');
    expect(headDescription({ tagline: 'Happy hands, happy you', location: 'Exampletown' })).toBe('Happy hands, happy you · Exampletown');
    expect(headDescription({ strapline: 'Gel, BIAB' })).toBe('Gel, BIAB');
    expect(headDescription({ location: 'Exampletown' })).toBe('Exampletown');
    expect(headDescription({})).toBe(FALLBACK_DESCRIPTION);
  });

  it('puts line breaks and runs of spaces on one line', () => {
    expect(headDescription({ description: '  Nails\n by   Sam \r\n in Exampletown ' })).toBe('Nails by Sam in Exampletown');
    expect(straplineText('Gel\nBIAB / Nail art |  Chrome')).toBe('Gel, BIAB, Nail art, Chrome');
    expect(straplineText(' ♥ , ')).toBeNull();
  });

  it('cuts at a word, to at most 155 characters', () => {
    const long = 'Gel polish, BIAB, builder gel infills, nail art, chrome, French tips, ombré, gems and charms, '
      + 'hand and foot treatments, all in my cosy home studio in Exampletown, with free parking right outside';
    expect(long.length).toBeGreaterThan(155);
    const cut = cutAtWord(long);
    expect(cut.length).toBeLessThanOrEqual(155);
    expect(cut.endsWith('…')).toBe(true);
    const kept = cut.slice(0, -1);
    expect(long.startsWith(kept)).toBe(true);
    expect(kept).toMatch(/\p{L}$/u); // ends on a whole word, not a comma or a space…
    expect(long[kept.length]).toMatch(/[^\p{L}\p{N}]/u); // …and the word wasn't cut through
    // The same cut when it's made from the Settings words.
    expect(headDescription({ strapline: 'Gel, BIAB, Nail art', location: long }).length).toBeLessThanOrEqual(155);
    expect(line(buildHead({ description: long }), 'name="description"')).toBe(`<meta name="description" content="${cut}" />`);
  });

  it('keeps text of exactly 155 characters whole, and cuts one very long word without breaking an emoji', () => {
    const exact = `${'word '.repeat(30)}12345`;
    expect(exact.length).toBe(155);
    expect(cutAtWord(exact)).toBe(exact);
    expect(cutAtWord(`${exact}6`)).toBe(`${'word '.repeat(30).trim()}…`);
    expect(cutAtWord('a'.repeat(200))).toBe(`${'a'.repeat(154)}…`);
    const emoji = cutAtWord(`x${'💅'.repeat(100)}`);
    expect(emoji.length).toBeLessThanOrEqual(155);
    expect(emoji).toMatch(/^x(?:💅)+…$/u);
  });
});

describe('siteAddress (VITE_SITE_URL, or Netlify’s own address)', () => {
  it('keeps just the https address, with no trailing slash', () => {
    expect(siteAddress('https://book.example.com/')).toBe(SITE);
    expect(siteAddress(' "https://book.example.com/book?from=card#top" ')).toBe(SITE);
    expect(siteAddress('book.example.com')).toBe(SITE);
    expect(siteAddress('HTTPS://Book.Example.com')).toBe(SITE);
    expect(siteAddress('https://netlify-site.example.org')).toBe('https://netlify-site.example.org');
  });

  it('takes http only on this computer, for the tests', () => {
    expect(siteAddress('http://localhost:4173')).toBe('http://localhost:4173');
    expect(siteAddress('http://127.0.0.1:4611/')).toBe('http://127.0.0.1:4611');
    for (const bad of ['http://book.example.com', 'ftp://book.example.com', 'javascript:alert(1)', 'not a site', '', '  ', undefined, null]) {
      expect(siteAddress(bad), String(bad)).toBeNull();
    }
  });

  it('is checked inside buildHead too', () => {
    expect(buildHead({ siteUrl: 'http://book.example.com' })).not.toMatch(/canonical|og:image/);
    expect(line(buildHead({ siteUrl: 'https://book.example.com/' }), 'canonical')).toBe('<link rel="canonical" href="https://book.example.com/book" />');
  });
});

describe('index.html', () => {
  it('has one marker for the head, and no title or description of its own', () => {
    expect(indexHtml.match(/<!-- booking-head -->/g)).toHaveLength(1);
    expect(indexHtml).not.toMatch(/<title|name="description"|og:|%VITE_/);
    // The home-screen tags stay.
    expect(indexHtml).toContain('<meta name="apple-mobile-web-app-title" content="Bookings" />');
    expect(indexHtml).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
  });
});
