// The booking page's <head>: the title and description Google shows, and the preview card that
// WhatsApp, Instagram, Facebook and iMessage draw when someone shares the link. Link previews never
// run the page's scripts and every path serves the same index.html, so this is written into it when
// the app is built (vite.config.ts), from the business details in Settings or the VITE_PUBLIC_*
// overrides. Pure: no network, no globals, so the tests can check every line of it.
//
// The name a new database starts with (DEFAULT_BUSINESS_NAME, supabase/schema.sql) counts as unset,
// so the page never advertises it: until she types her own, the head says "Book an appointment".
import { DEFAULT_BUSINESS_NAME } from './text';

export const FALLBACK_TITLE = 'Book an appointment';
export const FALLBACK_DESCRIPTION = 'See free times and book your appointment online.';
/** Roughly what Google shows under a result before it cuts the text itself. */
export const DESCRIPTION_MAX = 155;
/** The preview picture (scripts/make-icons.mjs draws it), and how it is described. */
export const CARD_IMAGE = '/og/booking-card.jpg';
export const CARD_ALT = 'A pink nail polish bottle with lemon slices, leaves, white blossoms and little hearts';

export interface HeadValues {
  /** The business name. Blank, or still the schema's default, counts as unset. */
  name?: string | null;
  /** Her own description (VITE_PUBLIC_DESCRIPTION). Otherwise it is made from the next three. */
  description?: string | null;
  strapline?: string | null;
  tagline?: string | null;
  location?: string | null;
  /** Where the app lives, e.g. "https://book.example.com", for the preview picture. With none, there is no picture. */
  siteUrl?: string | null;
  /** The code from Google Search Console's "HTML tag" check (VITE_GOOGLE_SITE_VERIFICATION). */
  verification?: string | null;
}

/** Line breaks and runs of spaces become one space; blank or spaces-only is unset (null). */
export function clean(v: string | null | undefined): string | null {
  const t = (v ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

/** The business name to show, or null while it is blank or still the default. */
export function businessName(v: string | null | undefined): string | null {
  const n = clean(v);
  return n && n.toLowerCase() !== DEFAULT_BUSINESS_NAME.toLowerCase() ? n : null;
}

/**
 * "Demo Nail Studio · Book online", or "Book an appointment" while the name is blank or still the
 * default: the head's title, and the booking page's own once it has loaded (Book.tsx), so Google
 * reads the same title before and after the page's scripts run.
 */
export function bookingTitle(v: string | null | undefined): string {
  const name = businessName(v);
  return name ? `${name} · Book online` : FALLBACK_TITLE;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '%': '&#37;' };

/**
 * Safe inside an attribute or the title: & < > " ' become entities. So does %, so Vite's own
 * %VITE_…% replacement, which runs on the page after this, can never change her words.
 */
export function escapeHtml(v: string): string {
  return v.replace(/[&<>"'%]/g, (c) => ENTITIES[c]);
}

/** "Gel ♥ BIAB ♥ Nail art" → "Gel, BIAB, Nail art": the strapline as the booking page reads it out. */
export function straplineText(v: string | null | undefined): string | null {
  const parts = (v ?? '').split(/[,·|/♡♥\n]+/).map((p) => clean(p)).filter((p): p is string => !!p);
  return parts.length ? parts.join(', ') : null;
}

/** Cuts long text at the last whole word that fits, with "…", so it is at most `max` characters. */
export function cutAtWord(text: string, max = DESCRIPTION_MAX): string {
  if (text.length <= max) return text;
  const space = text.lastIndexOf(' ', max - 1);
  let cut = space > 0 ? text.slice(0, space).replace(/[\s,;:·•|/–—-]+$/, '') : '';
  if (!cut) {
    // One very long word: cut it, but never through the middle of an emoji.
    cut = text.slice(0, max - 1);
    if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** Her description, else the strapline (or tagline) and the location, else the generic line. */
export function headDescription(v: Pick<HeadValues, 'description' | 'strapline' | 'tagline' | 'location'>): string {
  const own = clean(v.description);
  const made = [straplineText(v.strapline) ?? clean(v.tagline), clean(v.location)].filter(Boolean).join(' · ');
  const text = own ?? (made || null);
  return text ? cutAtWord(text) : FALLBACK_DESCRIPTION;
}

const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;

/**
 * "https://book.example.com/" (or "book.example.com/book") → "https://book.example.com".
 * Only https, except http on this computer (localhost, 127.0.0.1) for the tests; null otherwise.
 */
export function siteAddress(raw: string | null | undefined): string | null {
  let v = (raw ?? '').trim().replace(QUOTES, '').trim();
  if (!v) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) v = `https://${v}`;
  let u: URL;
  try { u = new URL(v); } catch { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null;
  return u.origin;
}

/**
 * The verification code: letters, digits, - and _ only, or null. Search Console's copy button
 * gives the whole <meta … content="…"> tag, so the code is taken out of a pasted tag too.
 */
export function verificationCode(raw: string | null | undefined): string | null {
  let v = clean(raw);
  if (!v) return null;
  const tag = /\bcontent\s*=\s*["'“”]?([^"'“”\s>]*)/i.exec(v);
  if (tag) v = tag[1];
  v = v.replace(QUOTES, '').replace(/^google-site-verification\s*[=:]\s*/i, '');
  return /^[A-Za-z0-9_-]{1,200}$/.test(v) ? v : null;
}

/**
 * The tags that replace <!-- booking-head --> in index.html, one per line.
 *
 * Deliberately no og:url and no canonical link. Every address serves this same page, so either would
 * say plain /book is the page for all of them, and Facebook and Messenger take that (og:url, else the
 * canonical link) as the address of a shared link. A shared …/book?treatment=biab-infill&from=free-times
 * could then open the treatment list, and Money would lose where the visit came from. Without them,
 * each link is kept as it was shared.
 */
export function buildHead(v: HeadValues): string {
  const name = businessName(v.name);
  const title = bookingTitle(v.name);
  const description = headDescription(v);
  const site = siteAddress(v.siteUrl);
  const code = verificationCode(v.verification);
  const meta = (attr: 'name' | 'property', key: string, value: string) => `<meta ${attr}="${key}" content="${escapeHtml(value)}" />`;
  const tags: (string | null)[] = [
    `<title>${escapeHtml(title)}</title>`,
    meta('name', 'description', description),
    meta('property', 'og:type', 'website'),
    name && meta('property', 'og:site_name', name),
    meta('property', 'og:title', title),
    meta('property', 'og:description', description),
    // Only with a real address: a preview card needs an absolute link to its picture.
    site && meta('property', 'og:image', `${site}${CARD_IMAGE}`),
    site && meta('property', 'og:image:type', 'image/jpeg'),
    site && meta('property', 'og:image:width', '1200'),
    site && meta('property', 'og:image:height', '630'),
    site && meta('property', 'og:image:alt', CARD_ALT),
    meta('property', 'og:locale', 'en_GB'),
    meta('name', 'twitter:card', 'summary_large_image'),
    code && meta('name', 'google-site-verification', code),
  ];
  return tags.filter(Boolean).join('\n');
}
