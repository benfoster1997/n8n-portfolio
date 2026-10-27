import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ApptRow, changeText, changedAgo } from '../../components/appts';
import { Blossom, LemonSlice } from '../../components/brand';
import { useOwner } from '../../components/owner';
import { ErrorBox, Icon, LateChip, Spinner, useLoad, useToast } from '../../components/ui';
import { addDays, fmt, fmtDay, fmtDayLong, fmtDayTime, fmtTime, startOfDayInstant, todayInZone, dateInZone } from '../../lib/time';
import { money } from '../../lib/text';
import { dueWhatsAppReminders, lateCharge, reminderDays } from '../../lib/reminders';
import type { ClientChange } from '../../lib/types';

/** Small line pictures for the "needs attention" headers and client changes (decorative). */
const GLYPHS: Record<string, ReactNode> = {
  late: <><rect x="3.5" y="5" width="17" height="15" rx="3" /><path d="M3.5 10h17M8.5 3v4M15.5 3v4M10 13.5l4 4M14 13.5l-4 4" /></>,
  deposit: <><circle cx="12" cy="12" r="8.5" /><path d="M14.6 8.6c-.5-.7-1.3-1.1-2.3-1.1-1.7 0-2.6 1.1-2.6 2.6 0 2.4.9 3.2-.4 5.7h5.9M8.6 12.6h4.6" /></>,
  form: <><rect x="5" y="4.5" width="14" height="16" rx="2.5" /><path d="M9 3.5h6v3H9zM8.5 11h7M8.5 14.5h7M8.5 18h4" /></>,
  moved: <><path d="M4 8h13M13.5 4.5 17 8l-3.5 3.5M20 16H7M10.5 12.5 7 16l3.5 3.5" /></>,
  cancelled: <><circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  treatment: <><path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9z" /><path d="M18.5 15.5l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" /></>,
};
function Glyph({ name, size = 20 }: { name: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{GLYPHS[name]}</svg>
  );
}
const changeGlyph = (c: ClientChange) => (c.action === 'cancelled' ? 'cancelled' : c.action === 'treatment' ? 'treatment' : 'moved');

/** A "needs attention" card's header: an icon, the heading and the count ("Late cancellations · 1" to a screen reader). */
function AttentionHead({ icon, title, count }: { icon: string; title: string; count: number }) {
  return (
    <div className="td-attn-head">
      <span className="td-attn-ico"><Glyph name={icon} size={18} /></span>
      <span className="td-attn-title">{title}<span className="visually-hidden"> · </span></span>
      <span className="td-attn-count">{count}</span>
    </div>
  );
}

export function Today() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const toast = useToast();
  const { data, error, loading } = useLoad(async () => {
    const ahead = Math.max(s.max_days_ahead, reminderDays(s.reminder_hours_before));
    const [appts, services, changes, late] = await Promise.all([
      api.listAppointments(startOfDayInstant(today, tz).toISOString(),
        startOfDayInstant(addDays(today, ahead + 1), tz).toISOString()),
      api.listServices(),
      api.listClientChanges({ sinceIso: new Date(Date.now() - 7 * 86400e3).toISOString() }),
      // Late cancellations from the last fortnight, by the client online or marked late by her.
      api.listLateCancellations(new Date(Date.now() - 14 * 86400e3).toISOString()),
    ]);
    // Money already received for them, from the day of the earliest one.
    const from = late.map((a) => dateInZone(a.cancelled_at ?? a.starts_at, tz)).sort()[0];
    const payments = from ? await api.listPayments(from < today ? from : today, today) : [];
    return { appts, services, changes, late, payments };
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
  // Late cancellations (online, or ones she marked late after a call or WhatsApp) stay here
  // until what's owed is recorded in Money, even once the appointment's day has gone.
  const lateCancels = (data?.late ?? []).map((a) => ({ a, ...lateCharge(a, data?.payments ?? []) })).filter((c) => c.owed > 0);
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

  // The greeting and the summary tiles: worked out from the clock and what's already loaded.
  const now = new Date();
  const hour = Number(fmt(now, 'H', tz));
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const upNext = todays.find((a) => a.status !== 'completed' && a.status !== 'no_show' && new Date(a.ends_at) > now);
  const nextNote = upNext
    ? (new Date(upNext.starts_at) <= now ? 'On now' : `Next ${fmtTime(upNext.starts_at, tz)}`)
    : todays.length ? 'All done' : 'Free day';
  const firstDue = deposits[0]?.deposit_due_at;
  const depositNote = !deposits.length ? 'None due' : !firstDue ? 'By transfer'
    : new Date(firstDue) < now ? 'Overdue' : `Due ${dateInZone(firstDue, tz) === today ? fmtTime(firstDue, tz) : fmtDay(firstDue, tz)}`;

  return (
    <div className="page td-page">
      <header className="td-head">
        <div className="td-head-text">
          <p className="td-greet">{greeting}</p>
          <div className="td-title">
            <h1>Today</h1>
            <span className="td-lemon" aria-hidden="true">
              <LemonSlice size={34} className="td-lemon-slice" />
              <Blossom size={15} className="td-lemon-blossom" />
            </span>
          </div>
          <p className="td-date">{fmtDayLong(now, tz)}</p>
        </div>
        <Link className="icon-btn td-add" to="/appointments/new" aria-label="New appointment"><Icon name="plus" /></Link>
      </header>
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : (
        <>
          <div className="td-tiles">
            <div className="td-tile td-tile-main">
              <span className="td-tile-value">{todays.length}</span>
              <span className="td-tile-label">{todays.length === 1 ? 'Appointment' : 'Appointments'}</span>
              <span className="td-tile-note">{nextNote}</span>
            </div>
            <div className="td-tile">
              <span className="td-tile-value">{money(takingsToday)}</span>
              <span className="td-tile-label">Booked today</span>
              <span className="td-tile-note">{tomorrow.length} tomorrow</span>
            </div>
            <div className={`td-tile${deposits.length ? ' td-tile-lemon' : ''}`}>
              <span className="td-tile-value">{deposits.length}</span>
              <span className="td-tile-label">{deposits.length === 1 ? 'Deposit waiting' : 'Deposits waiting'}</span>
              <span className="td-tile-note">{depositNote}</span>
            </div>
          </div>

          {setup.length > 0 && (
            <>
              <div className="section-title">Finish setting up</div>
              <div className="card tight td-setup"><ul className="list">
                {setup.map((x) => (
                  <li key={x.to}><Link className="list-row" to={x.to}>
                    <span className="td-setup-dot" aria-hidden="true" />
                    <span className="grow">{x.text}</span>
                    <span className="chev"><Icon name="chev" size={18} /></span>
                  </Link></li>
                ))}
              </ul></div>
            </>
          )}

          {emailStale && (
            <div className="notice warn td-notice">
              The email sender hasn’t checked in {s.email_last_poll_at ? `since ${fmtDay(s.email_last_poll_at, tz)}` : 'yet'} — confirmation and reminder emails may not be going out. <Link to="/settings/email">Check it</Link>
            </div>
          )}

          {(lateCancels.length > 0 || deposits.length > 0 || noForm.length > 0) && <div className="section-title no-heart">Needs attention</div>}
          {lateCancels.length > 0 && (
            <div className="card tight attention td-attn">
              <AttentionHead icon="late" title="Late cancellations" count={lateCancels.length} />
              <ul className="list">{lateCancels.map(({ a, fee, deposit, received, owed }) => (
                <li key={a.id}><Link className="list-row td-late-row" to={`/appointments/${a.id}`}>
                  <div className="title td-late-name">{a.client?.full_name ?? a.booking_name ?? 'Client'}</div>
                  <div className="meta td-late-when">{a.service_name} · {fmtDayTime(a.starts_at, tz)}</div>
                  <div className="td-late-owed">{deposit > 0 || received > 0
                    ? `Balance ${money(owed)} of the full ${money(fee)} payable under your policy`
                    : `Full ${money(fee)} payable under your policy`}</div>
                  <div className="td-late-chip"><LateChip>Late cancel</LateChip></div>
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </Link></li>
              ))}</ul>
            </div>
          )}
          {deposits.length > 0 && (
            <div className="card tight attention td-attn">
              <AttentionHead icon="deposit" title="Deposits waiting" count={deposits.length} />
              <ul className="list">{deposits.map((a) => <ApptRow key={a.id} a={a} tz={tz} showDate={(iso) => fmtDay(iso, tz)} />)}</ul>
            </div>
          )}
          {noForm.length > 0 && (
            <div className="card tight attention td-attn">
              <AttentionHead icon="form" title="New clients without a consultation form" count={noForm.length} />
              <ul className="list">{noForm.map((a) => <ApptRow key={a.id} a={a} tz={tz} showDate={(iso) => fmtDay(iso, tz)} />)}</ul>
            </div>
          )}

          <div className="day-head td-day-head">
            <h2>Today’s appointments</h2>
            {todays.length > 0 && <span className="td-count">{todays.length} booked</span>}
          </div>
          <div className="card tight td-timeline">
            {todays.length ? <ul className="list">{todays.map((a) => <ApptRow key={a.id} a={a} tz={tz} />)}</ul>
              : <div className="empty">Nothing booked today.</div>}
          </div>

          <div className="day-head td-day-head">
            <h2>Tomorrow</h2>
            <span className="td-count">{tomorrow.length} booked</span>
          </div>
          {remindersToSend.length > 0 && (
            <Link className="btn wa block td-wa" to="/reminders">
              <Icon name="whatsapp" size={20} /> Send {remindersToSend.length} WhatsApp reminder{remindersToSend.length === 1 ? '' : 's'}
            </Link>
          )}
          <div className="card tight td-timeline">
            {tomorrow.length ? <ul className="list">{tomorrow.map((a) => <ApptRow key={a.id} a={a} tz={tz} />)}</ul>
              : <div className="empty">Nothing booked tomorrow.</div>}
          </div>

          {changes.length > 0 && (
            <>
              <div className="section-title no-heart">Changed by clients</div>
              <div className="card tight td-changes"><ul className="list">
                {changes.slice(0, 8).map((c) => (
                  <li key={c.id}><Link className="list-row td-chg-row" to={`/appointments/${c.appointment_id}`}>
                    <span className={`td-chg-ico td-chg-${changeGlyph(c)}`}><Glyph name={changeGlyph(c)} size={18} /></span>
                    <div className="grow">
                      <div className="td-chg-text"><b>{c.client_name ?? 'A client'}</b> {changeText(c, tz)}</div>
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
          <div className="card td-link">
            <div className="td-link-top">
              <span className="td-badge" aria-hidden="true">
                <span className="td-badge-face">
                  <LemonSlice size={20} className="td-badge-slice" />
                  <span className="td-badge-word">Book</span>
                </span>
              </span>
              <div className="td-link-text">
                <div className="td-link-name">{s.business_name}</div>
                <div className="td-link-url"><Icon name="link" size={16} /><span>{bookingUrl.replace(/^https?:\/\//, '')}</span></div>
              </div>
            </div>
            <div className="td-link-btns">
              <button className="btn small" onClick={shareLink}><Icon name="link" size={18} /> Share link</button>
              <Link className="btn small" to="/book">Preview</Link>
            </div>
            <p className="td-link-hint">Put this in your Instagram bio and WhatsApp Business profile.</p>
          </div>
        </>
      )}
    </div>
  );
}
