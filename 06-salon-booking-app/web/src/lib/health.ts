// A client's health information as the appointment screen sums it up: allergies, the
// latest patch test, and whether a consultation form is on file. Consent she recorded
// herself (Record consent: a paper form, a WhatsApp message or an email) counts as on
// file, as well as the online form; from a message it says "consent recorded", as no form
// was filled in. The strip supports her judgement; the full answers stay on the client's record.
import type { Appointment, ApptHealth, PatchTest } from './types';
import { fmt } from './time';

/** Forms older than this are worth renewing: common guidance, not law (her insurer may ask for something else). */
export const FORM_RENEW_DAYS = 365;

/** How far ahead Today looks for anyone without a form. */
export const FORM_AHEAD_DAYS = 14;

type Test = Pick<PatchTest, 'tested_on' | 'result'>;
const SEVERITY: Record<PatchTest['result'], number> = { reaction: 0, pass: 1, pending: 2 };

/** The patch test that counts: the newest, and on a day with more than one, a reaction before no reaction before waiting. */
export function latestPatchTest(tests: Test[]): Test | null {
  return [...tests].sort((x, y) => y.tested_on.localeCompare(x.tested_on) || SEVERITY[x.result] - SEVERITY[y.result])[0] ?? null;
}

/** "3 Oct", or "3 Oct 2025" when it isn't the same year as `ref`. */
function shortDate(iso: string, tz: string, ref: string): string {
  return fmt(iso, fmt(iso, 'yyyy', tz) === fmt(ref, 'yyyy', tz) ? 'd MMM' : 'd MMM yyyy', tz);
}

export type Tone = 'ok' | 'warn' | 'danger' | 'quiet';

/** "no reaction 3 Oct", "reaction 3 Oct", "waiting since 3 Oct" or "none on file". */
export function patchTestLine(tests: Test[], tz: string, ref: string): { text: string; tone: Tone } {
  const t = latestPatchTest(tests);
  if (!t) return { text: 'none on file', tone: 'quiet' };
  const day = shortDate(`${t.tested_on}T12:00:00Z`, tz, ref);
  if (t.result === 'pass') return { text: `no reaction ${day}`, tone: 'ok' };
  if (t.result === 'reaction') return { text: `reaction ${day}`, tone: 'danger' };
  return { text: `waiting since ${day}`, tone: 'warn' };
}

/** How recorded consent was given, in a word or two; null for the online form (that's the form itself). */
function consentHow(note: string | null): string | null {
  const n = (note ?? '').trim();
  if (!n || /^online consultation form$/i.test(n)) return null;
  if (/^paper/i.test(n)) return 'paper';
  if (/^whatsapp/i.test(n)) return 'by WhatsApp';
  if (/^e-?mail/i.test(n)) return 'by email';
  return n;
}

/**
 * What's on file: the newest online form, or the consent she recorded if that's newer
 * (or there's no form). Null when there's neither.
 */
export function formOnFile(h: Pick<ApptHealth, 'forms' | 'consent_at' | 'consent_note'>): { date: string; how: string | null } | null {
  const form = [...h.forms].sort().pop() ?? null;
  const recorded = h.consent_at && consentHow(h.consent_note) ? h.consent_at : null;
  if (recorded && (!form || new Date(recorded) > new Date(form))) return { date: recorded, how: consentHow(h.consent_note) };
  if (form) return { date: form, how: null };
  // Consent from the online form with the form itself gone: still given, so still on file.
  return h.consent_at ? { date: h.consent_at, how: null } : null;
}

/** Consent she recorded from a WhatsApp message or an email: the client agreed, but filled in no form. */
export const consentOnly = (f: { how: string | null } | null): boolean => !!f && (f.how === 'by WhatsApp' || f.how === 'by email');

/**
 * "on file, 12 Sep", "on file, 12 Sep (paper)", "consent recorded, 12 Sep (by WhatsApp)" or
 * "none on file", and whether it's over a year older than the appointment, so worth a fresh one.
 */
export function formLine(h: Pick<ApptHealth, 'forms' | 'consent_at' | 'consent_note'>, tz: string, startsAt: string):
  { text: string; onFile: boolean; old: boolean } {
  const f = formOnFile(h);
  if (!f) return { text: 'none on file', onFile: false, old: false };
  const old = new Date(f.date).getTime() < new Date(startsAt).getTime() - FORM_RENEW_DAYS * 86400e3;
  return { text: `${consentOnly(f) ? 'consent recorded' : 'on file'}, ${shortDate(f.date, tz, startsAt)}${f.how ? ` (${f.how})` : ''}`, onFile: true, old };
}

/** A form, or consent she recorded, is on file for the client (lists only know whether there's one). */
export const formOrConsent = (a: Pick<Appointment, 'has_form' | 'has_consent'>): boolean => !!(a.has_form || a.has_consent);

/**
 * Today's list of anyone booked in the next 14 days with no form and no recorded consent,
 * new clients and regulars alike: each client once, at their soonest booking that isn't
 * over yet (one that's over is under "Not finished yet" instead).
 */
export function needingForms<T extends Pick<Appointment, 'client_id' | 'status' | 'starts_at' | 'ends_at' | 'has_form' | 'has_consent'>>(
  appts: T[], now = new Date(),
): T[] {
  const until = now.getTime() + FORM_AHEAD_DAYS * 86400e3;
  const seen = new Set<string>();
  return appts
    .filter((a) => (a.status === 'confirmed' || a.status === 'pending_deposit') && !formOrConsent(a)
      && new Date(a.starts_at).getTime() < until && new Date(a.ends_at).getTime() > now.getTime())
    .sort((x, y) => x.starts_at.localeCompare(y.starts_at))
    .filter((a) => (seen.has(a.client_id) ? false : (seen.add(a.client_id), true)));
}
