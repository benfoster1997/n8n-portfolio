import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ApptRow, changeText, changedAgo } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Icon, LateChip, Spinner, TopBar, useLoad, useToast } from '../../components/ui';
import { addDays, fmtDay, fmtDayLong, fmtDayTime, startOfDayInstant, todayInZone, dateInZone } from '../../lib/time';
import { money } from '../../lib/text';
import { dueWhatsAppReminders, reminderDays } from '../../lib/reminders';

export function Today() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const toast = useToast();
  const { data, error, loading } = useLoad(async () => {
    const ahead = Math.max(s.max_days_ahead, reminderDays(s.reminder_hours_before));
    const [appts, services, changes, payments] = await Promise.all([
      api.listAppointments(startOfDayInstant(today, tz).toISOString(),
        startOfDayInstant(addDays(today, ahead + 1), tz).toISOString()),
      api.listServices(),
      api.listClientChanges({ sinceIso: new Date(Date.now() - 7 * 86400e3).toISOString() }),
      // To spot late-cancellation charges already received.
      api.listPayments(addDays(today, -7), today),
    ]);
    return { appts, services, changes, payments };
  }, [today]);

  const appts = data?.appts ?? [];
  const live = appts.filter((a) => a.status !== 'cancelled');
  const todays = live.filter((a) => dateInZone(a.starts_at, tz) === today);
  const tomorrow = live.filter((a) => dateInZone(a.starts_at, tz) === addDays(today, 1));
  const deposits = appts.filter((a) => a.status === 'pending_deposit' && new Date(a.starts_at) > new Date())
    .sort((a, b) => (a.deposit_due_at ?? '').localeCompare(b.deposit_due_at ?? ''));
  const noForm = appts.filter((a) => a.is_new_client && !a.has_form && (a.status === 'confirmed' || a.status === 'pending_deposit')
    && new Date(a.starts_at) < new Date(Date.now() + 14 * 86400e3));
  const remindersToSend = dueWhatsAppReminders(appts, s);
  const changes = data?.changes ?? [];
  // Late cancellations from the last week, until the charge is recorded in Money.
  const settled = new Set((data?.payments ?? []).filter((p) => p.kind === 'other' || p.kind === 'payment').map((p) => p.appointment_id));
  // Client cancellations online, plus ones she marked late herself (they told her by phone or WhatsApp).
  const weekAgo = new Date(Date.now() - 7 * 86400e3).toISOString();
  const lateCancels = [
    ...changes.filter((c) => c.action === 'cancelled' && c.late).map((c) => ({
      appointment_id: c.appointment_id, client_name: c.client_name, service_name: c.old_service_name,
      starts_at: c.old_starts_at, price_pence: c.old_price_pence })),
    ...appts.filter((a) => a.status === 'cancelled' && a.cancelled_late && a.cancelled_by === 'owner' && (a.cancelled_at ?? '') >= weekAgo)
      .map((a) => ({ appointment_id: a.id, client_name: a.client?.full_name ?? a.booking_name, service_name: a.service_name,
        starts_at: a.starts_at, price_pence: a.price_pence })),
  ].filter((c, i, all) => !settled.has(c.appointment_id) && all.findIndex((x) => x.appointment_id === c.appointment_id) === i);
  const takingsToday = todays.filter((a) => a.status !== 'no_show').reduce((n, a) => n + a.price_pence, 0);

  const setup: { text: string; to: string }[] = [];
  if (data && !data.services.some((v) => v.is_active)) setup.push({ text: 'Add your treatments and prices', to: '/settings/services' });
  if (!s.bank_account_number && s.deposit_amount_pence > 0) setup.push({ text: 'Add bank details for deposits', to: '/settings/deposits' });
  if (!s.public_site_url) setup.push({ text: 'Save your booking link', to: '/settings/business' });
  if (api.mode === 'live' && !s.email_secret_hash) setup.push({ text: 'Switch on email confirmations & reminders', to: '/settings/email' });
  const emailStale = api.mode === 'live' && s.email_secret_hash && (!s.email_last_poll_at || Date.now() - new Date(s.email_last_poll_at).getTime() > 3 * 3600e3);

  const bookingUrl = `${(s.public_site_url || window.location.origin).replace(/\/$/, '')}/book`;
  async function shareLink() {
    try {
      if (navigator.share) await navigator.share({ title: s.business_name, text: 'Book your appointment online', url: bookingUrl });
      else { await navigator.clipboard.writeText(bookingUrl); toast('Booking link copied'); }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === 'AbortError')) window.prompt('Copy your booking link:', bookingUrl);
    }
  }

  return (
    <div className="page">
      <TopBar title="Today" right={<Link className="icon-btn" to="/appointments/new" aria-label="New appointment"><Icon name="plus" /></Link>} />
      <p className="sub" style={{ marginTop: -8 }}>{fmtDayLong(new Date(), tz)}</p>
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : (
        <>
          {setup.length > 0 && (
            <>
              <div className="section-title">Finish setting up</div>
              <div className="card tight"><ul className="list">
                {setup.map((x) => (
                  <li key={x.to}><Link className="list-row" to={x.to}><span className="grow">{x.text}</span><span className="chev"><Icon name="chev" size={18} /></span></Link></li>
                ))}
              </ul></div>
            </>
          )}

          {emailStale && (
            <div className="notice warn" style={{ marginTop: 12 }}>
              The email sender hasn’t checked in {s.email_last_poll_at ? `since ${fmtDay(s.email_last_poll_at, tz)}` : 'yet'} — confirmation and reminder emails may not be going out. <Link to="/settings/email">Check it</Link>
            </div>
          )}

          {(lateCancels.length > 0 || deposits.length > 0 || noForm.length > 0) && <div className="section-title">Needs attention</div>}
          {lateCancels.length > 0 && (
            <div className="card tight attention" style={{ marginBottom: 10 }}>
              <div style={{ padding: '10px 16px 0', fontWeight: 600 }}>Late cancellations · {lateCancels.length}</div>
              <ul className="list">{lateCancels.map((c) => (
                <li key={c.appointment_id}><Link className="list-row" to={`/appointments/${c.appointment_id}`}>
                  <div className="grow">
                    <div className="title">{c.client_name ?? 'Client'}</div>
                    <div className="meta">{c.service_name}{c.starts_at && ` · ${fmtDayTime(c.starts_at, tz)}`}</div>
                    {!!c.price_pence && <div className="meta">Full {money(c.price_pence)} payable under your policy</div>}
                  </div>
                  <LateChip>Late cancel</LateChip>
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </Link></li>
              ))}</ul>
            </div>
          )}
          {deposits.length > 0 && (
            <div className="card tight attention" style={{ marginBottom: 10 }}>
              <div style={{ padding: '10px 16px 0', fontWeight: 600 }}>Deposits waiting · {deposits.length}</div>
              <ul className="list">{deposits.map((a) => <ApptRow key={a.id} a={a} tz={tz} showDate={(iso) => fmtDay(iso, tz)} />)}</ul>
            </div>
          )}
          {noForm.length > 0 && (
            <div className="card tight attention">
              <div style={{ padding: '10px 16px 0', fontWeight: 600 }}>New clients without a consultation form · {noForm.length}</div>
              <ul className="list">{noForm.map((a) => <ApptRow key={a.id} a={a} tz={tz} showDate={(iso) => fmtDay(iso, tz)} />)}</ul>
            </div>
          )}

          <div className="day-head">
            <h2>Today’s appointments</h2>
            {takingsToday > 0 && <span className="sub">{money(takingsToday)} booked</span>}
          </div>
          <div className="card tight">
            {todays.length ? <ul className="list">{todays.map((a) => <ApptRow key={a.id} a={a} tz={tz} />)}</ul>
              : <div className="empty">Nothing booked today.</div>}
          </div>

          <div className="day-head">
            <h2>Tomorrow</h2>
            <span className="sub">{tomorrow.length} booked</span>
          </div>
          {remindersToSend.length > 0 && (
            <Link className="btn wa block" to="/reminders" style={{ marginBottom: 10 }}>
              <Icon name="whatsapp" size={20} /> Send {remindersToSend.length} WhatsApp reminder{remindersToSend.length === 1 ? '' : 's'}
            </Link>
          )}
          <div className="card tight">
            {tomorrow.length ? <ul className="list">{tomorrow.map((a) => <ApptRow key={a.id} a={a} tz={tz} />)}</ul>
              : <div className="empty">Nothing booked tomorrow.</div>}
          </div>

          {changes.length > 0 && (
            <>
              <div className="section-title">Changed by clients</div>
              <div className="card tight"><ul className="list">
                {changes.slice(0, 8).map((c) => (
                  <li key={c.id}><Link className="list-row" to={`/appointments/${c.appointment_id}`}>
                    <div className="grow">
                      <div><b>{c.client_name ?? 'A client'}</b> {changeText(c, tz)}</div>
                      <div className="meta">{changedAgo(c.changed_at, tz)}{c.note && ` · “${c.note}”`}</div>
                    </div>
                    {c.late && <LateChip />}
                    <span className="chev"><Icon name="chev" size={18} /></span>
                  </Link></li>
                ))}
              </ul></div>
            </>
          )}

          <div className="section-title">Your booking link</div>
          <div className="card stack">
            <div className="mono" style={{ overflowWrap: 'anywhere', fontSize: '0.9rem' }}>{bookingUrl}</div>
            <div className="btn-row">
              <button className="btn" onClick={shareLink}><Icon name="link" size={20} /> Share link</button>
              <Link className="btn" to="/book">Preview</Link>
            </div>
            <p className="sub">Put this in your Instagram bio and WhatsApp Business profile.</p>
          </div>
        </>
      )}
    </div>
  );
}
