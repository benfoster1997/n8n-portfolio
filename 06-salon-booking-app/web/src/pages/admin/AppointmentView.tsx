import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { WhatsAppButton } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, LateChip, Seg, Sheet, Spinner, StatusChip, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { lateCharge, lateChargePayments } from '../../lib/reminders';
import { availableSlots } from '../../lib/slots';
import { addDays, dateInZone, fmtDay, fmtDayLong, fmtDayTime, fmtTime, minutesLabel, startOfDayInstant, todayInZone, zonedToInstant } from '../../lib/time';
import { fillTemplate, firstName, freeChangeDeadline, lateFromEarlierChange, manageLink, money, noticeLabel, parsePounds, whatsappLink } from '../../lib/text';
import type { Appointment, CancelledBy, ClientChange, EmailKind, PayMethod, Settings } from '../../lib/types';

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
    if (!window.confirm('Mark as a no-show? They will still be treated as a new client next time (deposit required).')) return;
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

  return (
    <div className="page stack">
      <TopBar title={a.client?.full_name ?? 'Appointment'} back />

      <div className="card stack">
        <div className="row spread">
          <div>
            <div style={{ fontWeight: 700, fontSize: '1.1rem' }}>{a.service_name}</div>
            <div className="sub">{fmtDayLong(a.starts_at, tz)} · {fmtTime(a.starts_at, tz)}–{fmtTime(a.ends_at, tz)} ({minutesLabel(a.duration_min)})</div>
          </div>
          <StatusChip status={a.status} />
        </div>
        {a.status === 'cancelled' && (
          <div className="notice">
            <b>{a.cancelled_by ? CANCELLED_BY[a.cancelled_by] : 'Cancelled'}</b>{a.cancelled_at && ` · ${fmtDayTime(a.cancelled_at, tz)}`}
            {a.cancel_reason && a.cancelled_by !== 'system' && <div>{a.cancelled_by === 'client' ? 'Their reason' : 'Reason'}: “{a.cancel_reason}”</div>}
          </div>
        )}
        <dl className="kv">
          <dt>Price</dt><dd>{money(a.price_pence)}</dd>
          <dt>Reference</dt><dd className="mono">{a.reference}</dd>
          <dt>Booked</dt><dd>{a.source === 'online' ? 'Online' : 'By you'} · {fmtDayTime(a.created_at, tz)}</dd>
          {a.is_new_client && <><dt>Client</dt><dd>New client{a.has_form ? ' · form on file' : <span className="flag"> · no consultation form</span>}</dd></>}
          {a.deposit_required_pence > 0 && <>
            <dt>Deposit</dt>
            <dd>{money(a.deposit_required_pence)} · {a.deposit_paid_at ? `received ${fmtDayTime(a.deposit_paid_at, tz)}` : a.deposit_due_at ? <span className={overdue ? 'flag' : ''}>due by {fmtDayTime(a.deposit_due_at, tz)}{overdue ? ' (overdue)' : ''}</span> : 'not received'}</dd>
          </>}
        </dl>
        {a.client_notes && <div className="notice"><b>Client’s note:</b> {a.client_notes}</div>}
        {a.cancellation_policy_agreed && (
          <details>
            <summary className="sub">✓ Agreed to your cancellation policy when booking</summary>
            <p className="sub" style={{ whiteSpace: 'pre-wrap' }}>{a.cancellation_policy_agreed}</p>
          </details>
        )}
      </div>

      {checkPhone && a.client && (
        <div className="notice warn stack" role="note" aria-label="Check their mobile">
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
        <div className="btn-row">
          {phone && !lateId && (live && !checkPhone ? <WhatsAppButton a={a} s={s} label="WhatsApp" />
            : <a className="btn wa" href={whatsappLink(phone, `Hi ${first}, `)} target="_blank" rel="noreferrer"><Icon name="whatsapp" size={20} /> WhatsApp</a>)}
          {a.client.phone && <a className="btn" href={`tel:${a.client.phone.replace(/\s/g, '')}`}><Icon name="phone" size={20} /> Call</a>}
          <Link className="btn" to={`/clients/${a.client.id}`}>Client record</Link>
        </div>
      )}

      {lateId && (
        <div className="card stack attention">
          <h3>Late cancellation</h3>
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
            <div key={p.id} className="notice">✓ Payment recorded: {money(p.amount_pence)} by {METHOD_LABEL[p.method]}, {fmtDay(`${p.paid_on}T12:00:00Z`, tz)}</div>
          ))}
          {owing && charge.received > 0 && <p className="sub" style={{ margin: 0 }}>Still owed: {money(charge.owed)}.</p>}
          {owing && phone && !checkPhone && (
            <a className="btn wa block" href={whatsappLink(phone, lateChargeMessage(a, s, charge))} target="_blank" rel="noreferrer">
              <Icon name="whatsapp" size={20} /> WhatsApp {first}
            </a>
          )}
          {owing && <button className="btn ok block" onClick={() => setSheet('late')}><Icon name="tick" size={20} /> Record payment received</button>}
        </div>
      )}

      {a.status === 'pending_deposit' && (
        <div className="card stack attention">
          <h3>Waiting for the {money(a.deposit_required_pence)} deposit</h3>
          <p className="sub">When the money shows in your bank (reference <b className="mono">{a.reference}</b>), mark it received. The client gets an email saying they’re confirmed.</p>
          <button className="btn ok block" onClick={() => setSheet('deposit')}><Icon name="tick" size={20} /> Deposit received</button>
          {checkPhone && phone && <p className="sub" style={{ margin: 0 }}>Check their mobile above before you ask on WhatsApp.</p>}
          {phone && !checkPhone && <WhatsAppButton a={a} s={s} kind="deposit" label="Ask for the deposit on WhatsApp" />}
        </div>
      )}

      {live && !a.has_form && (
        <div className="card stack">
          <h3>Consultation form</h3>
          <p className="sub">{a.is_new_client ? 'This new client hasn’t filled in the health and allergy form yet.' : 'No health and allergy form on file for this client. Send them the link to fill one in.'}</p>
          {checkPhone && phone && <p className="sub" style={{ margin: 0 }}>Check their mobile above before you send this link.</p>}
          <div className="btn-row">
            {phone && !checkPhone && (
              <a className="btn wa" target="_blank" rel="noreferrer" style={WIDE}
                href={whatsappLink(phone, `Hi ${first}, before your appointment please fill in this quick consultation form (it takes 2 minutes): ${formUrl}\n${s.business_name}`)}>
                <Icon name="whatsapp" size={20} /> Send form link
              </a>
            )}
            <button className="btn" onClick={() => copy(formUrl, 'Form link')}><Icon name="link" size={20} /> Copy link</button>
          </div>
        </div>
      )}

      {live && (
        <div className="stack">
          {started && <button className="btn primary block" onClick={() => setSheet('checkout')}>Finish &amp; take payment</button>}
          <div className="btn-row">
            <button className="btn" onClick={() => setSheet('move')}>Change time</button>
            {started && <button className="btn" onClick={noShow}>No-show</button>}
            <button className="btn danger" onClick={() => setSheet('cancel')}>Cancel</button>
          </div>
        </div>
      )}

      {live && s.client_self_service && (
        <div className="card stack">
          <h3>Change or cancel link</h3>
          <p className="sub">Lets {first} change or cancel this booking themselves.</p>
          <div className="mono" style={{ overflowWrap: 'anywhere', fontSize: '0.9rem' }}>{changeUrl}</div>
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
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} disabled={act.busy} onClick={newLink}>Make a new link</button>
        </div>
      )}

      {changes && changes.length > 0 && (
        <>
          <div className="section-title">Changes made by the client</div>
          <div className="card tight"><ul className="list">
            {changes.map((c) => (
              <li key={c.id} className="list-row" style={{ alignItems: 'flex-start' }}>
                <div className="grow">
                  <div className="title">{CHANGE_LABEL[c.action]}</div>
                  {changeLines(c, tz).map((line) => <div key={line} className="meta">{line}</div>)}
                  {c.note && <div className="meta">“{c.note}”</div>}
                  <div className="meta">On {fmtDayTime(c.changed_at, tz)}</div>
                </div>
                {c.late && <LateChip />}
              </li>
            ))}
          </ul></div>
        </>
      )}

      <div className="card stack">
        <h3>Your notes</h3>
        <textarea value={notes ?? a.owner_notes ?? ''} maxLength={2000} placeholder="Colour, shape, anything to remember…"
          onChange={(e) => setNotes(e.target.value)} />
        {notes !== null && <button className="btn primary" disabled={act.busy} onClick={saveNotes}>Save notes</button>}
      </div>

      <ErrorBox error={act.error} />

      <div className="section-title">Emails</div>
      <div className="card tight">
        {emails && emails.length ? (
          <ul className="list">
            {emails.map((e) => (
              <li key={e.id} className="list-row">
                <Icon name="mail" size={20} />
                <div className="grow">
                  <div className="title">{EMAIL_LABEL[e.kind]}</div>
                  <div className="meta">
                    {e.status === 'sent' ? `Sent ${e.sent_at ? fmtDayTime(e.sent_at, tz) : ''}` : e.status === 'pending' || e.status === 'sending' ? 'Waiting to send' : e.status === 'skipped' ? 'Not needed' : 'Failed'}
                    {e.last_error ? ` · ${e.last_error}` : ''}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        ) : <div className="empty">{a.client?.email ? 'No emails yet.' : 'No email address saved for this client.'}</div>}
      </div>
      {live && a.client?.email && <button className="btn ghost" disabled={act.busy} onClick={resend}>Re-send confirmation email</button>}

      {sheet === 'deposit' && <DepositSheet a={a} onClose={() => setSheet(null)} onDone={() => { toast('Deposit recorded — client confirmed'); done(); }} />}
      {sheet === 'checkout' && <CheckoutSheet a={a} onClose={() => setSheet(null)} onDone={() => { toast('Payment recorded'); done(); }} />}
      {sheet === 'move' && <MoveSheet a={a} tz={tz} onClose={() => setSheet(null)} onDone={(msg) => { toast(msg); done(); }} />}
      {sheet === 'cancel' && <CancelSheet a={a} onClose={() => setSheet(null)} onDone={() => { toast('Appointment cancelled'); done(); }} />}
      {sheet === 'late' && (
        <LatePaymentSheet a={a} tz={tz} amount={charge.owed} onClose={() => setSheet(null)}
          onDone={() => { toast('Payment recorded'); setSheet(null); reloadLate(); }} />
      )}
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
        <p className="sub">This records {money(a.deposit_required_pence)} in your takings, confirms the booking and emails the client.</p>
        <ErrorBox error={error} />
        <button className="btn ok block" disabled={busy} onClick={async () => { if (await run(() => api.markDepositPaid(a.id, method))) onDone(); }}>
          {busy ? 'Saving…' : 'Confirm deposit received'}
        </button>
      </div>
    </Sheet>
  );
}

function CheckoutSheet({ a, onClose, onDone }: { a: Appointment; onClose: () => void; onDone: () => void }) {
  const depositPaid = a.deposit_paid_at ? a.deposit_required_pence : 0;
  const [amount, setAmount] = useState(((Math.max(0, a.price_pence - depositPaid)) / 100).toFixed(2));
  const [tip, setTip] = useState('');
  const [method, setMethod] = useState<PayMethod>('cash');
  const [note, setNote] = useState('');
  const { busy, error, run, setError } = useAction();
  async function save() {
    const p = parsePounds(amount || '0');
    const t = tip ? parsePounds(tip) : 0;
    if (p === null || t === null) return setError(new Error('Check the amounts.'));
    if (await run(() => api.completeAppointment(a.id, p, method, t, note.trim() || null))) onDone();
  }
  return (
    <Sheet title="Finish & take payment" onClose={onClose}>
      <div className="stack">
        {depositPaid > 0 && <div className="notice">{money(depositPaid)} deposit already paid — the balance is {money(Math.max(0, a.price_pence - depositPaid))}.</div>}
        <Field label="Amount paid today (£)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Tip (£)" hint="Optional"><input type="text" inputMode="decimal" value={tip} placeholder="0" onChange={(e) => setTip(e.target.value)} /></Field>
        <MethodPicker value={method} onChange={setMethod} />
        <Field label="Note" hint="Optional — e.g. extra nail art"><input type="text" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Mark as done'}</button>
      </div>
    </Sheet>
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
        <Field label="Amount received (£)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <MethodPicker value={method} onChange={setMethod} />
        <ErrorBox error={error} />
        <button className="btn ok block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
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
        <div className="row">
          <Field label="Date"><input type="date" value={day} onChange={(e) => setDay(e.target.value)} /></Field>
          <Field label="Minutes"><input type="number" inputMode="numeric" min={5} step={5} value={duration} onChange={(e) => setDuration(e.target.value)} /></Field>
        </div>
        <Field label="Start time"><input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} /></Field>
        {slots.length > 0 && (
          <div className="slot-grid">
            {slots.map((d) => { const t = fmtTime(d, tz); return <button key={t} className={`slot${t === time ? ' on' : ''}`} onClick={() => setTime(t)}>{t}</button>; })}
          </div>
        )}
        {email ? (
          <label className="check">
            <input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} />
            <span>Email {first} their new time<br /><span className="sub">A “your booking has changed” email, sent within 10 minutes.</span></span>
          </label>
        ) : (
          <p className="sub">There’s no email address for {first}, so they aren’t told automatically — send them a WhatsApp with the new time afterwards.</p>
        )}
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save new time'}</button>
      </div>
    </Sheet>
  );
}

function CancelSheet({ a, onClose, onDone }: { a: Appointment; onClose: () => void; onDone: () => void }) {
  const { settings: s } = useOwner();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(!!a.client?.email);
  const [late, setLate] = useState(false);
  const { busy, error, run } = useAction();
  // Inside the notice period, or the client already changed it inside one: if the
  // client is the one cancelling, it's a late cancellation. No notice period means no policy.
  const changedLate = s.cancel_notice_hours > 0 && a.late_fee_pence != null;
  const inNotice = changedLate
    || (s.cancel_notice_hours > 0 && Date.now() > freeChangeDeadline(a.starts_at, s.cancel_notice_hours).getTime());
  const who = firstName(a.client?.full_name) || 'The client';
  return (
    <Sheet title="Cancel appointment" onClose={onClose}>
      <div className="stack">
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
