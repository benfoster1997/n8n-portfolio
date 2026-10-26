import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ApptRow } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Icon, Spinner, TopBar, useLoad, useToast } from '../../components/ui';
import { addDays, fmtDay, fmtDayLong, startOfDayInstant, todayInZone, dateInZone } from '../../lib/time';
import { money } from '../../lib/text';

export function Today() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const toast = useToast();
  const { data, error, loading } = useLoad(async () => {
    const [appts, services] = await Promise.all([
      api.listAppointments(startOfDayInstant(today, tz).toISOString(),
        startOfDayInstant(addDays(today, s.max_days_ahead + 1), tz).toISOString()),
      api.listServices(),
    ]);
    return { appts, services };
  }, [today]);

  const appts = data?.appts ?? [];
  const live = appts.filter((a) => a.status !== 'cancelled');
  const todays = live.filter((a) => dateInZone(a.starts_at, tz) === today);
  const tomorrow = live.filter((a) => dateInZone(a.starts_at, tz) === addDays(today, 1));
  const deposits = appts.filter((a) => a.status === 'pending_deposit' && new Date(a.starts_at) > new Date())
    .sort((a, b) => (a.deposit_due_at ?? '').localeCompare(b.deposit_due_at ?? ''));
  const noForm = appts.filter((a) => a.is_new_client && !a.has_form && (a.status === 'confirmed' || a.status === 'pending_deposit')
    && new Date(a.starts_at) < new Date(Date.now() + 14 * 86400e3));
  const remindersToSend = tomorrow.filter((a) => (a.status === 'confirmed' || a.status === 'pending_deposit') && !a.whatsapp_reminder_sent_at && a.client?.phone_e164);
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

          {(deposits.length > 0 || noForm.length > 0) && <div className="section-title">Needs attention</div>}
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
