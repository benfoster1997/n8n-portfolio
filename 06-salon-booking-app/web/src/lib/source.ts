// Where clients come from: the link they booked through (?from= on her booking link, or
// the site that sent them), and their answer to "How did you hear about me?". The booking
// page sends both with the booking (BookingExtras); the database tidies them the same way
// as tidyExtras() here (public_create_booking in supabase/schema.sql), and the owner's
// screens word them with foundYouLabel() and add them up with summariseNewClients().
import type { BookingExtras, HeardFrom, NewClientBooking } from './types';

/** "How did you hear about me?": the answers, in the order the booking page offers them. */
export const HEARD_FROM: readonly { value: HeardFrom; label: string }[] = [
  { value: 'instagram', label: 'Instagram' },
  { value: 'facebook', label: 'Facebook' },
  { value: 'google', label: 'Google' },
  { value: 'friend', label: 'A friend' },
  { value: 'card', label: 'Saw a card or poster' },
  { value: 'other', label: 'Other' },
];
export const HEARD_FROM_LABEL = Object.fromEntries(HEARD_FROM.map((h) => [h.value, h.label])) as Record<HeardFrom, string>;

export const isHeardFrom = (v: unknown): v is HeardFrom => HEARD_FROM.some((h) => h.value === v);
/** A friend and Other come with a few words (a friend's name, say); the others don't. */
export const takesDetail = (h: HeardFrom | null | undefined): boolean => h === 'friend' || h === 'other';
/** How long those words can be (appointments.heard_from_detail). */
export const HEARD_FROM_DETAIL_MAX = 60;

/**
 * The ?from= each of her own links carries, so she can see which ones bring clients:
 * her booking link as she shares it in each place. Any other slug she types works too.
 */
export const LINK_FROM = {
  instagram: 'instagram',
  facebook: 'facebook',
  card: 'card',
  freeTimes: 'free-times',
  /** A client passing her booking link on to a friend (Share with a friend). */
  friend: 'friend',
} as const;

/** How the owner's screens word a link: "Found you through your Instagram link". Unknown ones as typed. */
const LINK_LABEL = new Map<string, string>([
  ['instagram', 'your Instagram link'],
  ['facebook', 'your Facebook link'],
  ['google', 'Google'],
  ['card', 'your printed card'],
  ['free-times', 'a free-times post'],
  ['friend', 'a client sharing your link'],
  // Her WhatsApp Business link (Settings → Booking page → Your links).
  ['whatsapp', 'your WhatsApp link'],
]);

/** "Instagram!!" → "instagram": a link's source as the database keeps it (lower case, a–z, 0–9 and -, up to 30), or null. */
export function cleanLinkSource(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v.toLowerCase().replace(/[^a-z0-9-]+/g, '').slice(0, 30) || null;
}

const UTM = new Map([['ig', 'instagram'], ['instagram', 'instagram'], ['fb', 'facebook'], ['facebook', 'facebook']]);
const SITE_HOSTS: [RegExp, string][] = [
  [/^(l\.)?instagram\.com$/, 'instagram'],
  [/^((m|l|lm)\.)?facebook\.com$/, 'facebook'],
  [/^google\.[a-z.]+$/, 'google'],
];

/**
 * Where a visit to the booking page came from: ?from= on the link (as she shares it),
 * then ?utm_source= (ig and fb, as Instagram and Facebook add them), then the site that
 * sent them (Instagram, Facebook or Google). Null when there's no telling.
 *   readSource({ search: location.search, referrer: document.referrer })
 */
export function readSource({ search = '', referrer = '' }: { search?: string; referrer?: string }): string | null {
  const q = new URLSearchParams(search);
  const from = cleanLinkSource(q.get('from'));
  if (from) return from;
  const utm = UTM.get((q.get('utm_source') ?? '').trim().toLowerCase());
  if (utm) return utm;
  let host = '';
  try {
    host = new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  return SITE_HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? null;
}

/** How a link reads on the owner's screens: "your Instagram link", "a free-times post"; one she made up as typed. */
export function linkLabel(linkSource: string): string {
  return LINK_LABEL.get(linkSource) ?? linkSource;
}

/**
 * How a client found her, in a few words for the owner's screens: their own answer first
 * ("A friend: Sam", "Instagram", "Other: Wedding fair"), else the link they booked through
 * ("your Instagram link", "your printed card"). Null when there's nothing to go on.
 */
export function foundYouLabel(linkSource: string | null | undefined, heardFrom: HeardFrom | null | undefined,
  detail?: string | null): string | null {
  if (heardFrom && isHeardFrom(heardFrom)) {
    const words = takesDetail(heardFrom) ? (detail ?? '').trim() : '';
    return words ? `${HEARD_FROM_LABEL[heardFrom]}: ${words}` : HEARD_FROM_LABEL[heardFrom];
  }
  return linkSource ? linkLabel(linkSource) : null;
}

/** The booking page's optional answers, tidied by the same rules as public_create_booking. */
export interface TidyExtras {
  link_source: string | null;
  heard_from: HeardFrom | null;
  heard_from_detail: string | null;
  first_visit: boolean | null;
  marketing_ok: boolean;
}

/**
 * The answers as the database keeps them (the demo uses this): anything in the wrong shape is
 * left out, never refused. The words with A friend or Other become one line of up to 60
 * characters, and are left out if they look like a link, an email address or markup.
 */
export function tidyExtras(e: unknown): TidyExtras {
  const out: TidyExtras = { link_source: null, heard_from: null, heard_from_detail: null, first_visit: null, marketing_ok: false };
  if (!e || typeof e !== 'object' || Array.isArray(e)) return out;
  const x = e as Record<string, unknown>;
  out.link_source = cleanLinkSource(x.link_source);
  out.heard_from = isHeardFrom(x.heard_from) ? x.heard_from : null;
  if (takesDetail(out.heard_from) && typeof x.heard_from_detail === 'string') {
    const line = x.heard_from_detail.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
    // Counted in characters, as the database does (an emoji is one).
    out.heard_from_detail = /[@<>]|:\/\/|www\./i.test(line) ? null
      : Array.from(line).slice(0, HEARD_FROM_DETAIL_MAX).join('').trim() || null;
  }
  out.first_visit = typeof x.first_visit === 'boolean' ? x.first_visit : null;
  out.marketing_ok = x.marketing_ok === true;
  return out;
}

/**
 * Just the answers worth sending with a booking, tidied, or null when there are none (then the
 * booking goes without them). "No, I've been before" is an answer; an unticked box isn't.
 */
export function extrasToSend(e: BookingExtras | null | undefined): BookingExtras | null {
  const t = tidyExtras(e);
  const out: BookingExtras = {};
  if (t.link_source) out.link_source = t.link_source;
  if (t.heard_from) out.heard_from = t.heard_from;
  if (t.heard_from_detail) out.heard_from_detail = t.heard_from_detail;
  if (t.first_visit !== null) out.first_visit = t.first_visit;
  if (t.marketing_ok) out.marketing_ok = true;
  return Object.keys(out).length ? out : null;
}

/** Money → New clients: how many new clients booked and came, and how they found her. */
export interface NewClientsSummary {
  /** New clients who booked, each counted once however many bookings they made. */
  booked: number;
  /** Of those, how many have had a visit marked as done. */
  came: number;
  /**
   * Their answers to "How did you hear about me?", most first: each client once, under the first
   * answer they gave. names: the words given with A friend or Other (friends' names), when any.
   */
  byAnswer: { label: string; count: number; names?: string[] }[];
  /** The links they booked through, most first: each client once, under the first link. */
  byLink: { label: string; count: number }[];
  /** Clients who didn't answer "How did you hear about me?" (booked + nobody is counted twice: answers + didntSay = booked). */
  didntSay: number;
}

type SummaryRow = Pick<NewClientBooking, 'client_id' | 'status' | 'created_at' | 'link_source' | 'heard_from' | 'heard_from_detail'>;

/** Add up listNewClientBookings() for one period, counting each client once. */
export function summariseNewClients(rows: SummaryRow[]): NewClientsSummary {
  const clients = new Map<string, { came: boolean; heard: HeardFrom | null; detail: string | null; link: string | null }>();
  for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const c = clients.get(r.client_id) ?? { came: false, heard: null, detail: null, link: null };
    if (r.status === 'completed') c.came = true;
    if (!c.heard && r.heard_from && isHeardFrom(r.heard_from)) {
      c.heard = r.heard_from;
      c.detail = takesDetail(r.heard_from) ? r.heard_from_detail?.trim() || null : null;
    }
    if (!c.link && r.link_source) c.link = r.link_source;
    clients.set(r.client_id, c);
  }
  const all = [...clients.values()];
  const answers = HEARD_FROM.map(({ value, label }) => {
    const mine = all.filter((c) => c.heard === value);
    const names = [...new Set(mine.flatMap((c) => (c.detail ? [c.detail] : [])))];
    return { label, count: mine.length, ...(names.length ? { names } : {}) };
  }).filter((a) => a.count > 0);
  const links = new Map<string, number>();
  for (const c of all) if (c.link) links.set(linkLabel(c.link), (links.get(linkLabel(c.link)) ?? 0) + 1);
  return {
    booked: all.length,
    came: all.filter((c) => c.came).length,
    // Most first; a tie keeps the booking page's order.
    byAnswer: answers.map((a, i) => ({ a, i })).sort((x, y) => y.a.count - x.a.count || x.i - y.i).map((x) => x.a),
    byLink: [...links].map(([label, count]) => ({ label, count })).sort((x, y) => y.count - x.count || x.label.localeCompare(y.label)),
    didntSay: all.filter((c) => !c.heard).length,
  };
}
