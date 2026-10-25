import { Link } from 'react-router-dom';
import type { Appointment, Settings } from '../lib/types';
import { fmtTime, minutesLabel } from '../lib/time';
import { fillTemplate, money, templateFor, whatsappLink } from '../lib/text';
import { Icon, StatusChip } from './ui';

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
            {a.is_new_client && !a.has_form && a.status !== 'completed' && <span className="flag"> · No form</span>}
          </div>
        </div>
        <div className="stack" style={{ gap: 4, alignItems: 'flex-end' }}>
          <StatusChip status={a.status} />
          {overdue && <span className="chip danger">Overdue</span>}
        </div>
        <span className="chev"><Icon name="chev" size={18} /></span>
      </Link>
    </li>
  );
}

/** The template that fits where the appointment is: deposit chase, reminder or confirmation. */
export function whatsappMessageFor(a: Appointment, s: Settings, kind?: 'reminder' | 'deposit' | 'confirmed'): string {
  const k = kind ?? (a.status === 'pending_deposit' ? 'deposit' : 'reminder');
  return fillTemplate(templateFor(k, s), a, s);
}

export function WhatsAppButton({ a, s, kind, label, onSent, small }: {
  a: Appointment; s: Settings; kind?: 'reminder' | 'deposit' | 'confirmed'; label?: string;
  onSent?: () => void; small?: boolean;
}) {
  const phone = a.client?.phone_e164;
  if (!phone) return <span className="sub">No mobile number saved</span>;
  return (
    <a className={`btn wa${small ? ' small' : ''}`} href={whatsappLink(phone, whatsappMessageFor(a, s, kind))}
      target="_blank" rel="noreferrer" onClick={() => onSent?.()}>
      <Icon name="whatsapp" size={20} /> {label ?? 'WhatsApp'}
    </a>
  );
}
