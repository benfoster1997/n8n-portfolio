// Small text helpers: phone numbers, money, WhatsApp links, message templates,
// and the booking page's add-ons menu and social handles.
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
} as const;

export type TemplateKind = keyof typeof DEFAULT_TEMPLATES;

export function templateFor(kind: TemplateKind, s: Settings): string {
  const custom = kind === 'reminder' ? s.wa_template_reminder : kind === 'deposit' ? s.wa_template_deposit : s.wa_template_confirmed;
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
  };
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? values[key] : whole));
}

export const TEMPLATE_PLACEHOLDERS = [
  '{first_name}', '{name}', '{service}', '{date}', '{time}', '{price}', '{deposit}',
  '{reference}', '{bank_name}', '{sort_code}', '{account_number}', '{business}',
  '{change_note}', '{manage_link}', '{change_by}',
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

export function downloadText(filename: string, text: string, type = 'text/csv;charset=utf-8') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // iOS asks where to save before reading the file, so keep the link alive a while.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
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

/** Friendly wording for the short error codes the database raises. */
export function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e);
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
    appointments_no_overlap: 'That clashes with another appointment (including the clean-up time).',
    clients_email_unique: 'A client with that email address already exists — search for them instead.',
    'Invalid login credentials': 'That email and password don’t match.',
    'Failed to fetch': "Can't reach the server — check your internet connection.",
  };
  for (const [code, text] of Object.entries(known)) if (msg.includes(code)) return text;
  return msg || 'Something went wrong. Please try again.';
}
