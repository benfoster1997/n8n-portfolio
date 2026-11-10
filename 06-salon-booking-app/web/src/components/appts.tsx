import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { Appointment, ClientChange, Settings } from '../lib/types';
import { fmtDayTime, fmtTime, minutesLabel } from '../lib/time';
import { fillTemplate, firstName, money, templateFor, whatsappLink } from '../lib/text';
import { formOrConsent } from '../lib/health';
import { isUnfinished } from '../lib/unfinished';
import { HEARD_FROM, HEARD_FROM_DETAIL_MAX, isHeardFrom, takesDetail } from '../lib/source';
import { reviewAskedText, type FoundYouAnswer } from '../lib/growth';
import { Field, Icon, LateChip, StatusChip, statusLabel, useToast } from './ui';

/** Where an appointment sits against the clock, for the timeline dot: done, happening now, or still to come. */
export function apptPhase(a: Pick<Appointment, 'status' | 'starts_at' | 'ends_at'>, now = Date.now()): 'cancelled' | 'past' | 'now' | 'future' {
  if (a.status === 'cancelled') return 'cancelled';
  if (a.status === 'completed' || a.status === 'no_show' || new Date(a.ends_at).getTime() <= now) return 'past';
  return new Date(a.starts_at).getTime() <= now ? 'now' : 'future';
}

/**
 * One appointment as a timeline row: the time in bold figures, a dot on a thin pink rail
 * (the rail joins up through a list), the client, treatment and price, and the status.
 * Once its time has passed, a booking still saying Confirmed or Deposit due says "Not finished".
 * A client with allergies recorded gets a small "Allergy" tag: never the details, as these
 * lists are the screens she might show someone.
 */
export function ApptRow({ a, tz, showDate, hideStatus }: {
  a: Appointment; tz: string; showDate?: (iso: string) => string;
  /** Under a heading that already says the status (the diary's "Cancelled"): no status chip, only the extra flags. */
  hideStatus?: boolean;
}) {
  const unfinished = isUnfinished(a);
  const overdue = !unfinished && !!(a.status === 'pending_deposit' && a.deposit_due_at && new Date(a.deposit_due_at) < new Date());
  const phase = apptPhase(a);
  const lateCancel = a.status === 'cancelled' && a.cancelled_late;
  const chipCount = (hideStatus ? 0 : 1) + (overdue ? 1 : 0) + (lateCancel ? 1 : 0);
  // With the chip left out, screen readers still hear the status as part of the link.
  const quietStatus = hideStatus && <span className="visually-hidden">{statusLabel(a.status)}</span>;
  return (
    <li className="appt-li">
      <Link className={`list-row appt-row is-${phase} st-${a.status}${chipCount > 1 ? ' two-chips' : ''}`} to={`/appointments/${a.id}`}>
        <div className="appt-time">
          <span className="appt-clock">{fmtTime(a.starts_at, tz)}</span>
          <small title={minutesLabel(a.duration_min)}>{showDate ? showDate(a.starts_at) : `to ${fmtTime(a.ends_at, tz)}`}</small>
        </div>
        <span className="appt-dot" aria-hidden="true" />
        <div className="title appt-name">
          {a.client?.full_name ?? a.booking_name ?? 'Client'}
          {a.has_allergies && <>{' '}<span className="od-tag od-tag-allergy appt-allergy" title="Allergies noted on their record">Allergy</span></>}
        </div>
        <div className="meta appt-meta">
          {a.service_name}
          {/* each separator stays on the line before it, so a line never starts with one */}
          {a.price_pence > 0 && <>{'\u00a0· '}<span className="appt-price">{money(a.price_pence)}</span></>}
          {a.is_new_client && <span className="appt-new-flag">{'\u00a0· '}<span className="appt-new">New</span></span>}
          {a.is_new_client && !formOrConsent(a) && a.status !== 'completed' && a.status !== 'cancelled' && <span className="flag">{'\u00a0· No\u00a0form'}</span>}
        </div>
        {chipCount > 0 ? (
          <div className="appt-chips">
            {quietStatus}
            {!hideStatus && <StatusChip status={a.status} unfinished={unfinished} />}
            {overdue && <span className="chip danger">Overdue</span>}
            {lateCancel && <LateChip>Late cancel</LateChip>}
          </div>
        ) : quietStatus}
        <span className="chev"><Icon name="chev" size={18} /></span>
      </Link>
    </li>
  );
}

/** What a client changed, as a phrase: "moved BIAB infill to Wed 4 Nov, 12:00 (was Tue 3 Nov, 15:00)". */
export function changeText(c: ClientChange, tz: string): string {
  const at = (iso: string | null) => (iso ? fmtDayTime(iso, tz) : '?');
  switch (c.action) {
    case 'moved': return `moved ${c.old_service_name} to ${at(c.new_starts_at)} (was ${at(c.old_starts_at)})`;
    case 'treatment': return `switched to ${c.new_service_name} (was ${c.old_service_name})`;
    case 'moved_treatment':
      return `moved to ${at(c.new_starts_at)} and switched to ${c.new_service_name} (was ${c.old_service_name}, ${at(c.old_starts_at)})`;
    case 'cancelled': return `cancelled ${c.old_service_name} on ${at(c.old_starts_at)}`;
  }
}

/** The whole sentence: "Amelia Hart moved BIAB infill to …". */
export function describeChange(c: ClientChange, tz: string): string {
  return `${c.client_name || 'A client'} ${changeText(c, tz)}`;
}

/** "just now", "25 min ago", "3 hr ago", then the date. */
export function changedAgo(iso: string, tz: string, now = Date.now()): string {
  const mins = Math.floor((now - new Date(iso).getTime()) / 60e3);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 24 * 60) return `${Math.floor(mins / 60)} hr ago`;
  return fmtDayTime(iso, tz);
}

/**
 * The template that fits where the appointment is: deposit chase, reminder or confirmation.
 * The default wording's {change_note} never quotes a change-by time that has passed, and
 * leaves the link out when clients can't change bookings online.
 */
export function whatsappMessageFor(a: Appointment, s: Settings, kind?: 'reminder' | 'deposit' | 'confirmed', now = new Date()): string {
  const k = kind ?? (a.status === 'pending_deposit' ? 'deposit' : 'reminder');
  return fillTemplate(templateFor(k, s), a, s, now);
}

export function WhatsAppButton({ a, s, kind, label, onSent, small }: {
  a: Appointment; s: Settings; kind?: 'reminder' | 'deposit' | 'confirmed'; label?: string;
  onSent?: () => void; small?: boolean;
}) {
  // A different mobile was typed with this booking: nothing carrying their private link goes by
  // WhatsApp until she has checked which number is right, on the appointment. Nothing counts as sent.
  if (a.booking_phone) {
    return <Link className={`btn${small ? ' small' : ''}`} to={`/appointments/${a.id}`}>Check mobile first</Link>;
  }
  const phone = a.client?.phone_e164;
  if (!phone) return <span className="sub wa-none">No mobile number saved</span>;
  return (
    <a className={`btn wa${small ? ' small' : ''}`} href={whatsappLink(phone, whatsappMessageFor(a, s, kind))}
      target="_blank" rel="noreferrer" onClick={() => onSent?.()}>
      <Icon name="whatsapp" size={20} /> {label ?? 'WhatsApp'}
    </a>
  );
}

/**
 * "How did they find you?": the six answers the booking page offers (or Not known), and with A friend
 * or Other a few words, such as who recommended them. On New appointment, and an appointment's Found you.
 */
export function FoundYouFields({ value, onChange, label = 'How did they find you?', hint }: {
  value: FoundYouAnswer; onChange: (v: FoundYouAnswer) => void; label?: string; hint?: ReactNode;
}) {
  const friend = value.heard_from === 'friend';
  return (
    <>
      <Field label={label} hint={hint}>
        <select value={value.heard_from ?? ''}
          onChange={(e) => onChange({ ...value, heard_from: isHeardFrom(e.target.value) ? e.target.value : null })}>
          <option value="">Not known</option>
          {HEARD_FROM.map((h) => <option key={h.value} value={h.value}>{h.label}</option>)}
        </select>
      </Field>
      {takesDetail(value.heard_from) && (
        <Field label={friend ? 'Who recommended them? (optional)' : 'A few words (optional)'}>
          <input type="text" value={value.detail} maxLength={HEARD_FROM_DETAIL_MAX} autoComplete="off"
            placeholder={friend ? 'e.g. Sam' : 'e.g. a wedding fair'} onChange={(e) => onChange({ ...value, detail: e.target.value })} />
        </Field>
      )}
    </>
  );
}

/** What ReviewAsk needs from the screen it's on (the appointment, which keeps it for the sheet and the card alike). */
export interface ReviewAskState {
  /** When she last asked this client for a review (their record): null for never, undefined while that's loading. */
  askedAt: string | null | undefined;
  /** She has just asked: note it on their record. */
  onAsk: () => void;
}

/** A star, for Google reviews (decorative). */
export function Star({ size = 18 }: { size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" />
    </svg>
  );
}

/**
 * Once a visit is done: ask the client for a Google review on WhatsApp, in her review wording with her
 * link filled in. It only asks, the same way every time, and offers nothing for it (Google's rules).
 * Once asked, it says when, with Ask again. No mobile: Copy message. No review link saved: one line
 * saying where to add it. Only on the day of the visit, while she can ask them in person if it's OK
 * (the same rule as the next visit after Mark as done): for a visit from another day it says when she
 * asked, or to ask at their next visit.
 */
export function ReviewAsk({ a, s, review, today, card = false }: {
  a: Appointment; s: Settings; review: ReviewAskState;
  /** The visit is today's, in her time zone. */
  today: boolean;
  /** In a card of its own (on the appointment), rather than under the next visit in the sheet. */
  card?: boolean;
}) {
  const [again, setAgain] = useState(false);
  const toast = useToast();
  const headId = useId();
  const cls = `od-review${card ? ' card stack od-review-card' : ''}`;
  if (!s.review_link?.trim()) {
    if (!today) return null;
    return (
      <p className="sub od-review-none">
        To ask clients for a Google review here, add your review link in <Link to="/settings/booking-page">Settings → Booking page</Link>.
      </p>
    );
  }
  if (review.askedAt === undefined) return null;
  if (!today) {
    return (
      <div className={`${cls} od-review-asked${review.askedAt ? '' : ' od-review-later'}`}>
        <span className="od-review-when">
          <Star size={17} /> {review.askedAt ? reviewAskedText(review.askedAt, s.timezone)
            : 'Not asked for a Google review yet: you can ask at their next visit'}
        </span>
      </div>
    );
  }
  if (review.askedAt && !again) {
    return (
      <div className={`${cls} od-review-asked`}>
        <span className="od-review-when"><Star size={17} /> {reviewAskedText(review.askedAt, s.timezone)}</span>
        <button type="button" className="btn ghost small od-review-again" onClick={() => setAgain(true)}>Ask again</button>
      </div>
    );
  }
  const first = firstName(a.client?.full_name ?? a.booking_name);
  const message = fillTemplate(templateFor('review', s), a, s);
  const phone = a.client?.phone_e164;
  // Noted once the tap has opened WhatsApp (this button is then replaced by when she asked).
  const asked = () => { window.setTimeout(() => { setAgain(false); review.onAsk(); }, 0); };
  async function copy() {
    try { await navigator.clipboard.writeText(message); toast('Message copied'); } catch { window.prompt('Copy this:', message); }
    asked();
  }
  return (
    <section className={cls} aria-labelledby={headId}>
      <div className="od-review-head">
        <span className="od-ic small lemon" aria-hidden="true"><Star /></span>
        <h3 id={headId}>Ask {first || 'them'} for a Google review</h3>
      </div>
      <p className="sub od-review-note">Ask if it’s OK to send your link, then tap.</p>
      {phone ? (
        <a className="btn wa block" href={whatsappLink(phone, message)} target="_blank" rel="noreferrer" onClick={asked}>
          <Icon name="whatsapp" size={20} /> Send on WhatsApp
        </a>
      ) : (
        <button type="button" className="btn block" onClick={copy}><Icon name="copy" size={20} /> Copy message</button>
      )}
    </section>
  );
}
