import { Link } from 'react-router-dom';
import type { Appointment, ClientChange, Settings } from '../lib/types';
import { fmtDayTime, fmtTime, minutesLabel } from '../lib/time';
import { fillTemplate, money, templateFor, whatsappLink } from '../lib/text';
import { Icon, LateChip, StatusChip } from './ui';

export function ApptRow({ a, tz, showDate }: { a: Appointment; tz: string; showDate?: (iso: string) => string }) {
  const overdue = a.status === 'pending_deposit' && a.deposit_due_at && new Date(a.deposit_due_at) < new Date();
  return (
    <li>
      <Link className="list-row" to={`/appointments/${a.id}`}>
        <div className="time-col">
          {fmtTime(a.starts_at, tz)}
          <small>{showDate ? showDate(a.starts_at) : minutesLabel(a.duration_min)}</small>
        </div>
        <div className="grow">
          <div className="title">{a.client?.full_name ?? a.booking_name ?? 'Client'}</div>
          <div className="meta">
            {a.service_name}
            {a.price_pence > 0 && ` · ${money(a.price_pence)}`}
            {a.is_new_client && ' · New'}
            {a.is_new_client && !a.has_form && a.status !== 'completed' && a.status !== 'cancelled' && <span className="flag"> · No form</span>}
          </div>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
          <StatusChip status={a.status} />
          {overdue && <span className="chip danger">Overdue</span>}
          {a.status === 'cancelled' && a.cancelled_late && <LateChip>Late cancel</LateChip>}
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
  if (!phone) return <span className="sub">No mobile number saved</span>;
  return (
    <a className={`btn wa${small ? ' small' : ''}`} href={whatsappLink(phone, whatsappMessageFor(a, s, kind))}
      target="_blank" rel="noreferrer" onClick={() => onSent?.()}>
      <Icon name="whatsapp" size={20} /> {label ?? 'WhatsApp'}
    </a>
  );
}
