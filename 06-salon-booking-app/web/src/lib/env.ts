// Tidies the two Supabase values typed into Netlify. Set up from a phone, they
// often arrive with extras: the whole line from Supabase's Connect panel
// (NEXT_PUBLIC_SUPABASE_URL=…), quote marks, no https://, the dashboard's
// address instead of the project's, or the two the wrong way round. Supabase
// throws on an address it can't use, which would leave a blank page.

export type SupabaseEnv = {
  url: string;
  key: string;
  /** Why the address still can't be used; null when it can (or is empty). */
  reason: string | null;
};

const QUOTES = /^["'`“”‘’]+|["'`“”‘’]+$/g;
const NAME = /^[A-Z][A-Z0-9_]*\s*=\s*/;
// "abcdefghijklmnop.supabase.co", or a Supabase page, with no https:// in front.
const BARE = /^(?:[a-z0-9-]+\.)*supabase\.com?(?:[/:?#]|$)/i;
const DASHBOARD = /^\/dashboard\/project\/([a-z0-9]+)(?:\/|$)/;

const looksLikeKey = (v: string) => /^(?:sb_|eyJ)/.test(v);
const looksLikeUrl = (v: string) => /^https?:\/\//i.test(v) || BARE.test(v);

/** ` NEXT_PUBLIC_SUPABASE_URL="https://…" ` → `https://…` */
function tidy(v: string | undefined): string {
  return (v ?? '').trim().replace(QUOTES, '').trim().replace(NAME, '').replace(QUOTES, '').trim();
}

/** Reduces the address to what Supabase wants: "https://<ref>.supabase.co". */
function cleanUrl(v: string): { url: string; reason: string | null } {
  if (!v) return { url: '', reason: null };
  if (BARE.test(v)) v = `https://${v}`;
  if (/\s/.test(v)) return { url: v, reason: 'it has spaces or line breaks in it' };
  let u: URL;
  try { u = new URL(v); } catch { return { url: v, reason: 'it isn’t a web address' }; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { url: v, reason: 'it doesn’t start with https://' };
  if (/^(?:www\.|app\.)?supabase\.com$/.test(u.hostname)) {
    const ref = DASHBOARD.exec(u.pathname)?.[1];
    if (ref) return { url: `https://${ref}.supabase.co`, reason: null };
    return { url: v, reason: 'it’s a page on the Supabase website, not the project’s address' };
  }
  // Supabase only answers over https; a page on https can't call http anyway.
  if (u.hostname.endsWith('.supabase.co')) u.protocol = 'https:';
  return { url: u.origin, reason: null };
}

export function tidySupabaseEnv(rawUrl: string | undefined, rawKey: string | undefined): SupabaseEnv {
  let url = tidy(rawUrl);
  let key = tidy(rawKey);
  if (looksLikeKey(url) && looksLikeUrl(key)) [url, key] = [key, url];
  return { ...cleanUrl(url), key };
}
