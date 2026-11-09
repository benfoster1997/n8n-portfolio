// The owner's side of where clients come from, Google reviews and short-notice spaces (the
// November 2026 update, supabase/updates/2026-11-growth.sql): the links she gives out in each
// place, how a client found her, Money's New clients card in words, and the short lines her
// screens show. The booking page's side, and the rules for what's kept, are in lib/source.
import type { Appointment, Client, HeardFrom } from './types';
import { HEARD_FROM_DETAIL_MAX, isHeardFrom, LINK_FROM, linkLabel, takesDetail, type NewClientsSummary } from './source';
import { DEFAULT_BUSINESS_NAME } from './text';
import { fmt } from './time';

// ---------------------------------------------------------------------------------- her links

/** Her booking link in each place she puts it, each with its own ?from= so Money can tell them apart. */
export const OWN_LINKS: readonly { place: string; from: string }[] = [
  { place: 'Instagram bio', from: LINK_FROM.instagram },
  { place: 'Facebook', from: LINK_FROM.facebook },
  { place: 'Google Business Profile', from: LINK_FROM.google },
  { place: 'WhatsApp Business', from: LINK_FROM.whatsapp },
  { place: 'Printed cards and posters', from: LINK_FROM.card },
];

/** Where her app lives: the address saved in Business details, else the one it's open on. */
export function siteBase(publicSiteUrl: string | null | undefined,
  origin = typeof window !== 'undefined' ? window.location.origin : ''): string {
  return (publicSiteUrl?.trim() || origin).replace(/\/+$/, '');
}

/** Her booking link for one place: "https://…/book?from=instagram". */
export const ownLink = (base: string, from: string) => `${base.replace(/\/+$/, '')}/book?from=${encodeURIComponent(from)}`;

// ---------------------------------------------------------------------------------- how a client found her

/** How she notes how a client found her, on an appointment: one of the six answers (or none), and the words with A friend or Other. */
export interface FoundYouAnswer {
  heard_from: HeardFrom | null;
  detail: string;
}

/** What's saved for it: the words only with A friend or Other, on one line, up to 60 characters. Blank is none. */
export function foundYouPatch(v: FoundYouAnswer): Pick<Appointment, 'heard_from' | 'heard_from_detail'> {
  const heard = isHeardFrom(v.heard_from) ? v.heard_from : null;
  const line = takesDetail(heard) ? v.detail.replace(/\s+/g, ' ').trim() : '';
  // Counted in characters, as the database does (an emoji is one).
  const words = Array.from(line).slice(0, HEARD_FROM_DETAIL_MAX).join('').trim();
  return { heard_from: heard, heard_from_detail: words || null };
}

/** Where a client came from, as one appointment (or their record) has it. */
export interface FoundYou {
  heard_from: HeardFrom | null;
  heard_from_detail: string | null;
  link_source: string | null;
}

/**
 * How a client found her, for their record: the first answer they gave (or she noted), else the
 * first link they booked through, as Money counts them. Null when nothing was ever recorded.
 */
export function firstFoundYou(appts: (FoundYou & Pick<Appointment, 'created_at'>)[]): FoundYou | null {
  const oldest = [...appts].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const answer = oldest.find((a) => isHeardFrom(a.heard_from));
  if (answer) {
    return { heard_from: answer.heard_from, heard_from_detail: takesDetail(answer.heard_from) ? answer.heard_from_detail?.trim() || null : null, link_source: null };
  }
  const link = oldest.find((a) => !!a.link_source);
  return link ? { heard_from: null, heard_from_detail: null, link_source: link.link_source } : null;
}

/** The friend who recommended them, when that's what was noted: the name to look up in Clients. */
export function friendName(f: Pick<FoundYou, 'heard_from' | 'heard_from_detail'>): string | null {
  return f.heard_from === 'friend' ? f.heard_from_detail?.trim() || null : null;
}

const THROUGH: Record<HeardFrom, string> = {
  instagram: 'through Instagram', facebook: 'through Facebook', google: 'through Google', friend: 'through a friend',
  card: 'through a card or poster', other: 'another way',
};

/**
 * The end of "Found you …", on their record: "through Instagram", "through a friend: Sam", "through a
 * wedding fair" (Other, in their words), "through your printed card" (the link). Null with nothing to go on.
 */
export function foundYouThrough(f: FoundYou): string | null {
  if (isHeardFrom(f.heard_from)) {
    const words = takesDetail(f.heard_from) ? f.heard_from_detail?.trim() : '';
    if (!words) return THROUGH[f.heard_from];
    return f.heard_from === 'friend' ? `through a friend: ${words}` : `through ${words}`;
  }
  return f.link_source ? `through ${linkLabel(f.link_source)}` : null;
}

/** "your Instagram link" → "Your Instagram link", for the start of a line or a value. */
export const upperFirst = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** The Clients list, searching for a name (a friend who recommended someone, say). */
export const clientSearchLink = (name: string) => `/clients?q=${encodeURIComponent(name.trim())}`;

// ---------------------------------------------------------------------------------- Money → New clients

/** A link's short name for Money's "Links used": "card", "free times". One she made up reads as she typed it. */
const LINK_WORDS: [string, string][] = [
  [LINK_FROM.instagram, 'Instagram'], [LINK_FROM.facebook, 'Facebook'], [LINK_FROM.google, 'Google'], [LINK_FROM.whatsapp, 'WhatsApp'],
  [LINK_FROM.card, 'card'], [LINK_FROM.freeTimes, 'free times'], [LINK_FROM.friend, 'shared by clients'],
];
// summariseNewClients() gives each link as linkLabel() words it ("your printed card"): from those back to the short name.
const WORD_FOR_LABEL = new Map(LINK_WORDS.map(([slug, word]) => [linkLabel(slug), word]));
export const linkWord = (label: string) => WORD_FOR_LABEL.get(label) ?? label;

/** One month's New clients in words, a line each. answers and links are null when there's nothing to say. */
export interface NewClientsText {
  headline: string;
  answers: string | null;
  links: string | null;
}

const clients = (n: number) => `${n} new client${n === 1 ? '' : 's'}`;
/** " · " that never starts a line, and a count that never leaves its name: the lines can only break between the parts. */
const DOT = ' · ';
const tally = (name: string, n: number) => `${name} ${n}`;

/**
 * "November: 5 new clients booked · 3 came.", "Instagram 2 · A friend 2 (Sam, Amy) · Google 1." and
 * "Links used: card 1, free times 2.": plain numbers, most first. Everyone counted is under one answer or
 * "Didn’t say", so those add up to the number booked; when nobody answered, it says so in words.
 * `ongoing`: the month isn't over yet.
 */
export function newClientsText(s: NewClientsSummary, month: string, ongoing = false): NewClientsText {
  if (!s.booked) return { headline: `${month}: no new clients booked${ongoing ? ' yet' : ''}.`, answers: null, links: null };
  const answers = s.byAnswer.length
    ? `${[
      ...s.byAnswer.map((a) => tally(a.label, a.count) + (a.names?.length ? ` (${a.names.join(', ')})` : '')),
      ...(s.didntSay ? [tally('Didn’t say', s.didntSay)] : []),
    ].join(DOT)}.`
    : s.booked === 1 ? 'They didn’t say how they found you.' : 'None of them said how they found you.';
  return {
    headline: `${month}: ${clients(s.booked)} booked${DOT}${s.came} came.`,
    answers,
    links: s.byLink.length ? `Links used: ${s.byLink.map((l) => tally(linkWord(l.label), l.count)).join(', ')}.` : null,
  };
}

/** The month before, to compare: "October: 4 new clients booked." */
export function lastMonthText(s: Pick<NewClientsSummary, 'booked'>, month: string): string {
  return s.booked ? `${month}: ${clients(s.booked)} booked.` : `${month}: no new clients booked.`;
}

// ---------------------------------------------------------------------------------- short lines

/** "3 Nov", or "3 Nov 2025" for another year: when she asked for a review, or a client said yes. */
export function shortDate(iso: string, tz: string, now = new Date()): string {
  return fmt(iso, fmt(now, 'yyyy', tz) === fmt(iso, 'yyyy', tz) ? 'd MMM' : 'd MMM yyyy', tz);
}

/** "Asked for a review on 3 Nov". */
export const reviewAskedText = (iso: string, tz: string, now = new Date()) => `Asked for a review on ${shortDate(iso, tz, now)}`;

/** The note kept when she records a yes a client gave her in person (the booking page notes "Ticked on the booking page"). */
export const SAID_YES_IN_PERSON = 'Said yes in person';

/** Their record's short-notice line: "Yes, since 12 Nov (ticked on the booking page)", or "Not asked yet". */
export function shortNoticeLine(c: Pick<Client, 'marketing_ok_at' | 'marketing_ok_note'>, tz: string, now = new Date()): string {
  if (!c.marketing_ok_at) return 'Not asked yet';
  const note = c.marketing_ok_note?.trim();
  return `Yes, since ${shortDate(c.marketing_ok_at, tz, now)}${note ? ` (${note[0].toLowerCase()}${note.slice(1)})` : ''}`;
}

/** Her business name is still the one a new install starts with, so her booking page says "My Nail Studio". */
export const isDefaultBusinessName = (name: string | null | undefined) => (name ?? '').trim() === DEFAULT_BUSINESS_NAME;
