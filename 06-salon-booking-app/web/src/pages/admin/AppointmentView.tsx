import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { WhatsAppButton } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, StatusChip, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { availableSlots } from '../../lib/slots';
import { addDays, dateInZone, fmtDayLong, fmtDayTime, fmtTime, minutesLabel, startOfDayInstant, zonedToInstant } from '../../lib/time';
import { firstName, money, parsePounds, whatsappLink } from '../../lib/text';
import type { Appointment, EmailKind, PayMethod } from '../../lib/types';

const EMAIL_LABEL: Record<EmailKind, string> = {
  booking_received: 'Booking confirmation',
  deposit_received: 'Deposit received',
  reminder: 'Reminder',
  cancelled: 'Cancellation',
  owner_new_booking: 'New booking alert (to you)',
};

export function AppointmentView() {
  const { id = '' } = useParams();
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const toast = useToast();
  const { data: a, error, loading, reload, setData } = useLoad(() => api.getAppointment(id), [id]);
  const { data: emails, reload: reloadEmails } = useLoad(() => api.listEmailLog(id), [id]);
  const [sheet, setSheet] = useState<null | 'deposit' | 'checkout' | 'move' | 'cancel'>(null);
  const [notes, setNotes] = useState<string | null>(null);
  const act = useAction();

  if (loading && !a) return <Spinner />;
  if (!a) return <div className="page"><TopBar title="Appointment" back /><ErrorBox error={error ?? new Error('not_found')} /></div>;

  const live = a.status === 'confirmed' || a.status === 'pending_deposit';
  const started = new Date(a.starts_at) <= new Date(Date.now() + 2 * 3600e3);
  const overdue = a.status === 'pending_deposit' && a.deposit_due_at && new Date(a.deposit_due_at) < new Date();
  const phone = a.client?.phone_e164;
  const formUrl = `${(s.public_site_url || window.location.origin).replace(/\/$/, '')}/form/${a.public_token}`;
  const done = () => { setSheet(null); reload(); reloadEmails(); };

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
        <dl className="kv">
          <dt>Price</dt><dd>{money(a.price_pence)}</dd>
          <dt>Reference</dt><dd className="mono">{a.reference}</dd>
          <dt>Booked</dt><dd>{a.source === 'online' ? 'Online' : 'By you'} · {fmtDayTime(a.created_at, tz)}</dd>
          {a.is_new_client && <><dt>Client</dt><dd>New client{a.has_form ? ' · form on file' : <span className="flag"> · no consultation form</span>}</dd></>}
          {a.deposit_required_pence > 0 && <>
            <dt>Deposit</dt>
            <dd>{money(a.deposit_required_pence)} · {a.deposit_paid_at ? `received ${fmtDayTime(a.deposit_paid_at, tz)}` : a.deposit_due_at ? <span className={overdue ? 'flag' : ''}>due by {fmtDayTime(a.deposit_due_at, tz)}{overdue ? ' (overdue)' : ''}</span> : 'not received'}</dd>
          </>}
          {a.cancel_reason && <><dt>Reason</dt><dd>{a.cancel_reason}</dd></>}
        </dl>
        {a.client_notes && <div className="notice"><b>Client’s note:</b> {a.client_notes}</div>}
      </div>

      {a.client && (
        <div className="btn-row">
          {phone && <WhatsAppButton a={a} s={s} label="WhatsApp" />}
          {a.client.phone && <a className="btn" href={`tel:${a.client.phone.replace(/\s/g, '')}`}><Icon name="phone" size={20} /> Call</a>}
          <Link className="btn" to={`/clients/${a.client.id}`}>Client record</Link>
        </div>
      )}

      {a.status === 'pending_deposit' && (
        <div className="card stack attention">
          <h3>Waiting for the {money(a.deposit_required_pence)} deposit</h3>
          <p className="sub">When the money shows in your bank (reference <b className="mono">{a.reference}</b>), mark it received. The client gets an email saying they’re confirmed.</p>
          <button className="btn ok block" onClick={() => setSheet('deposit')}><Icon name="tick" size={20} /> Deposit received</button>
          {phone && <WhatsAppButton a={a} s={s} kind="deposit" label="Ask for the deposit on WhatsApp" />}
        </div>
      )}

      {live && !a.has_form && (
        <div className="card stack">
          <h3>Consultation form</h3>
          <p className="sub">{a.is_new_client ? 'This new client hasn’t filled in the health and allergy form yet.' : 'No health and allergy form on file for this client. Send them the link to fill one in.'}</p>
          <div className="btn-row">
            {phone && (
              <a className="btn wa" target="_blank" rel="noreferrer"
                href={whatsappLink(phone, `Hi ${firstName(a.client?.full_name)}, before your appointment please fill in this quick consultation form (it takes 2 minutes): ${formUrl}\n${s.business_name}`)}>
                <Icon name="whatsapp" size={20} /> Send form link
              </a>
            )}
            <button className="btn" onClick={async () => { await navigator.clipboard?.writeText(formUrl); toast('Form link copied'); }}><Icon name="link" size={20} /> Copy link</button>
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
      {sheet === 'move' && <MoveSheet a={a} tz={tz} onClose={() => setSheet(null)} onDone={() => { toast('Time changed'); done(); }} />}
      {sheet === 'cancel' && <CancelSheet a={a} onClose={() => setSheet(null)} onDone={() => { toast('Appointment cancelled'); done(); }} />}
    </div>
  );
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

function MoveSheet({ a, tz, onClose, onDone }: { a: Appointment; tz: string; onClose: () => void; onDone: () => void }) {
  const { settings: s } = useOwner();
  const [day, setDay] = useState(dateInZone(a.starts_at, tz));
  const [time, setTime] = useState(fmtTime(a.starts_at, tz));
  const [duration, setDuration] = useState(String(a.duration_min));
  const { data } = useLoad(async () => {
    const [busy, hours] = await Promise.all([
      api.getBusyTimes(startOfDayInstant(day, tz), startOfDayInstant(addDays(day, 1), tz)), api.listOpeningHours()]);
    return { busy, hours };
  }, [day]);
  const slots = useMemo(() => {
    if (!data) return [];
    // Ignore this appointment's own busy time when looking for free slots.
    const own = new Date(a.starts_at).getTime();
    const busy = data.busy.filter((b) => new Date(b.starts_at).getTime() !== own);
    return availableSlots(day, Number(duration) || a.duration_min, { ...s, hours: data.hours }, busy, new Date(), { ignoreNotice: true });
  }, [data, day, duration, a, s]);
  const { busy, error, run, setError } = useAction();
  async function save() {
    const mins = Number(duration);
    if (!mins || mins < 5) return setError(new Error('Check the length.'));
    const starts = zonedToInstant(day, time, tz);
    if (await run(() => api.updateAppointment(a.id, { starts_at: starts.toISOString(), duration_min: mins }))) onDone();
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
        <p className="sub">The client isn’t told automatically — send them a WhatsApp or re-send the confirmation email afterwards.</p>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save new time'}</button>
      </div>
    </Sheet>
  );
}

function CancelSheet({ a, onClose, onDone }: { a: Appointment; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(!!a.client?.email);
  const { busy, error, run } = useAction();
  return (
    <Sheet title="Cancel appointment" onClose={onClose}>
      <div className="stack">
        <Field label="Reason (optional)" hint={notify ? 'Included in the email to the client.' : undefined}>
          <input type="text" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} />
        </Field>
        {a.client?.email && (
          <label className="check"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>Email the client to let them know</span></label>
        )}
        {a.deposit_paid_at && <div className="notice warn">A {money(a.deposit_required_pence)} deposit was paid. If you’re refunding it, add a refund in Money.</div>}
        <ErrorBox error={error} />
        <button className="btn danger solid block" disabled={busy}
          onClick={async () => { if (await run(() => api.cancelAppointment(a.id, reason.trim() || null, notify))) onDone(); }}>
          {busy ? 'Cancelling…' : 'Cancel appointment'}
        </button>
      </div>
    </Sheet>
  );
}
