import { Link } from 'react-router-dom';
import { api } from '../../api';
import { WhatsAppButton } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Icon, Spinner, StatusChip, TopBar, useLoad } from '../../components/ui';
import { addDays, fmtDayLong, fmtTime, startOfDayInstant, todayInZone } from '../../lib/time';
import { dueWhatsAppReminders, reminderDates, reminderRange } from '../../lib/reminders';
import type { Appointment } from '../../lib/types';

/**
 * One-tap WhatsApp reminders. Sending automatically through WhatsApp costs
 * money per message; opening WhatsApp with the message already written and
 * letting the owner press send is free. The days ahead follow the reminder
 * setting (72 hours = the next 3 days); today comes last, for last-minute ones.
 */
export function Reminders() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const ahead = reminderDates(s);
  const { data, error, loading, setData } = useLoad(() => {
    const { fromIso, toIso } = reminderRange(s);
    return api.listAppointments(fromIso, toIso);
  }, [today, s.reminder_hours_before]);

  const now = new Date();
  const live = (data ?? []).filter((a) => (a.status === 'confirmed' || a.status === 'pending_deposit') && new Date(a.starts_at) > now);
  const due = new Set(dueWhatsAppReminders(live, s).map((a) => a.id));
  const days = [...ahead, today];
  const span = ahead.length === 1 ? 'tomorrow' : `the next ${ahead.length} days`;

  async function markSent(a: Appointment) {
    const when = new Date().toISOString();
    setData((data ?? []).map((x) => (x.id === a.id ? { ...x, whatsapp_reminder_sent_at: when } : x)));
    try { await api.updateAppointment(a.id, { whatsapp_reminder_sent_at: when }); } catch { /* shown as not sent next time */ }
  }

  const initials = (a: Appointment) => (a.client?.full_name ?? a.booking_name ?? '?')
    .split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

  return (
    <div className="page rm-page">
      <TopBar title="WhatsApp reminders" back />
      <div className="rm-intro">
        <span className="rm-intro-ico" aria-hidden="true"><Icon name="whatsapp" size={22} /></span>
        <p>
          Reminders for {span}, from your <Link to="/settings/rules">reminder setting</Link> ({s.reminder_hours_before} hours).
          Tap a button: WhatsApp opens with the message written for you — just press send. Free, and it comes from your own number.
        </p>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : days.map((d) => {
        const list = live.filter((a) => a.starts_at >= startOfDayInstant(d, tz).toISOString() && a.starts_at < startOfDayInstant(addDays(d, 1), tz).toISOString());
        const toSend = list.filter((a) => due.has(a.id)).length;
        return (
          <section key={d} className={`rm-day${d === today ? ' is-today' : ''}`}>
            <div className="day-head rm-day-head">
              <h2>{d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDayLong(d + 'T12:00:00Z', tz)}</h2>
              <span className={`rm-day-sub${toSend && d !== today ? ' has-due' : ''}`}>{!list.length ? '' : d === today ? `${list.length} still to come` : `${list.length} booked${toSend ? ` · ${toSend} to send` : ''}`}</span>
            </div>
            <div className="card tight rm-card">
              {list.length === 0 ? <div className="empty rm-empty">{d === today ? 'Nothing else today.' : 'No appointments.'}</div> : (
                <ul className="list">
                  {list.map((a) => {
                    const sent = !!(a.whatsapp_reminder_sent_at || a.reminder_email_sent_at);
                    return (
                      <li key={a.id} className={`rm-item${a.whatsapp_reminder_sent_at ? ' is-sent' : due.has(a.id) ? ' is-due' : ''}`}>
                        <div className="rm-top">
                          <span className="rm-avatar" aria-hidden="true"><span>{initials(a)}</span></span>
                          <Link to={`/appointments/${a.id}`} className="rm-who grow">
                            <div className="rm-line"><span className="rm-time">{fmtTime(a.starts_at, tz)}</span><span className="visually-hidden"> · </span><span className="rm-name">{a.client?.full_name}</span></div>
                            <div className="rm-svc">{a.service_name}</div>
                          </Link>
                          <div className="rm-chips">
                            {a.booking_phone && (
                              <Link className="chip warn rm-check" to={`/appointments/${a.id}`}
                                title={`They gave ${a.booking_phone} when booking, not the number on their record`}>Check mobile</Link>
                            )}
                            <StatusChip status={a.status} />
                          </div>
                        </div>
                        <div className="rm-bottom">
                          <span className="rm-state">
                            {a.whatsapp_reminder_sent_at && <span className="rm-done"><span className="visually-hidden">✓ </span>WhatsApp opened</span>}
                            {a.reminder_email_sent_at && <span className="rm-done"><span className="visually-hidden">✓ </span>Email sent</span>}
                            {!sent && due.has(a.id) && <span className="rm-todo">Ready to send</span>}
                          </span>
                          <WhatsAppButton small a={a} s={s} label={a.status === 'pending_deposit' ? 'Ask for deposit' : 'Send reminder'} onSent={() => markSent(a)} />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
