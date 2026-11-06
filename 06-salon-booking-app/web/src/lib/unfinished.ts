// Appointments whose time has passed but that still say Confirmed or Deposit due:
// nobody finished them (Finish & take payment), marked a no-show or cancelled them.
// Until she does, their money is missing from her takings, and a client who never
// had a visit marked as done still counts as new.
import type { Appointment } from './types';
import { fmtTime } from './time';
import { money } from './text';

/** How many Today lists, oldest first. The rest wait their turn ("and 3 more"). */
export const UNFINISHED_SHOWN = 5;

/** Still Confirmed or Deposit due, and over. */
export function isUnfinished(a: Pick<Appointment, 'status' | 'ends_at'>, now = Date.now()): boolean {
  return (a.status === 'confirmed' || a.status === 'pending_deposit') && new Date(a.ends_at).getTime() <= now;
}

/**
 * Today's first tile, under the number of appointments: what's next, or "All done" once
 * they're over. Never "All done" while appointments still need finishing.
 */
export function todayNote(todays: Pick<Appointment, 'status' | 'starts_at' | 'ends_at'>[], toFinish: number, tz: string, now = new Date()): string {
  const upNext = todays.find((a) => a.status !== 'completed' && a.status !== 'no_show' && a.status !== 'cancelled'
    && new Date(a.ends_at) > now);
  if (upNext) return new Date(upNext.starts_at) <= now ? 'On now' : `Next ${fmtTime(upNext.starts_at, tz)}`;
  if (!todays.length) return 'Free day';
  return toFinish > 0 ? `${toFinish} to finish` : 'All done';
}

/**
 * The question before marking a no-show, true for whoever it is. A no-show sends no email
 * and can't be undone. Whether they're asked for a deposit next time follows the booking
 * page's rule: only clients with no visit marked as done who aren't ticked as a regular.
 * visits is null when it couldn't be checked.
 */
export function noShowQuestion(o: { name: string; visits: number | null; regular: boolean; depositPence: number }): string {
  const who = o.name || 'the client';
  const ask = `Mark ${who} as a no-show? It can’t be undone, and they aren’t emailed.`;
  if (o.depositPence <= 0) return ask;
  const deposit = `a ${money(o.depositPence)} deposit`;
  if (o.visits === null) return `${ask} Anyone who hasn’t had a visit marked as done is asked for ${deposit} when they book online.`;
  if (o.visits > 0) return `${ask} As ${who} has had a visit marked as done before, they won’t be asked for ${deposit} if they book online again.`;
  if (o.regular) return `${ask} As ${who} is ticked as a regular, they won’t be asked for ${deposit} if they book online again.`;
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  return `${ask} ${Who} hasn’t had a visit marked as done, so they’ll still be asked for ${deposit} if they book online again.`;
}
