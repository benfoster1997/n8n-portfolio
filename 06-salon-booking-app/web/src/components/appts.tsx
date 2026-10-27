import { Link } from 'react-router-dom';
import type { Appointment, ClientChange, Settings } from '../lib/types';
import { fmtDayTime, fmtTime, minutesLabel } from '../lib/time';
import { fillTemplate, money, templateFor, whatsappLink } from '../lib/text';
import { Icon, LateChip, StatusChip } from './ui';

/** Where an appointment sits against the clock, for the timeline dot: done, happening now, or still to come. */
export function apptPhase(a: Pick<Appointment, 'status' | 'starts_at' | 'ends_at'>, now = Date.now()): 'cancelled' | 'past' | 'now' | 'future' {
  if (a.status === 'cancelled') return 'cancelled';
  if (a.status === 'completed' || a.status === 'no_show' || new Date(a.ends_at).getTime() <= now) return 'past';
  return new Date(a.starts_at).getTime() <= now ? 'now' : 'future';
}

/**
 * One appointment as a timeline row: the time in bold figures, a dot on a thin pink rail
 * (the rail joins up through a list), the client, treatment and price, and the status.
 */
export function ApptRow({ a, tz, showDate }: { a: Appointment; tz: string; showDate?: (iso: string) => string }) {
  const overdue = a.status === 'pending_deposit' && a.deposit_due_at && new Date(a.deposit_due_at) < new Date();
  const phase = apptPhase(a);
  const lateCancel = a.status === 'cancelled' && a.cancelled_late;
  return (
    <li className="appt-li">
      <Link className={`list-row appt-row is-${phase} st-${a.status}${overdue || lateCancel ? ' two-chips' : ''}`} to={`/appointments/${a.id}`}>
        <div className="appt-time">
          <span className="appt-clock">{fmtTime(a.starts_at, tz)}</span>
          <small title={minutesLabel(a.duration_min)}>{showDate ? showDate(a.starts_at) : `to ${fmtTime(a.ends_at, tz)}`}</small>
        </div>
        <span className="appt-dot" aria-hidden="true" />
        <div className="title appt-name">{a.client?.full_name ?? a.booking_name ?? 'Client'}</div>
        <div className="meta appt-meta">
          {a.service_name}
          {a.price_pence > 0 && <span className="nw"> · <span className="appt-price">{money(a.price_pence)}</span></span>}
          {a.is_new_client && <span className="nw"> · <span className="appt-new">New</span></span>}
          {a.is_new_client && !a.has_form && a.status !== 'completed' && a.status !== 'cancelled' && <span className="flag"> · No form</span>}
        </div>
        <div className="appt-chips">
          <StatusChip status={a.status} />
          {overdue && <span className="chip danger">Overdue</span>}
          {lateCancel && <LateChip>Late cancel</LateChip>}
        </div>
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
