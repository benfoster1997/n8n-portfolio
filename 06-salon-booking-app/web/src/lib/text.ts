// Small text helpers: phone numbers, money, WhatsApp links, message templates,
// the booking page's add-ons menu and social handles, and checks on what's typed
// (a review link, an email address that looks mistyped).
import type { Appointment, Settings } from './types';
import { fmtDayLong, fmtTime } from './time';

/** "07700 900123" → "447700900123". Same rules as public.normalize_uk_phone(). */
export function normalizeUkPhone(p: string | null | undefined): string | null {
  if (!p) return null;
  let d = p.replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('440')) d = '44' + d.slice(3);
  if (d.startsWith('0')) d = '44' + d.slice(1);
  else if (d.length === 10 && d.startsWith('7')) d = '44' + d;
  return d;
}

export function isPlausiblePhone(p: string): boolean {
  const n = normalizeUkPhone(p);
  return !!n && n.length >= 10 && n.length <= 15;
}

export function isPlausibleEmail(e: string): boolean {
  // No ? & # %: they could smuggle extra fields (cc, body) into a mailto: link.
  return e.length <= 254 && /^[^@\s?&#%]+@[^@\s?&#%]+\.[^@\s?&#%]+$/.test(e.trim());
}

/** 2500 → "£25", 2550 → "£25.50" */
export function money(pence: number): string {
  const neg = pence < 0;
  const abs = Math.abs(pence);
  const s = abs % 100 === 0 ? `£${(abs / 100).toLocaleString('en-GB')}` : `£${(abs / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return neg ? `−${s}` : s;
}

/** Always two decimals, for reports: 2500 → "25.00" */
export function moneyPlain(pence: number): string {
  return (pence / 100).toFixed(2);
}

/** "25", "25.5", "£25.50", "25,50", "1,250" → pence. Returns null if it isn't a sensible amount. */
export function parsePounds(input: string): number | null {
  let t = input.replace(/[£\s]/g, '');
  // Phones set to a European region type a decimal comma: "25,50" means £25.50, not £2,550.
  if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');
  else if (/^\d{1,3}(,\d{3})+(\.\d{1,2})?$/.test(t)) t = t.replace(/,/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const pence = Math.round(parseFloat(t) * 100);
  return Number.isFinite(pence) ? pence : null;
}

/** A link that opens WhatsApp with the message ready to send. */
export function whatsappLink(phoneE164: string, text: string): string {
  return `https://wa.me/${phoneE164.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

export function firstName(fullName: string | null | undefined): string {
  return (fullName ?? '').trim().split(/\s+/)[0] ?? '';
}

/** The business name a new install starts with (settings.business_name's default): she hasn't set hers yet. */
export const DEFAULT_BUSINESS_NAME = 'My Nail Studio';

export const DEFAULT_TEMPLATES = {
  reminder:
    'Hi {first_name}! Just a reminder of your {service} appointment on {date} at {time}. 💅\n\n' +
    '{change_note}\n\nSee you then!\n{business}',
  deposit:
    'Hi {first_name}, thanks for booking {service} on {date} at {time}. To secure your appointment please send the {deposit} deposit by bank transfer:\n\n' +
    'Name: {bank_name}\nSort code: {sort_code}\nAccount: {account_number}\nReference: {reference}\n\n' +
    'Thank you! {business}',
  confirmed:
    "Hi {first_name}, you're booked in for {service} on {date} at {time}. See you soon!\n\n" +
    '{change_note}\n{business}',
  // After Mark as done. Asks, and offers nothing for it: Google doesn't allow rewarded reviews.
  review:
    'Hi {first_name}, thank you so much for coming in! 💅\n\n' +
    'If you have a minute, a quick Google review would really help me:\n{review_link}\n\n' +
    '{business}',
} as const;

export type TemplateKind = keyof typeof DEFAULT_TEMPLATES;

const CUSTOM_TEMPLATE: Record<TemplateKind, 'wa_template_reminder' | 'wa_template_deposit' | 'wa_template_confirmed' | 'wa_template_review'> = {
  reminder: 'wa_template_reminder', deposit: 'wa_template_deposit', confirmed: 'wa_template_confirmed', review: 'wa_template_review',
};

/** Her own wording for a message, or the default when she hasn't written one. */
export function templateFor(kind: TemplateKind, s: Settings): string {
  const custom = s[CUSTOM_TEMPLATE[kind]];
  return custom && custom.trim() ? custom : DEFAULT_TEMPLATES[kind];
}

/** The client's own page for changing or cancelling this booking. */
export function manageLink(a: Pick<Appointment, 'public_token'>, s: Pick<Settings, 'public_site_url'>): string {
  const base = s.public_site_url || (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base.replace(/\/+$/, '')}/manage/${a.public_token}`;
}

/** The last moment to change or cancel without being inside the notice period (the start time if there is none). */
export function freeChangeDeadline(startsAt: string, noticeHours: number): Date {
  return new Date(new Date(startsAt).getTime() - Math.max(0, noticeHours) * 3600e3);
}

/**
 * A late cancellation made before the notice period started: it counts as late only because the
 * client had already changed the booking inside the notice period. The same test as Code.gs
 * lateFromEarlierChange_, for the client's cancels and the owner's alike. Never with no notice period.
 */
export function lateFromEarlierChange(a: Pick<Appointment, 'cancelled_late' | 'cancelled_at' | 'starts_at'>, noticeHours: number): boolean {
  return !!a.cancelled_late && !!a.cancelled_at && noticeHours > 0
    && new Date(a.cancelled_at).getTime() < freeChangeDeadline(a.starts_at, noticeHours).getTime();
}

/** "48 hours", "1 hour" */
export const hoursLabel = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
/** "48 hours’ notice", "1 hour’s notice" */
export const noticeLabel = (n: number) => `${n} hour${n === 1 ? '’s' : 's’'} notice`;

/**
 * "Need to change or cancel?" in words that fit the moment: the link and the
 * date to change by while that's still ahead, a note that the policy now
 * applies once it has passed or after a change inside the notice period, the
 * link alone with no notice period, or "get in touch" when online changes are off.
 */
export function changeNote(a: Appointment, s: Settings, now: Date = new Date()): string {
  if (!s.client_self_service) return 'Need to change or cancel? Just get in touch.';
  const link = manageLink(a, s);
  const notice = s.cancel_notice_hours ?? 0;
  // No notice period: the policy is off, even after an earlier change.
  if (notice <= 0) return `Need to change or cancel? ${link}`;
  const by = freeChangeDeadline(a.starts_at, notice);
  if (by.getTime() <= now.getTime()) {
    return `Need to change or cancel? ${link} (it’s now less than ${hoursLabel(notice)} before, so the cancellation policy applies)`;
  }
  // Still ahead of the deadline, but already changed inside the notice period (and maybe moved further out since).
  if (a.late_fee_pence != null) {
    return `Need to change or cancel? ${link} (as you changed this booking with less than ${noticeLabel(notice)}, the cancellation policy applies if you cancel)`;
  }
  return `Need to change or cancel? Please do it by ${fmtDayLong(by, s.timezone)} at ${fmtTime(by, s.timezone)}: ${link}`;
}

/** Fill {placeholders} in a message template for one appointment. Unknown placeholders are left as typed. */
export function fillTemplate(template: string, a: Appointment, s: Settings, now: Date = new Date()): string {
  const changeBy = freeChangeDeadline(a.starts_at, s.cancel_notice_hours ?? 0);
  const values: Record<string, string> = {
    first_name: firstName(a.client?.full_name ?? a.booking_name),
    name: a.client?.full_name ?? a.booking_name ?? '',
    service: a.service_name,
    date: fmtDayLong(a.starts_at, s.timezone),
    time: fmtTime(a.starts_at, s.timezone),
    business: s.business_name,
    deposit: money(a.deposit_required_pence || s.deposit_amount_pence),
    price: money(a.price_pence),
    reference: a.reference,
    bank_name: s.bank_account_name ?? '',
    sort_code: s.bank_sort_code ?? '',
    account_number: s.bank_account_number ?? '',
    manage_link: manageLink(a, s),
    // Can be in the past for an appointment already inside the notice period: {change_note} words that for you.
    change_by: `${fmtDayLong(changeBy, s.timezone)} at ${fmtTime(changeBy, s.timezone)}`,
    change_note: changeNote(a, s, now),
    review_link: s.review_link ?? '',
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

export const TEMPLATE_PLACEHOLDERS = [
  '{first_name}', '{name}', '{service}', '{date}', '{time}', '{price}', '{deposit}',
  '{reference}', '{bank_name}', '{sort_code}', '{account_number}', '{business}',
  '{change_note}', '{manage_link}', '{change_by}', '{review_link}',
];

/** One section of the add-ons menu: a heading (null for lines before the first one), its items and notes. */
export interface MenuSection {
  title: string | null;
  items: { name: string; price: string }[];
  notes: string[];
}

/**
 * Read the add-ons menu the owner types in Settings → Booking page (settings.extras_menu).
 * One entry per line:
 *   "Name | price"  an item, e.g. "Simple nail art | 50p per nail" (split at the first "|")
 *   "> text"        a note under the current section
 *   anything else   a section heading
 * Blank lines are ignored. Items and notes before the first heading go in a section
 * with title null. A line with nothing before its "|" is skipped; one with nothing
 * after it is an item with price "".
 */
export function parseMenu(text: string | null | undefined): MenuSection[] {
  const sections: MenuSection[] = [];
  const current = () => {
    if (!sections.length) sections.push({ title: null, items: [], notes: [] });
    return sections[sections.length - 1];
  };
  for (const raw of (text ?? '').split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('>')) {
      const note = line.slice(1).trim();
      if (note) current().notes.push(note);
    } else if (line.includes('|')) {
      const bar = line.indexOf('|');
      const name = line.slice(0, bar).trim();
      if (name) current().items.push({ name, price: line.slice(bar + 1).trim() });
    } else {
      sections.push({ title: line, items: [], notes: [] });
    }
  }
  return sections;
}

export type SocialSite = 'instagram' | 'facebook';

/** The same patterns as the checks on settings.instagram_handle and facebook_handle. */
export const SOCIAL_SITES: Record<SocialSite, { label: string; pattern: RegExp; hosts: RegExp; problem: string }> = {
  instagram: {
    label: 'Instagram', pattern: /^[A-Za-z0-9._]{1,30}$/, hosts: /^(instagram\.com|instagr\.am)$/i,
    problem: 'Check your Instagram handle: just the name after the @, like yournailstudio (letters, numbers, dots and underscores, up to 30).',
  },
  facebook: {
    label: 'Facebook', pattern: /^[A-Za-z0-9.]{5,50}$/, hosts: /^(facebook\.com|fb\.com|fb\.me)$/i,
    problem: 'Check your Facebook page name: the part after facebook.com/, like YourNailStudio (letters, numbers and dots, at least 5). '
      + 'If your page’s web address ends in a number, give the page a username in Facebook first.',
  },
};

// A pasted profile link: the site, then the path.
const SOCIAL_LINK = /^(?:https?:\/\/)?(?:(?:www|m|mobile|web)\.)?(instagram\.com|instagr\.am|facebook\.com|fb\.com|fb\.me)(?=$|[/?#])(?:\/+([^?#\s]*))?/i;
// Paths that are pages of the site, not someone's handle.
const NOT_A_HANDLE = /^(profile\.php|people|pages|pg|groups|share|sharer\.php|p|reel|reels|explore|stories|tv|video|watch|events)$/i;

/** Which site a pasted link is for, and the handle in it (null when there isn't one, e.g. a profile number or a post). */
function linkHandle(t: string): { site: SocialSite; handle: string | null } | null {
  const m = SOCIAL_LINK.exec(t);
  if (!m) return null;
  const site = (Object.keys(SOCIAL_SITES) as SocialSite[]).find((k) => SOCIAL_SITES[k].hosts.test(m[1]))!;
  const first = (m[2] ?? '').split('/')[0].replace(/^@+/, '');
  return { site, handle: first && !NOT_A_HANDLE.test(first) ? first : null };
}

/**
 * "@yournailstudio", "https://www.instagram.com/yournailstudio/?hl=en" or
 * "facebook.com/yournailstudio" → "yournailstudio". Blank → null. A link with no
 * handle in it comes back as typed. Use checkHandle() to check the result too.
 */
export function cleanHandle(input: string | null | undefined): string | null {
  const t = (input ?? '').trim();
  const link = linkHandle(t);
  if (link) return link.handle ?? t;
  return t.replace(/^@+/, '').trim() || null;
}

/**
 * Tidy a handle or pasted profile link for one site and check it against the
 * database's rule, with a friendly message when it won't do. Blank is fine: no link is shown.
 */
export function checkHandle(site: SocialSite, input: string | null | undefined): { handle: string | null; error: string | null } {
  const t = (input ?? '').trim();
  if (!t) return { handle: null, error: null };
  const s = SOCIAL_SITES[site];
  const link = linkHandle(t);
  if (link && link.site !== site) {
    return { handle: null, error: `That’s a link to ${SOCIAL_SITES[link.site].label}. Paste your ${s.label} link here, or just your handle.` };
  }
  const handle = link ? link.handle : cleanHandle(t);
  return handle && s.pattern.test(handle) ? { handle, error: null } : { handle: null, error: s.problem };
}

/** The public profile link for a checked handle. */
export function socialLink(site: SocialSite, handle: string): string {
  const h = encodeURIComponent(handle);
  return site === 'instagram' ? `https://www.instagram.com/${h}/` : `https://www.facebook.com/${h}`;
}

// Her Google review link: Google gives it as g.page/r/…/review, a short maps.app.goo.gl or
// goo.gl link, or a google.com (or google.co.uk) address such as search.google.com/local/writereview.
const GOOGLE_HOSTS = /^(?:www\.)?(?:g\.page|maps\.app\.goo\.gl|goo\.gl)$|(?:^|\.)google\.(?:com|co\.uk)$/;

/**
 * Check a review link before it's saved (trim it first): ok only for an https link with no spaces,
 * as settings.review_link allows (up to 298 characters). warn when it isn't one of Google's,
 * so she can check it's the right link: it still saves.
 */
export function isReviewLink(url: string | null | undefined): { ok: boolean; warn: boolean } {
  const t = (url ?? '').trim();
  if (!/^https:\/\/\S+$/.test(t) || t.length > 298) return { ok: false, warn: false };
  let host: string;
  try {
    host = new URL(t).hostname.toLowerCase();
  } catch {
    return { ok: false, warn: false };
  }
  return { ok: true, warn: !GOOGLE_HOSTS.test(host) };
}

// The addresses most clients use, and other real ones close to them: those are never "corrected"
// into one of the first, and a mistyped one is put right as itself (email.co → email.com, not gmail.com).
const EMAIL_DOMAINS = ['gmail.com', 'googlemail.com', 'hotmail.com', 'hotmail.co.uk', 'outlook.com', 'live.co.uk',
  'icloud.com', 'me.com', 'yahoo.com', 'yahoo.co.uk', 'btinternet.com', 'aol.com'];
const REAL_LOOKALIKES = new Set(['mail.com', 'email.com', 'gmx.com', 'gmx.co.uk', 'mac.com', 'live.com', 'sky.com',
  'ntlworld.com', 'ymail.com']);
const KNOWN_DOMAINS = [...EMAIL_DOMAINS, ...REAL_LOOKALIKES];
/** The endings those have. Any other well-formed one (yahoo.co.in, hotmail.ca, live.co.za) is someone's real address. */
const KNOWN_ENDINGS = ['com', 'co.uk'];
/**
 * A provider's name shorter than this (me, aol, live, gmx…) is never changed, only its ending: one letter
 * away from one of those is often someone else's real domain. A name typed shorter than it gets one letter
 * put right at most (gmai → gmail), and one of three letters or fewer none.
 */
const SHORTEST_NAME_CORRECTED = 5;
const lettersToCorrect = (typed: string) => (typed.length >= SHORTEST_NAME_CORRECTED ? 2 : typed.length === SHORTEST_NAME_CORRECTED - 1 ? 1 : 0);

/** "yahoo.co.uk" → { name: "yahoo", ending: "co.uk" }. No dot: all name. */
function splitDomain(domain: string): { name: string; ending: string | null } {
  const dot = domain.indexOf('.');
  return dot < 0 ? { name: domain, ending: null } : { name: domain.slice(0, dot), ending: domain.slice(dot + 1) };
}

/** How many letters to add, remove or change to turn a into b; with `swaps`, two letters the wrong way round count as one. */
function editDistance(a: string, b: string, swaps = false): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (swaps && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/**
 * "Did you mean sam@gmail.com?": the address with its domain corrected when it's one letter
 * away from a common one (two for the longer ones, such as gmial.com), else null. Only the
 * provider's name (gmial.com) or a mistyped ending (.con, .cm, .co, .couk) is ever put right:
 * never a domain that's right, a real one that happens to be close (mail.com, gmx.com,
 * live.com…), or one with another country's ending (yahoo.co.in, hotmail.ca, live.co.za).
 */
export function suggestEmail(email: string | null | undefined): string | null {
  const t = (email ?? '').trim();
  const at = t.lastIndexOf('@');
  if (at < 1 || t.indexOf('@') !== at) return null;
  const domain = t.slice(at + 1).toLowerCase();
  if (!domain || EMAIL_DOMAINS.includes(domain) || REAL_LOOKALIKES.has(domain)) return null;
  const { name, ending } = splitDomain(domain);
  // The domains it could be: how many letters away each is, and how many is close enough.
  let near: { domain: string; d: number; most: number }[] = [];
  if (ending !== null && KNOWN_ENDINGS.includes(ending)) {
    // The ending is right, so only a longer provider's name can be wrong: gmial.com, hotmial.co.uk.
    near = KNOWN_DOMAINS.map((known) => ({ known, k: splitDomain(known) }))
      .filter(({ k }) => k.ending === ending && k.name.length >= SHORTEST_NAME_CORRECTED)
      .map(({ known, k }) => ({ domain: known, d: editDistance(name, k.name), most: lettersToCorrect(name) }));
  } else if (ending === null || KNOWN_ENDINGS.some((e) => editDistance(ending, e, true) === 1)) {
    // A mistyped ending (or none, as in gmailcom): the whole domain is compared.
    near = KNOWN_DOMAINS.map((known) => ({ domain: known, d: editDistance(domain, known), most: known.length >= 9 ? 2 : 1 }));
  }
  let best: { domain: string; d: number } | null = null;
  for (const n of near) if (n.d <= n.most && (!best || n.d < best.d)) best = n;
  return best ? `${t.slice(0, at)}@${best.domain}` : null;
}

/**
 * "Message me" links for the public pages, for the ways she can be reached: an Instagram or
 * Facebook message, or an email with the subject filled in. Blank (or invalid) ones are left out.
 */
export function dmLinks({ instagram, facebook, email }: { instagram?: string | null; facebook?: string | null; email?: string | null }):
  { instagram?: string; facebook?: string; email?: string } {
  const out: { instagram?: string; facebook?: string; email?: string } = {};
  const ig = instagram?.trim();
  const fb = facebook?.trim();
  const mail = email?.trim();
  if (ig && SOCIAL_SITES.instagram.pattern.test(ig)) out.instagram = `https://ig.me/m/${encodeURIComponent(ig)}`;
  if (fb && SOCIAL_SITES.facebook.pattern.test(fb)) out.facebook = `https://m.me/${encodeURIComponent(fb)}`;
  if (mail && isPlausibleEmail(mail)) out.email = `mailto:${encodeURI(mail)}?subject=Booking%20enquiry`;
  return out;
}

/** The last line of every short-notice message: how to stop them. */
export const STOP_LINE = "Reply STOP if you'd rather not get these messages.";

/**
 * A message to the short-notice list (clients who said yes to hearing about spaces and offers):
 * her text, signed with the business name if it isn't already, then how to stop them.
 */
export function shortNoticeMessage(text: string, business: string | null | undefined): string {
  const body = text.trim();
  const name = (business ?? '').trim();
  if (body.endsWith(STOP_LINE)) return body;
  if (name && body.endsWith(name)) return `${body}\n${STOP_LINE}`;
  return name ? `${body}\n\n${name}\n${STOP_LINE}` : `${body}\n\n${STOP_LINE}`;
}

/** Turn rows into a CSV that Excel and Google Sheets open cleanly (UTF-8 with BOM). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    // Guard against spreadsheet formula injection from client-entered text.
    const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s) ? `'${s}` : s;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
}

/** UK tax year containing a date: 6 April to 5 April. */
export function taxYearOf(dateStr: string): { label: string; from: string; to: string } {
  const [y, m, d] = dateStr.split('-').map(Number);
  const startYear = m > 4 || (m === 4 && d >= 6) ? y : y - 1;
  return {
    label: `${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`,
    from: `${startYear}-04-06`,
    to: `${startYear + 1}-04-05`,
  };
}

/** What a phone with no signal (or the server out of reach) is told. */
export const NO_SIGNAL = 'No signal: check your connection and try again.';

/**
 * How each browser says a request never got an answer: Safari on an iPhone ("Load failed"),
 * Chrome and Edge ("Failed to fetch"), Firefox ("NetworkError when attempting to fetch
 * resource."), and older iPhones. The Supabase client puts "TypeError: " in front.
 */
const NETWORK_ERRORS = [
  'Load failed', 'Failed to fetch', 'NetworkError when attempting to fetch resource',
  'The Internet connection appears to be offline', 'The network connection was lost',
];

const messageOf = (e: unknown) =>
  e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);

/** The request failed for want of a connection, so it may or may not have reached the server. */
export const isNetworkError = (e: unknown) => {
  const msg = messageOf(e);
  return NETWORK_ERRORS.some((t) => msg.includes(t));
};

/** Friendly wording for the short error codes the database raises. */
export function friendlyError(e: unknown): string {
  if (isNetworkError(e)) return NO_SIGNAL;
  const msg = messageOf(e);
  const known: Record<string, string> = {
    slot_taken: 'Sorry, that time has just been taken. Please pick another.',
    too_soon: 'That time is too soon to book online. Please pick a later time.',
    too_far: 'That date is too far ahead to book yet.',
    closed: "Sorry, we're closed that day.",
    outside_hours: "That time is outside opening hours.",
    invalid_time: 'Please pick one of the times shown.',
    invalid_name: 'Please enter your full name (letters only).',
    invalid_email: 'Please check your email address.',
    invalid_phone: 'Please check your mobile number.',
    invalid_notes: 'Your note is too long — please shorten it.',
    invalid_service: "That treatment isn't available to book online any more.",
    too_many_bookings: 'You already have three upcoming bookings. Please get in touch to book more.',
    booking_disabled: 'Online booking is paused at the moment. Please get in touch directly.',
    consent_required: 'Please tick both boxes under the health questions.',
    policy_required: 'Please tick to agree to the cancellation policy.',
    busy_try_later: 'Lots of bookings are coming in right now — please try again in a little while, or get in touch directly.',
    booking_failed: 'Sorry, that booking couldn’t be made. Please check your details or get in touch directly.',
    form_failed: 'Sorry, the form couldn’t be sent. Please try again or get in touch directly.',
    change_failed: 'Sorry, that change couldn’t be made. Please try again or get in touch directly.',
    cancel_failed: 'Sorry, the booking couldn’t be cancelled. Please try again or get in touch directly.',
    too_late: 'This appointment has already started, so it can’t be changed online.',
    not_changeable: 'This booking can’t be changed any more — it may already have been cancelled.',
    changes_disabled: 'Bookings can’t be changed online at the moment — please get in touch directly.',
    too_many_changes: 'This booking has already been changed a few times — please get in touch directly to change it again.',
    no_change: 'That’s the same as your booking now — pick a different time or treatment.',
    signature_required: 'Please type your full name to sign the form.',
    already_submitted: 'This form has already been filled in. Thank you!',
    not_found: "This link has expired or isn't valid.",
    'violates check constraint': 'That value is out of range — please check it.',
    not_allowed: "You're not signed in as the owner.",
    not_pending_deposit: 'That booking is not waiting for a deposit.',
    not_cancellable: 'Only upcoming bookings can be cancelled.',
    not_completable: 'That appointment is already finished or cancelled.',
    no_email: "This client doesn't have an email address saved.",
    tax_update_needed: 'These figures can’t be saved yet: the database update for the tax estimate hasn’t been run. '
      + 'Ask whoever set up the app to run it (SETUP.md, “Tax to put aside”). Until then, the estimate works from your takings in the app.',
    // NeedsUpdateError (api/api.ts).
    growth_update_needed: 'This needs the database update for this version of the app, which hasn’t been run yet. '
      + 'Ask whoever set up the app to run supabase/updates/2026-11-growth.sql (see SETUP.md). Everything else works as before.',
    appointments_no_overlap: 'That clashes with another appointment (including the clean-up time).',
    clients_email_unique: 'A client with that email address already exists — search for them instead.',
    'Invalid login credentials': 'That email and password don’t match.',
    // The booking page, when the signal dropped as they confirmed: it may have gone through.
    booking_no_reply: 'No signal: we couldn’t tell whether your booking went through. Check your email for a confirmation '
      + '(it can take up to 10 minutes) before you try again.',
  };
  for (const [code, text] of Object.entries(known)) if (msg.includes(code)) return text;
  return msg || 'Something went wrong. Please try again.';
}
