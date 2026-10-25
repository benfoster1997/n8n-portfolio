import { Link } from 'react-router-dom';
import { api } from '../../api';
import { WhatsAppButton } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Spinner, StatusChip, TopBar, useLoad } from '../../components/ui';
import { addDays, fmtDayLong, fmtTime, startOfDayInstant, todayInZone } from '../../lib/time';
import type { Appointment } from '../../lib/types';

/**
 * One-tap WhatsApp reminders. Sending automatically through WhatsApp costs
 * money per message; opening WhatsApp with the message already written and
 * letting the owner press send is free.
 */
export function Reminders() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const { data, error, loading, setData } = useLoad(
    () => api.listAppointments(startOfDayInstant(today, tz).toISOString(), startOfDayInstant(addDays(today, 3), tz).toISOString()),
    [today]);

  const live = (data ?? []).filter((a) => a.status === 'confirmed' || a.status === 'pending_deposit');
  const days = [addDays(today, 1), addDays(today, 2), today];

  async function markSent(a: Appointment) {
    const when = new Date().toISOString();
    setData((data ?? []).map((x) => (x.id === a.id ? { ...x, whatsapp_reminder_sent_at: when } : x)));
    try { await api.updateAppointment(a.id, { whatsapp_reminder_sent_at: when }); } catch { /* shown as not sent next time */ }
  }

  return (
    <div className="page">
      <TopBar title="WhatsApp reminders" back />
      <p className="sub">Tap a button: WhatsApp opens with the message written for you — just press send. Free, and it comes from your own number.</p>
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : days.map((d) => {
        const list = live.filter((a) => a.starts_at >= startOfDayInstant(d, tz).toISOString() && a.starts_at < startOfDayInstant(addDays(d, 1), tz).toISOString());
        return (
          <div key={d}>
            <div className="day-head"><h2>{d === today ? 'Today' : d === addDays(today, 1) ? 'Tomorrow' : fmtDayLong(d + 'T12:00:00Z', tz)}</h2><span className="sub">{list.length}</span></div>
            <div className="card tight">
              {list.length === 0 ? <div className="empty">No appointments.</div> : (
                <ul className="list">
                  {list.map((a) => (
                    <li key={a.id} style={{ padding: '12px 16px' }}>
                      <div className="row spread">
                        <Link to={`/appointments/${a.id}`} style={{ color: 'inherit', textDecoration: 'none' }} className="grow">
                          <div style={{ fontWeight: 600 }}>{fmtTime(a.starts_at, tz)} · {a.client?.full_name}</div>
                          <div className="sub">{a.service_name}</div>
                        </Link>
                        <StatusChip status={a.status} />
                      </div>
                      <div className="row" style={{ marginTop: 8, justifyContent: 'space-between' }}>
                        <span className="sub">{a.whatsapp_reminder_sent_at ? '✓ WhatsApp opened' : ''}{a.reminder_email_sent_at ? ' · ✓ Email sent' : ''}</span>
                        <WhatsAppButton small a={a} s={s} label={a.status === 'pending_deposit' ? 'Ask for deposit' : 'Send reminder'} onSent={() => markSent(a)} />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
