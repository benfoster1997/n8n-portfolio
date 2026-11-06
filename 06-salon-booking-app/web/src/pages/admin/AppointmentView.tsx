import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { api } from '../../api';
import { WhatsAppButton } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, LateChip, Seg, Sheet, Spinner, StatusChip, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { lateCharge, lateChargePayments } from '../../lib/reminders';
import { availableSlots } from '../../lib/slots';
import { addDays, dateInZone, fmt, fmtDay, fmtDayLong, fmtDayTime, fmtTime, minutesLabel, startOfDayInstant, todayInZone, zonedToInstant } from '../../lib/time';
import { fillTemplate, firstName, freeChangeDeadline, lateFromEarlierChange, manageLink, money, noticeLabel, parsePounds, whatsappLink } from '../../lib/text';
import { formLine, formOrConsent, patchTestLine } from '../../lib/health';
import { isUnfinished, noShowQuestion } from '../../lib/unfinished';
import {
  doneLine, newAppointmentLink, nextVisitDays, nextVisitOptions, nextVisitQuestion, sameTreatment, type Treatment,
} from '../../lib/nextVisit';
import { Glyph } from './Clients';
import type { Appointment, ApptHealth, CancelledBy, ClientChange, EmailKind, PayMethod, Settings } from '../../lib/types';

const EMAIL_LABEL: Record<EmailKind, string> = {
  booking_received: 'Booking confirmation',
  deposit_received: 'Deposit received',
  reminder: 'Reminder',
  cancelled: 'Cancellation',
  changed: 'Booking changed',
  owner_new_booking: 'New booking alert (to you)',
  owner_changed: 'Change alert (to you)',
  owner_cancelled: 'Cancellation alert (to you)',
};

const CANCELLED_BY: Record<CancelledBy, string> = {
  client: 'Cancelled by the client online',
  owner: 'Cancelled by you',
  system: 'Cancelled automatically — the deposit didn’t arrive in time',
};

const CHANGE_LABEL: Record<ClientChange['action'], string> = {
  moved: 'Moved', treatment: 'Switched treatment', moved_treatment: 'Moved and switched treatment', cancelled: 'Cancelled',
};

const METHOD_LABEL: Record<PayMethod, string> = { cash: 'cash', bank_transfer: 'bank transfer' };

export function AppointmentView() {
  const { id = '' } = useParams();
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const toast = useToast();
  // Just added from New appointment: a client with no email address gets the confirmation by WhatsApp.
  const justAdded = !!(useLocation().state as { added?: boolean } | null)?.added;
  const { data: a, error, loading, reload, setData } = useLoad(() => api.getAppointment(id), [id]);
  const { data: emails, reload: reloadEmails } = useLoad(() => api.listEmailLog(id), [id]);
  const { data: changes } = useLoad(() => api.listClientChanges({ appointmentId: id }), [id]);
  // Money already received for a late cancellation (the deposit isn't counted here).
  const lateId = a?.status === 'cancelled' && a.cancelled_late ? a.id : null;
  const { data: late, loading: lateLoading, reload: reloadLate } = useLoad(async () => {
    if (!lateId || !a) return { id: lateId, received: [] };
    return { id: lateId, received: lateChargePayments(a, await api.listPayments(dateInZone(a.cancelled_at ?? a.starts_at, tz), todayInZone(tz))) };
  }, [lateId]);
  const lateReceived = late?.received;
  const [sheet, setSheet] = useState<null | 'deposit' | 'checkout' | 'move' | 'cancel' | 'late'>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const act = useAction();

  if (loading && !a) return <Spinner />;
  if (!a) return <div className="page"><TopBar title="Appointment" back /><ErrorBox error={error ?? new Error('not_found')} /></div>;

  const live = a.status === 'confirmed' || a.status === 'pending_deposit';
  // Over, but still Confirmed or Deposit due: Today lists it under "Not finished yet".
  const unfinished = isUnfinished(a);
  const started = new Date(a.starts_at) <= new Date(Date.now() + 2 * 3600e3);
  const overdue = a.status === 'pending_deposit' && a.deposit_due_at && new Date(a.deposit_due_at) < new Date();
  const phone = a.client?.phone_e164;
  const first = firstName(a.client?.full_name ?? a.booking_name) || 'the client';
  const formUrl = `${(s.public_site_url || window.location.origin).replace(/\/$/, '')}/form/${a.public_token}`;
  const changeUrl = manageLink(a, s);
  const done = () => { setSheet(null); reload(); reloadEmails(); };
  const copy = async (text: string, what: string) => {
    try { await navigator.clipboard.writeText(text); toast(`${what} copied`); } catch { window.prompt('Copy this link:', text); }
  };

  // A late cancellation: the full price is payable under the policy, less any deposit already paid
  // and anything received since. The same sum as Today's "Late cancellations".
  const charge = lateCharge(a, lateReceived ?? []);
  // Only offer to chase or record money once what's already come in has loaded.
  const owing = !lateLoading && late?.id === lateId && charge.owed > 0;
  // Cancelled in good time, but late because the client had already changed it inside the notice period.
  const lateFromChange = lateFromEarlierChange(a, s.cancel_notice_hours);
  // A mobile typed with this booking that isn't the one on the client record: nothing carrying
  // their private link goes by WhatsApp until she has checked which is right.
  const checkPhone = !!a.booking_phone;

  async function saveNotes() {
    if (notes === null) return;
    if (await act.run(async () => setData(await api.updateAppointment(a!.id, { owner_notes: notes.trim() || null })))) {
      setNotes(null);
      toast('Notes saved');
    }
  }
  async function noShow() {
    // Whether they'd be asked for a deposit next time follows the booking page's rule: a client with
    // no visit marked as done who isn't ticked as a regular. If that can't be checked, the question says it generally.
    const visits = await api.countCompletedVisits(a!.client_id).catch(() => null);
    const question = noShowQuestion({ name: first, visits, regular: !!a!.health?.is_regular, depositPence: s.deposit_amount_pence });
    if (!window.confirm(question)) return;
    if (await act.run(() => api.updateAppointment(a!.id, { status: 'no_show' }))) { toast('Marked as no-show'); reload(); }
  }
  async function adoptBookingPhone() {
    const typed = a!.booking_phone!;
    if (await act.run(async () => {
      await api.updateClient(a!.client_id, { phone: typed });
      await api.updateAppointment(a!.id, { booking_phone: null });
    })) { toast(`Client record updated to ${typed}`); reload(); }
  }
  async function keepRecordPhone() {
    if (await act.run(async () => setData(await api.updateAppointment(a!.id, { booking_phone: null })))) {
      toast(a!.client?.phone ? 'Kept the number on their record' : 'Number not used');
    }
  }
  async function newLink() {
    if (!window.confirm('The old link will stop working. Use this if the link reached the wrong person.')) return;
    let token = '';
    if (await act.run(async () => { token = await api.resetManageLink(a!.id); })) {
      setData({ ...a!, public_token: token });
      toast('New link made — the old one no longer works');
    }
  }
  async function resend() {
    if (await act.run(() => api.queueEmail(a!.id, a!.status === 'confirmed' && a!.deposit_paid_at ? 'deposit_received' : 'booking_received'))) {
      toast('Email queued — it goes out within 10 minutes');
      reloadEmails();
    }
  }

  // What the client changed online. While the booking is live it's the first thing to see, so it sits
  // straight under the hero; on a cancelled booking the hero already says who cancelled.
  const changesCard = changes && changes.length > 0 && (
    <>
      <div className="section-title">Changes made by the client</div>
      <div className="card od-timeline"><ul>
        {changes.map((c) => (
          <li key={c.id} className={`od-tl-item${c.action === 'cancelled' ? ' od-tl-cancelled' : ''}`}>
            <span className="od-tl-dot" aria-hidden="true" />
            <div className="grow">
              <div className="od-tl-head"><span className="title">{CHANGE_LABEL[c.action]}</span>{c.late && <LateChip />}</div>
              {changeLines(c, tz).map((line) => <div key={line} className="od-tl-line">{line}</div>)}
              {c.note && <div className="od-tl-note">“{c.note}”</div>}
              <div className="od-tl-when">On {fmtDayTime(c.changed_at, tz)}</div>
            </div>
          </li>
        ))}
      </ul></div>
    </>
  );

  return (
    <div className="page stack od od-appt">
      <TopBar title={a.client?.full_name ?? 'Appointment'} back />

      <div className={`card od-hero od-hero-${a.status}`}>
        <div className="od-hero-main">
          <DateTile iso={a.starts_at} tz={tz} />
          <div className="od-hero-info">
            <div className="od-hero-chips"><StatusChip status={a.status} unfinished={unfinished} /></div>
            <div className="od-hero-service">{a.service_name}</div>
            <div className="od-when">
              <span className="od-when-day">{fmtDayLong(a.starts_at, tz)}</span>
              <span className="visually-hidden"> · </span>
              <span className="od-when-line">
                <span className="od-when-time">{fmtTime(a.starts_at, tz)}–{fmtTime(a.ends_at, tz)}</span>{' '}
                <span className="od-when-dur">{minutesLabel(a.duration_min)}</span>
              </span>
            </div>
          </div>
        </div>
        {a.status === 'cancelled' && (
          <div className="od-cancelled">
            <span className="od-cancelled-ic" aria-hidden="true" />
            <div className="grow">
              <b>{a.cancelled_by ? CANCELLED_BY[a.cancelled_by] : 'Cancelled'}</b>
              {a.cancelled_at && <span className="od-cancelled-when"><span className="visually-hidden"> · </span>{fmtDayTime(a.cancelled_at, tz)}</span>}
              {a.cancel_reason && a.cancelled_by !== 'system' && <div className="od-cancelled-reason">{a.cancelled_by === 'client' ? 'Their reason' : 'Reason'}: “{a.cancel_reason}”</div>}
            </div>
          </div>
        )}
        <dl className="od-receipt">
          <div><dt>Price</dt><dd className="od-price">{money(a.price_pence)}</dd></div>
          <div><dt>Reference</dt><dd className="mono od-ref">{a.reference}</dd></div>
          <div><dt>Booked</dt><dd>{a.source === 'online' ? 'Online' : 'By you'}{DOT}<span className="od-nowrap">{fmtDayTime(a.created_at, tz)}</span></dd></div>
          {a.is_new_client && <div><dt>Client</dt><dd>New client{formOrConsent(a) ? <>{DOT}<span className="od-nowrap">form on file</span></> : <span className="flag">{DOT}no consultation form</span>}</dd></div>}
          {a.deposit_required_pence > 0 && (
            <div>
              <dt>Deposit</dt>
              <dd>{money(a.deposit_required_pence)}{DOT}{a.deposit_paid_at ? <>received <span className="od-nowrap">{fmtDayTime(a.deposit_paid_at, tz)}</span></> : a.deposit_due_at ? <span className={overdue ? 'flag' : ''}>due{'\u00a0'}by <span className="od-nowrap">{fmtDayTime(a.deposit_due_at, tz)}</span>{overdue ? ' (overdue)' : ''}</span> : 'not received'}</dd>
            </div>
          )}
        </dl>
        {a.client_notes && <div className="od-quote"><b>Client’s note:</b> {a.client_notes}</div>}
        {a.cancellation_policy_agreed && (
          <details className="od-agreed">
            <summary className="sub">Agreed to your cancellation policy when booking</summary>
            <p className="sub" style={{ whiteSpace: 'pre-wrap' }}>{a.cancellation_policy_agreed}</p>
          </details>
        )}
      </div>

      {justAdded && a.status === 'confirmed' && a.client && !a.client.email && phone && (
        <section className="card stack od-added" aria-label="Added to your diary">
          <div className="od-panel-head">
            <span className="od-ic ok" aria-hidden="true"><Icon name="tick" size={20} /></span>
            <h3>Added to your diary</h3>
          </div>
          <p className="sub">
            {firstName(a.client.full_name) || 'This client'} has no email address, so no confirmation email goes. Send your
            “Booking confirmed” message on WhatsApp instead.
          </p>
          <WhatsAppButton a={a} s={s} kind="confirmed" label="Send on WhatsApp" />
        </section>
      )}

      {a.status !== 'cancelled' && a.health && (
        <HealthStrip a={a} h={a.health} s={s} first={first} phone={phone} checkPhone={checkPhone} formUrl={formUrl} onCopy={copy} />
      )}

      {live && changesCard}

      {checkPhone && a.client && (
        <div className="notice warn stack od-check-phone" role="note" aria-label="Check their mobile">
          <div>
            {a.client.phone
              ? <>The mobile given with this booking ({a.booking_phone}) is different from {a.client.phone} on their client record.</>
              : <>The mobile given with this booking ({a.booking_phone}) isn’t on their client record.</>}
            {' '}Check which is right before you WhatsApp them.
          </div>
          <div className="btn-row">
            <button className="btn small" disabled={act.busy} onClick={adoptBookingPhone}>Use {a.booking_phone} for this client</button>
            <button className="btn small" disabled={act.busy} onClick={keepRecordPhone}>{a.client.phone ? 'Keep the record’s number' : 'Don’t use it'}</button>
          </div>
        </div>
      )}

      {a.client && (
        <div className="od-contact">
          {phone && !lateId && (live && !checkPhone ? <WhatsAppButton a={a} s={s} label="WhatsApp" />
            : <a className="btn wa" href={whatsappLink(phone, `Hi ${first}, `)} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={20} /> WhatsApp</a>)}
          {a.client.phone && <a className="btn" href={`tel:${a.client.phone.replace(/\s/g, '')}`}><Icon name="phone" size={20} /> Call</a>}
          <Link className="btn" to={`/clients/${a.client.id}`}><Glyph name="user" size={20} /> Client record</Link>
        </div>
      )}

      {lateId && (
        <div className="card stack attention od-panel">
          <div className="od-panel-head">
            <span className="od-ic lemon" aria-hidden="true"><Glyph name="alert" /></span>
            <h3>Late cancellation</h3>
          </div>
          <p style={{ margin: 0 }}>
            {lateFromChange ? `They changed this booking with less than ${noticeLabel(s.cancel_notice_hours)} earlier, so this cancellation counts as late.`
              : s.cancel_notice_hours > 0 ? `Cancelled with less than ${noticeLabel(s.cancel_notice_hours)}.` : 'Cancelled at short notice.'}{' '}
            Under your cancellation policy the full {money(charge.fee)} is payable — you arrange this with the client yourself.
          </p>
          {charge.fee !== a.price_pence && (
            <p className="sub" style={{ margin: 0 }}>That’s the price when they first changed it inside your notice period (it’s {money(a.price_pence)} now).</p>
          )}
          {charge.deposit > 0 && <p className="sub" style={{ margin: 0 }}>They’ve already paid a {money(charge.deposit)} deposit, so the balance is {money(Math.max(0, charge.fee - charge.deposit))}.</p>}
          {(lateReceived ?? []).map((p) => (
            <div key={p.id} className="od-paid">Payment recorded: {money(p.amount_pence)} by {METHOD_LABEL[p.method]}, {fmtDay(`${p.paid_on}T12:00:00Z`, tz)}</div>
          ))}
          {owing && charge.received > 0 && <p className="od-owed" style={{ margin: 0 }}>Still owed: {money(charge.owed)}.</p>}
          {owing && <button className="btn primary block" onClick={() => setSheet('late')}><Icon name="tick" size={20} /> Record payment received</button>}
          {owing && phone && !checkPhone && (
            <a className="btn wa block" href={whatsappLink(phone, lateChargeMessage(a, s, charge))} target="_blank" rel="noreferrer">
              <Icon name="whatsapp" size={20} /> WhatsApp {first}
            </a>
          )}
        </div>
      )}

      {a.status === 'pending_deposit' && (
        <div className="card stack attention od-panel">
          <div className="od-panel-head">
            <span className="od-ic lemon" aria-hidden="true"><Glyph name="clock" /></span>
            <h3>Waiting for the {money(a.deposit_required_pence)} deposit</h3>
          </div>
          <p className="sub">When the money shows in your bank (reference <b className="mono od-ref-pill">{a.reference}</b>), mark it received. The client gets an email saying they’re confirmed.</p>
          <button className="btn primary block" onClick={() => setSheet('deposit')}><Icon name="tick" size={20} /> Deposit received</button>
          {checkPhone && phone && <p className="sub" style={{ margin: 0 }}>Check their mobile above before you ask on WhatsApp.</p>}
          {phone && !checkPhone && <WhatsAppButton a={a} s={s} kind="deposit" label="Ask for the deposit on WhatsApp" />}
        </div>
      )}

      {live && (
        <div className="od-actions">
          {started && (
            <button className="btn primary block od-finish" onClick={() => setSheet('checkout')}>
              <Glyph name="receipt" size={21} /> Finish &amp; take payment
            </button>
          )}
          <div className="od-actions-row">
            <button className="btn" onClick={() => setSheet('move')}>Change time</button>
            <button className="btn danger" onClick={() => setSheet('cancel')}>Cancel</button>
          </div>
          {started && <button className="btn ghost small od-noshow" onClick={noShow}>No-show</button>}
        </div>
      )}

      {live && s.client_self_service && (
        <div className="card stack od-tool">
          <div className="od-panel-head">
            <span className="od-ic" aria-hidden="true"><Icon name="link" size={20} /></span>
            <h3>Change or cancel link</h3>
          </div>
          <p className="sub">Lets {first} change or cancel this booking themselves.</p>
          <ChangeUrl url={changeUrl} />
          {checkPhone && phone && <p className="sub" style={{ margin: 0 }}>Check their mobile above before you send this link.</p>}
          <div className="btn-row">
            {phone && !checkPhone && (
              <a className="btn wa" href={whatsappLink(phone, fillTemplate(MANAGE_MESSAGE, a, s))}
                target="_blank" rel="noreferrer" style={WIDE}>
                <Icon name="whatsapp" size={20} /> Send on WhatsApp
              </a>
            )}
            <button className="btn" onClick={() => copy(changeUrl, 'Link')}><Icon name="link" size={20} /> Copy link</button>
          </div>
          <button className="btn ghost small" style={{ alignSelf: 'center' }} disabled={act.busy} onClick={newLink}>Make a new link</button>
        </div>
      )}

      {!live && changesCard}

      <div className="card stack od-notes">
        <div className="od-panel-head">
          <span className="od-ic" aria-hidden="true"><Glyph name="pencil" /></span>
          <h3>Your notes</h3>
        </div>
        <textarea value={notes ?? a.owner_notes ?? ''} maxLength={2000} placeholder="Colour, shape, anything to remember…"
          onChange={(e) => setNotes(e.target.value)} />
        {notes !== null && <button className="btn primary" disabled={act.busy} onClick={saveNotes}>Save notes</button>}
      </div>

      <ErrorBox error={act.error} />

      <div className="section-title">Emails</div>
      <div className="card tight od-emails">
        {emails && emails.length ? (
          <ul className="list">
            {emails.map((e) => {
              const state = e.status === 'sent' ? 'sent' : e.status === 'pending' || e.status === 'sending' ? 'waiting' : e.status === 'skipped' ? 'skipped' : 'failed';
              return (
                <li key={e.id} className={`list-row od-email od-email-${state}`}>
                  <span className="od-ic small" aria-hidden="true"><Icon name="mail" size={18} /></span>
                  <div className="grow">
                    <div className="title">{EMAIL_LABEL[e.kind]}</div>
                    <div className="meta">
                      {e.status === 'sent' ? `Sent ${e.sent_at ? fmtDayTime(e.sent_at, tz) : ''}` : e.status === 'pending' || e.status === 'sending' ? 'Waiting to send' : e.status === 'skipped' ? 'Not needed' : 'Failed'}
                      {e.last_error ? ` · ${e.last_error}` : ''}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <div className="empty">{a.client?.email ? 'No emails yet.' : 'No email address saved for this client.'}</div>}
      </div>
      {live && a.client?.email && <button className="btn ghost" disabled={act.busy} onClick={resend}>Re-send confirmation email</button>}

      {sheet === 'deposit' && <DepositSheet a={a} onClose={() => setSheet(null)} onDone={() => { toast('Deposit recorded — client confirmed'); done(); }} />}
      {/* The sheet stays open once it's done, to book the next visit; the screen behind it already says Done. */}
      {sheet === 'checkout' && <CheckoutSheet a={a} onClose={() => setSheet(null)} onFinished={() => { reload(); reloadEmails(); }} />}
      {sheet === 'move' && <MoveSheet a={a} tz={tz} onClose={() => setSheet(null)} onDone={(msg) => { toast(msg); done(); }} />}
      {sheet === 'cancel' && (
        <CancelSheet a={a} onClose={() => setSheet(null)} onDone={() => { toast('Appointment cancelled'); done(); }}
          onNoShow={() => { setSheet(null); void noShow(); }} />
      )}
      {sheet === 'late' && (
        <LatePaymentSheet a={a} tz={tz} amount={charge.owed} onClose={() => setSheet(null)}
          onDone={() => { toast('Payment recorded'); setSheet(null); reloadLate(); }} />
      )}
    </div>
  );
}

/** A little calendar page: weekday on a pink band, the day, the month (as on the client's ticket). Decorative; the date is spelled out beside it. */
function DateTile({ iso, tz }: { iso: string; tz: string }) {
  return (
    <div className="od-datetile" aria-hidden="true">
      <span className="od-dt-dow">{fmt(iso, 'EEE', tz)}</span>
      <span className="od-dt-day">{fmt(iso, 'd', tz)}</span>
      <span className="od-dt-mon">{fmt(iso, 'MMM', tz)}</span>
    </div>
  );
}

/**
 * The client's allergies, latest patch test and consultation form, near the top: what she needs
 * before she starts. Consent she recorded (a paper form, WhatsApp or email) counts as a form on
 * file. With none on file, or one over a year old, the form link to send: it works until a day
 * after the appointment. The full answers are on the client's record.
 */
function HealthStrip({ a, h, s, first, phone, checkPhone, formUrl, onCopy }: {
  a: Appointment; h: ApptHealth; s: Settings; first: string; phone: string | null | undefined; checkPhone: boolean;
  formUrl: string; onCopy: (text: string, what: string) => void;
}) {
  const tz = s.timezone;
  const test = patchTestLine(h.patch_tests, tz, a.starts_at);
  const form = formLine(h, tz, a.starts_at);
  const live = a.status === 'confirmed' || a.status === 'pending_deposit';
  const linkWorks = live && new Date(a.starts_at).getTime() > Date.now() - 86400e3;
  const ask = linkWorks && (!form.onFile || form.old);
  const formTone = !form.onFile ? (live ? 'danger' : 'quiet') : form.old ? 'warn' : 'plain';
  return (
    <section className="card od-hstrip" aria-label="Health and allergies">
      {h.allergies?.trim() && (
        <p className="od-hstrip-allergy"><span className="od-hstrip-allergy-ic" aria-hidden="true" /><span><b>Allergies:</b> {h.allergies}</span></p>
      )}
      <dl className="od-receipt od-hstrip-rows">
        <div><dt>Patch test</dt><dd className={`od-hs-${test.tone}`}>{test.text}</dd></div>
        <div><dt>Consultation form</dt><dd className={`od-hs-${formTone}`}>{form.text}</dd></div>
      </dl>
      {ask && form.old && <p className="od-hstrip-note">Form over a year old: send a fresh one.</p>}
      {ask && checkPhone && phone && <p className="sub od-hstrip-note">Check their mobile below before you send the form link.</p>}
      {ask && (
        <div className="btn-row od-hstrip-btns">
          {phone && !checkPhone && (
            <a className="btn wa small" target="_blank" rel="noreferrer"
              href={whatsappLink(phone, `Hi ${first}, before your appointment please fill in this quick consultation form (it takes 2 minutes): ${formUrl}\n${s.business_name}`)}>
              <Icon name="whatsapp" size={18} /> Send form link
            </a>
          )}
          <button className="btn small" onClick={() => onCopy(formUrl, 'Form link')}><Icon name="link" size={18} /> Copy link</button>
        </div>
      )}
    </section>
  );
}

/** " · " that never starts a line: a line can break only after the dot. */
const DOT = '\u00a0· ';

/** The change link, split so it wraps after the host and at the token's hyphens rather than mid-word. */
function ChangeUrl({ url }: { url: string }) {
  const at = url.indexOf('/manage/');
  if (at < 0) return <div className="mono od-url">{url}</div>;
  return (
    <div className="mono od-url">
      <span className="od-url-host">{url.slice(0, at)}</span><wbr />/manage/<wbr />{url.slice(at + '/manage/'.length)}
    </div>
  );
}

/** A WhatsApp button that takes its own line on a phone rather than wrapping its label. */
const WIDE = { flex: '1 1 210px' };

// {change_note} gives the link with the time to change by while that's still ahead, or says the policy now applies.
const MANAGE_MESSAGE = 'Hi {first_name}, here’s your own link for your {service} appointment on {date} at {time}.\n\n{change_note}\n{business}';

/** "Tue 3 Nov, 15:00 → Wed 4 Nov, 12:00", "BIAB infill (£30) → BIAB new set (£35)". */
function changeLines(c: ClientChange, tz: string): string[] {
  const at = (iso: string | null) => (iso ? fmtDayTime(iso, tz) : '—');
  const svc = (name: string | null, pence: number | null) => `${name ?? '—'}${pence !== null ? ` (${money(pence)})` : ''}`;
  if (c.action === 'cancelled') return [`${c.old_service_name ?? ''} · ${at(c.old_starts_at)}`];
  const lines: string[] = [];
  if (c.action !== 'treatment') lines.push(`${at(c.old_starts_at)} → ${at(c.new_starts_at)}`);
  if (c.action !== 'moved') lines.push(`${svc(c.old_service_name, c.old_price_pence)} → ${svc(c.new_service_name, c.new_price_pence)}`);
  return lines;
}

/**
 * A polite note about the late-cancellation charge, with bank details and the booking reference.
 * The reason matches what the client was told: cancelled inside the notice period, or changed inside it earlier.
 */
function lateChargeMessage(a: Appointment, s: Settings, c: ReturnType<typeof lateCharge>): string {
  const notice = s.cancel_notice_hours > 0 ? `with less than ${noticeLabel(s.cancel_notice_hours)}` : 'at short notice';
  const paid = c.received > 0 ? `${money(c.deposit + c.received)} you’ve already paid` : `${money(c.deposit)} deposit you’ve already paid`;
  const first = firstName(a.client?.full_name ?? a.booking_name);
  const when = `${fmtDayLong(a.starts_at, s.timezone)} at ${fmtTime(a.starts_at, s.timezone)}`;
  // A late switch to something cheaper keeps the price before it, so say where the amount comes from.
  const payable = `the full ${money(c.fee)}${c.fee > a.price_pence ? ' (the price of your booking before it was changed)' : ''} is payable under my cancellation policy` +
    (c.deposit + c.received > 0 ? ` — that’s ${money(c.owed)} after the ${paid}.` : '.');
  const lines = lateFromEarlierChange(a, s.cancel_notice_hours) ? [
    // Cancelled in good time: no "sorry you couldn’t make it", and the reason is the earlier change.
    `Hi ${first}, about your cancelled ${a.service_name} booking on ${when} (reference ${a.reference}): as it was changed ${notice}, ${payable}`,
    '',
  ] : [
    `Hi ${first}, sorry you couldn’t make your ${a.service_name} appointment on ${when}.`,
    '',
    `As it was cancelled ${notice}, ${payable}`,
    '',
  ];
  if (s.bank_account_number) {
    lines.push('Could you send it by bank transfer when you get a chance?', '',
      `Name: ${s.bank_account_name ?? ''}`, `Sort code: ${s.bank_sort_code ?? ''}`, `Account: ${s.bank_account_number}`, `Reference: ${a.reference}`);
  } else {
    lines.push(`Please let me know how you’d like to pay (reference ${a.reference}).`);
  }
  lines.push('', 'Thank you!', s.business_name);
  return lines.join('\n');
}

function MethodPicker({ value, onChange }: { value: PayMethod; onChange: (m: PayMethod) => void }) {
  return <Seg label="Paid by" value={value} onChange={onChange} options={[{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' }]} />;
}

function DepositSheet({ a, onClose, onDone }: { a: Appointment; onClose: () => void; onDone: () => void }) {
  const [method, setMethod] = useState<PayMethod>('bank_transfer');
  const { busy, error, run } = useAction();
  return (
    <Sheet title={`Deposit received · ${money(a.deposit_required_pence)}`} onClose={onClose}>
      <div className="stack">
        <MethodPicker value={method} onChange={setMethod} />
        <p className="sub od-sheet-note">This records {money(a.deposit_required_pence)} in your takings, confirms the booking and emails the client.</p>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={async () => { if (await run(() => api.markDepositPaid(a.id, method))) onDone(); }}>
          {busy ? 'Saving…' : 'Confirm deposit received'}
        </button>
      </div>
    </Sheet>
  );
}

/**
 * Finish & take payment. Once it's marked as done the sheet stays open on the next visit
 * (NextVisit), while the screen behind it updates; Not now, Close or Escape closes it.
 */
function CheckoutSheet({ a, onClose, onFinished }: { a: Appointment; onClose: () => void; onFinished: () => void }) {
  const depositPaid = a.deposit_paid_at ? a.deposit_required_pence : 0;
  const [amount, setAmount] = useState(((Math.max(0, a.price_pence - depositPaid)) / 100).toFixed(2));
  const [tip, setTip] = useState('');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [note, setNote] = useState('');
  const [recorded, setRecorded] = useState<{ amount: number; tip: number } | null>(null);
  const { busy, error, run, setError } = useAction();
  async function save() {
    const p = parsePounds(amount || '0');
    const t = tip ? parsePounds(tip) : 0;
    if (p === null || t === null) return setError(new Error('Check the amounts.'));
    if (await run(() => api.completeAppointment(a.id, p, method, t, note.trim() || null))) {
      setRecorded({ amount: p, tip: t });
      onFinished();
    }
  }
  if (recorded) {
    return (
      <Sheet title="Next visit" onClose={onClose}>
        <NextVisit a={a} recorded={recorded} onClose={onClose} />
      </Sheet>
    );
  }
  return (
    <Sheet title="Finish & take payment" onClose={onClose}>
      <div className="stack">
        <dl className="od-receipt od-receipt-sheet">
          <div><dt>{a.service_name}</dt><dd>{money(a.price_pence)}</dd></div>
          {depositPaid > 0 && <>
            <div><dt>Deposit already paid</dt><dd>−{money(depositPaid)}</dd></div>
            <div className="od-receipt-total"><dt>Balance</dt><dd className="od-price">{money(Math.max(0, a.price_pence - depositPaid))}</dd></div>
          </>}
        </dl>
        <div className="stack od-amounts">
          <div className="od-amount"><Field label="Amount paid today (£)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field></div>
          <div className="od-amount od-amount-tip"><Field label="Tip (£)" hint="Optional"><input type="text" inputMode="decimal" value={tip} placeholder="0" onChange={(e) => setTip(e.target.value)} /></Field></div>
        </div>
        <MethodPicker value={method} onChange={setMethod} />
        <Field label="Note" hint="Optional — e.g. extra nail art"><input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Mark as done'}</button>
      </div>
    </Sheet>
  );
}

/**
 * After "Mark as done": what was recorded, then the same treatment in 2, 3 or 4 weeks, each with
 * the date and time it would book (the same weekday and time if that's free, otherwise the
 * nearest free time), and Pick a date. A tap opens New appointment filled in.
 */
function NextVisit({ a, recorded, onClose }: { a: Appointment; recorded: { amount: number; tip: number }; onClose: () => void }) {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const box = useRef<HTMLDivElement>(null);
  // The payment form has gone from under the focus: keep it in the sheet, back at its top.
  useEffect(() => {
    const sheet = box.current?.closest<HTMLElement>('.sheet');
    if (sheet) { sheet.scrollTop = 0; sheet.focus({ preventScroll: true }); }
  }, []);
  const { data, error } = useLoad(async () => {
    const { first, last } = nextVisitDays(a.starts_at, tz);
    const [services, hours, busy, theirs] = await Promise.all([
      api.listServices(), api.listOpeningHours(),
      api.getBusyTimes(startOfDayInstant(first, tz), startOfDayInstant(addDays(last, 1), tz)),
      api.listClientAppointments(a.client_id),
    ]);
    const now = new Date();
    const treatment = sameTreatment(a, services);
    const options = nextVisitOptions(a.starts_at, treatment.minutes, { ...s, hours }, busy, now);
    // Already booked in: say so, so they aren't booked twice.
    const booked = theirs.filter((x) => x.id !== a.id && (x.status === 'confirmed' || x.status === 'pending_deposit')
      && new Date(x.starts_at) > now).sort((x, y) => x.starts_at.localeCompare(y.starts_at))[0] ?? null;
    return { treatment, options, booked };
  }, [a.id]);
  const name = a.client?.full_name ?? a.booking_name;
  const first = firstName(name);
  // If her list couldn't be loaded, Pick a date still starts on this treatment.
  const treatment: Treatment = data?.treatment
    ?? { serviceId: a.service_id, name: a.service_name, minutes: a.duration_min, pricePence: a.price_pence };
  return (
    <div className="stack od-next" ref={box}>
      <p className="od-paid od-next-done" role="status">{doneLine(recorded.amount, recorded.tip)}</p>
      <h3 className="od-next-q">{nextVisitQuestion(name, treatment.name)}</h3>
      {data?.booked && (
        <p className="sub od-next-booked">
          {first ? `${first} is` : 'They’re'} already booked in for {data.booked.service_name} on <span className="od-nowrap">{fmtDayTime(data.booked.starts_at, tz)}</span>.
        </p>
      )}
      <ErrorBox error={error} />
      {!data && !error ? <Spinner /> : (
        <ul className="list card tight od-next-list">
          {data?.options.map((o) => (
            <li key={o.weeks}>
              {o.at ? (
                <Link className="list-row od-next-row" to={newAppointmentLink(a.client_id, treatment, { day: dateInZone(o.at, tz), time: fmtTime(o.at, tz) })}>
                  <span className="od-next-text">
                    <span className="od-next-label">In {o.weeks} weeks</span>
                    {!o.same && <span className="od-next-note"><span className="visually-hidden"> · </span>Nearest free time</span>}
                  </span>
                  <span className="od-next-when"><span className="visually-hidden"> · </span>{fmtDayTime(o.at, tz)}</span>
                  <span className="chev"><Icon name="chev" size={18} /></span>
                </Link>
              ) : (
                <div className="list-row od-next-row is-full">
                  <span className="od-next-text">
                    <span className="od-next-label">In {o.weeks} weeks</span>
                    <span className="od-next-note"><span className="visually-hidden"> · </span>Nothing free around then</span>
                  </span>
                </div>
              )}
            </li>
          ))}
          <li>
            <Link className="list-row od-next-row" to={newAppointmentLink(a.client_id, treatment)}>
              <span className="od-next-text"><span className="od-next-label">Pick a date</span></span>
              <span className="chev"><Icon name="chev" size={18} /></span>
            </Link>
          </li>
        </ul>
      )}
      <button className="btn block" onClick={onClose}>Not now</button>
    </div>
  );
}

/** Money received for a late cancellation, added to the takings as other income. */
function LatePaymentSheet({ a, tz, amount: owed, onClose, onDone }: { a: Appointment; tz: string; amount: number; onClose: () => void; onDone: () => void }) {
  const [amount, setAmount] = useState((owed / 100).toFixed(2));
  const [method, setMethod] = useState<PayMethod>('bank_transfer');
  const { busy, error, run, setError } = useAction();
  async function save() {
    const pence = parsePounds(amount);
    if (!pence || pence < 0) return setError(new Error('Enter the amount you received.'));
    if (await run(() => api.addPayment({
      appointment_id: a.id, client_id: a.client_id, client_name: a.client?.full_name ?? a.booking_name ?? null,
      description: `Late cancellation · ${a.service_name}`, amount_pence: pence, method, kind: 'other',
      paid_on: todayInZone(tz), note: null,
    }))) onDone();
  }
  return (
    <Sheet title="Record payment received" onClose={onClose}>
      <div className="stack">
        <p className="sub">For the late cancellation of {a.service_name}. It’s added to your takings in Money.</p>
        <div className="od-amount"><Field label="Amount received (£)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field></div>
        <MethodPicker value={method} onChange={setMethod} />
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Sheet>
  );
}

function MoveSheet({ a, tz, onClose, onDone }: { a: Appointment; tz: string; onClose: () => void; onDone: (message: string) => void }) {
  const { settings: s } = useOwner();
  const toast = useToast();
  const [day, setDay] = useState(dateInZone(a.starts_at, tz));
  const [time, setTime] = useState(fmtTime(a.starts_at, tz));
  const [duration, setDuration] = useState(String(a.duration_min));
  const email = a.client?.email;
  const first = firstName(a.client?.full_name ?? a.booking_name) || 'the client';
  const [notify, setNotify] = useState(!!email);
  const { data } = useLoad(async () => {
    const from = startOfDayInstant(day, tz).toISOString();
    const to = startOfDayInstant(addDays(day, 1), tz).toISOString();
    const [appts, off, hours] = await Promise.all([api.listAppointments(from, to), api.listTimeOff(from), api.listOpeningHours()]);
    // Everything that blocks the day, except this appointment itself.
    const busy = [
      ...appts.filter((x) => x.id !== a.id && ['pending_deposit', 'confirmed', 'completed'].includes(x.status))
        .map((x) => ({ starts_at: x.starts_at, ends_at: new Date(new Date(x.ends_at).getTime() + s.buffer_min * 60e3).toISOString() })),
      ...off.filter((t) => t.starts_at < to).map((t) => ({ starts_at: t.starts_at, ends_at: t.ends_at })),
    ];
    return { busy, hours };
  }, [day]);
  const slots = useMemo(() => {
    if (!data) return [];
    return availableSlots(day, Number(duration) || a.duration_min, { ...s, hours: data.hours }, data.busy, new Date(), { ignoreNotice: true });
  }, [data, day, duration, a, s]);
  const { busy, error, run, setError } = useAction();
  async function save() {
    const mins = Number(duration);
    if (!mins || mins < 5) return setError(new Error('Check the length.'));
    const starts = zonedToInstant(day, time, tz);
    // Saved as it was: no update, and no "your booking has changed" email.
    if (starts.getTime() === new Date(a.starts_at).getTime() && mins === a.duration_min) {
      toast('Nothing changed');
      return onClose();
    }
    const tell = notify && !!email;
    let emailFailed = false;
    const ok = await run(async () => {
      await api.updateAppointment(a.id, { starts_at: starts.toISOString(), duration_min: mins });
      // The time has moved by now: a failed email mustn't look like a failed move.
      if (tell) await api.queueEmail(a.id, 'changed').catch(() => { emailFailed = true; });
    });
    if (ok) onDone(!tell ? 'Time changed' : emailFailed ? `Time changed, but the email couldn’t be sent — WhatsApp ${first} instead` : `Time changed — ${first} will be emailed`);
  }
  return (
    <Sheet title="Change time" onClose={onClose}>
      <div className="stack">
        <div className="row od-move-row">
          <Field label="Date"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field label="Minutes"><input type="number" inputMode="numeric" min={5} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        </div>
        <Field label="Start time"><input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        {slots.length > 0 && (
          <>
            <span className="od-slots-label">Free times for a {minutesLabel(Number(duration) || a.duration_min)} appointment:</span>
            <div className="slot-grid">
              {slots.map((d) => { const t = fmtTime(d, tz); return <button key={t} className={`slot${t === time ? ' on' : ''}`} onClick={() => setTime(t)}>{t}</button>; })}
            </div>
          </>
        )}
        {email ? (
          <label className="check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>Email {first} their new time<br /><span className="sub">A “your booking has changed” email, sent within 10 minutes.</span></span>
          </label>
        ) : (
          <p className="notice warn od-move-note">There’s no email address for {first}, so they aren’t told automatically — send them a WhatsApp with the new time afterwards.</p>
        )}
        {/* stays in view at the bottom of the sheet while a long list of free times scrolls behind it */}
        <div className="od-sheet-foot">
          <ErrorBox error={error} />
          <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save new time'}</button>
        </div>
      </div>
    </Sheet>
  );
}

function CancelSheet({ a, onClose, onDone, onNoShow }: { a: Appointment; onClose: () => void; onDone: () => void; onNoShow: () => void }) {
  const { settings: s } = useOwner();
  // Already started (or over): a client who never came is a no-show, which sends no email, so the
  // email starts unticked, and a cancellation now isn't a late one by the client.
  const [begun] = useState(() => new Date(a.starts_at).getTime() <= Date.now());
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(!!a.client?.email && !begun);
  const [late, setLate] = useState(false);
  const { busy, error, run } = useAction();
  // Inside the notice period, or the client already changed it inside one: if the
  // client is the one cancelling, it's a late cancellation. No notice period means no policy.
  const changedLate = s.cancel_notice_hours > 0 && a.late_fee_pence != null;
  const inNotice = !begun && (changedLate
    || (s.cancel_notice_hours > 0 && Date.now() > freeChangeDeadline(a.starts_at, s.cancel_notice_hours).getTime()));
  const who = firstName(a.client?.full_name) || 'The client';
  return (
    <Sheet title="Cancel appointment" onClose={onClose}>
      <div className="stack">
        {begun && (
          <div className="notice od-noshow-hint">
            <p>If {firstName(a.client?.full_name ?? a.booking_name) || 'the client'} never came, mark a <span className="od-nowrap">no-show</span> instead: it doesn’t email them.</p>
            <button type="button" className="btn small" onClick={onNoShow}>Mark as a no-show</button>
          </div>
        )}
        <Field label="Reason (optional)" hint={notify ? 'Included in the email to the client.' : undefined}>
          <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {a.client?.email && (
          <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>Email the client to let them know</span></label>
        )}
        {inNotice && (
          <label className="check">
            <input type="checkbox" checked={late} onChange={(e) => setLate(e.target.checked)} />
            <span>{changedLate
              ? `${who} already changed this booking with less than ${noticeLabel(s.cancel_notice_hours)} — mark this cancellation as late`
              : `${who} cancelled with less than ${noticeLabel(s.cancel_notice_hours)} — mark it as a late cancellation`}</span>
          </label>
        )}
        {a.deposit_paid_at && <div className="notice warn">A {money(a.deposit_required_pence)} deposit was paid. If you’re refunding it, add a refund in Money.</div>}
        <ErrorBox error={error} />
        <button className="btn danger solid block" disabled={busy}
          onClick={async () => { if (await run(() => api.cancelAppointment(a.id, reason.trim() || null, notify, inNotice && late))) onDone(); }}>
          {busy ? 'Cancelling…' : 'Cancel appointment'}
        </button>
      </div>
    </Sheet>
  );
}
