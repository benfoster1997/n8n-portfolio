import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { SlotPicker, useFreeSlots } from '../../components/SlotPicker';
import { ErrorBox, Field, Icon, Sheet, Spinner, useAction, useLoad } from '../../components/ui';
import { openDays } from '../../lib/slots';
import { addDays, dateInZone, fmtDay, fmtDayLong, fmtTime, minutesLabel, startOfDayInstant } from '../../lib/time';
import { lateFromEarlierChange, money, normalizeUkPhone, whatsappLink } from '../../lib/text';
import type { ApptStatus, BookingChangeResult, BusyRange, ManageInfo } from '../../lib/types';
import { useClientManifest } from '../../components/clientManifest';

const STATUS: Record<ApptStatus, { label: string; cls: string }> = {
  confirmed: { label: 'Confirmed', cls: 'ok' },
  pending_deposit: { label: 'Waiting for your deposit', cls: 'warn' },
  cancelled: { label: 'Cancelled', cls: 'danger' },
  completed: { label: 'Completed', cls: '' },
  no_show: { label: 'Missed', cls: 'danger' },
};

type Mode = 'view' | 'service' | 'time' | 'confirm' | 'done';
/** The treatment being changed to. id null = keep the current one (and the price it was booked at). */
interface Choice { id: string | null; name: string; duration_min: number; price_pence: number }

const hours = (n: number) => `${n} hour${n === 1 ? '' : 's'}`;
/** "less than 48 hours’ notice" */
const shortNotice = (n: number) => (n > 0 ? `less than ${n} hour${n === 1 ? '’s' : 's’'} notice` : 'short notice');

/**
 * The time now, kept fresh while `on`: every 30 seconds, when the page is shown again, and just
 * after `at` (when the notice period starts), so a warning appears without them reloading.
 */
function useNow(on: boolean, at: string | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const tick = () => setNow(Date.now());
    tick();
    const every = window.setInterval(tick, 30e3);
    // A timer can't wait more than about 24 days; the interval covers anything further off.
    const wait = at ? new Date(at).getTime() - Date.now() + 100 : -1;
    const once = wait > 0 && wait < 2 ** 31 - 1 ? window.setTimeout(tick, wait) : undefined;
    document.addEventListener('visibilitychange', tick);
    return () => { window.clearInterval(every); window.clearTimeout(once); document.removeEventListener('visibilitychange', tick); };
  }, [on, at]);
  return now;
}

/** A client's own page for their booking, from the private link in their emails: move it, switch treatment or cancel. */
export function Manage() {
  useClientManifest();
  const { token = '' } = useParams();
  const valid = /^[0-9a-f-]{36}$/i.test(token);
  const { data, error, loading, reload, setData } = useLoad(() => (valid ? api.getManagedBooking(token) : Promise.resolve(null)), [token]);
  useEffect(() => { if (data) document.title = `Your booking · ${data.info.business_name}`; }, [data]);

  if (loading && !data) return <Spinner />;
  if (!data) {
    return (
      <div className="page page-public stack">
        <h1>Your booking</h1>
        {error ? <ErrorBox error={error} /> : <div className="notice">This link has expired or isn’t valid. Please use the link in your latest email, or get in touch.</div>}
        <Link className="btn" to="/book">Book an appointment</Link>
      </div>
    );
  }
  return <ManageBooking m={data} token={token} reload={reload} setData={setData} />;
}

function ManageBooking({ m, token, reload, setData }: {
  m: ManageInfo; token: string; reload: () => void; setData: (m: ManageInfo) => void;
}) {
  const { info, booking: b } = m;
  const tz = info.timezone;
  const business = info.business_name;
  const policy = info.cancellation_policy?.trim() || null;
  const notice = m.cancel_notice_hours;
  const [mode, setMode] = useState<Mode>('view');
  const [choice, setChoice] = useState<Choice | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<Date | null>(null);
  const [result, setResult] = useState<BookingChangeResult | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const change = useAction();
  const cancel = useAction();

  const startMs = new Date(b.starts_at).getTime();
  const live = b.status === 'pending_deposit' || b.status === 'confirmed';
  // Ticks while the booking can still be changed, so a sheet or step left open notices the deadline passing.
  const now = useNow(live, b.free_until);
  const upcoming = live && startMs > now;
  // Inside the notice period: the deadline has passed, or they've already changed it inside the
  // period (which keeps the policy in force). Cancelling, or changing it again, then falls under the policy.
  // With no notice period the policy is off, whatever happened before.
  const pastDeadline = !!b.free_until && now > new Date(b.free_until).getTime();
  const late = notice > 0 && (pastDeadline || b.late_fee_pence != null);
  // Payable if they cancel: the full price, or the price before a late change if that was higher.
  const fee = Math.max(b.late_fee_pence ?? 0, b.price_pence);
  const canCancel = upcoming && m.client_self_service;
  const canChange = canCancel && b.changes_left > 0 && info.booking_enabled;
  const current: Choice = { id: b.service_id, name: b.service_name, duration_min: b.duration_min, price_pence: b.price_pence };
  const currentListed = info.services.some((s) => s.id === b.service_id);

  // Free times, loaded each time the change flow opens. The client's own booking doesn't block them.
  const inFlow = mode === 'service' || mode === 'time' || mode === 'confirm';
  const days = useMemo(() => openDays(info), [info]);
  const firstDay = days[0];
  const lastDay = days[days.length - 1];
  const { data: busyTimes, error: busyError, reload: reloadBusy } = useLoad<BusyRange[] | undefined>(
    () => (!inFlow ? Promise.resolve(undefined) : firstDay
      ? api.getBusyTimesExcept(token, startOfDayInstant(firstDay, tz), startOfDayInstant(addDays(lastDay, 1), tz))
      : Promise.resolve([])),
    [inFlow, firstDay, lastDay]);
  const { slotsByDay, daysWithSlots } = useFreeSlots(info, days, choice?.duration_min ?? null, busyTimes);

  const moved = !!slot && slot.getTime() !== startMs;
  const switched = !!choice && choice.id !== b.service_id;
  // The new time is itself inside the notice period (moving from outside it into it).
  const newInside = !!slot && notice > 0 && slot.getTime() - notice * 3600e3 < now;
  // Payable if they cancel after this change: a late change keeps the price before it in force.
  const feeAfter = Math.max(b.late_fee_pence ?? 0, pastDeadline ? b.price_pence : 0, choice?.price_pence ?? 0);

  // Start on the current day and time when they're still free for the chosen treatment.
  useEffect(() => {
    if (mode !== 'time' || !choice || !busyTimes) return;
    if (day && slotsByDay.get(day)?.length) return;
    const curDay = dateInZone(b.starts_at, tz);
    const cur = slotsByDay.get(curDay)?.find((d) => d.getTime() === startMs) ?? null;
    setDay(cur ? curDay : daysWithSlots[0] ?? null);
    setSlot(cur);
  }, [mode, choice, busyTimes, day, slotsByDay, daysWithSlots, b.starts_at, tz, startMs]);

  // Each step starts at the top with focus on its heading, so keyboard and VoiceOver users start
  // there too; after cancelling, focus goes to the "cancelled" notice.
  const focusNext = useRef(false);
  const focusTarget = useRef<HTMLElement | null>(null);
  const focusHere = useCallback((el: HTMLElement | null) => { focusTarget.current = el; }, []);
  useEffect(() => {
    if (!focusNext.current) return;
    focusNext.current = false;
    window.scrollTo(0, 0);
    focusTarget.current?.focus({ preventScroll: true });
  });
  function go(next: Mode) {
    focusNext.current = true;
    setMode(next);
  }

  function startChange() {
    change.setError(null);
    setChoice(null);
    go('service');
  }
  function choose(c: Choice) {
    setChoice(c);
    setDay(null);
    setSlot(null);
    change.setError(null);
    go('time');
  }

  async function confirmChange() {
    if (!choice || !slot) return;
    const ok = await change.run(async () => {
      let r: BookingChangeResult;
      try {
        r = await api.changeBooking(token, { service_id: switched ? choice.id : null, starts_at: moved ? slot.toISOString() : null });
      } catch (e) {
        // The time may have just gone: refresh what's free and go back to pick another.
        reloadBusy();
        if (/slot_taken|too_soon/.test(e instanceof Error ? e.message : '')) { setSlot(null); go('time'); }
        throw e;
      }
      setResult(r);
      // Show the new details straight away, and keep them if the refresh below doesn't get through.
      const start = new Date(r.starts_at).getTime();
      setData({ ...m, booking: {
        ...b,
        starts_at: r.starts_at,
        ends_at: new Date(start + choice.duration_min * 60e3).toISOString(),
        service_id: choice.id, service_name: r.service_name, price_pence: r.price_pence, duration_min: choice.duration_min,
        changes_left: Math.max(0, b.changes_left - 1),
        free_until: notice > 0 ? new Date(start - notice * 3600e3).toISOString() : null,
        late_fee_pence: r.late ? Math.max(b.late_fee_pence ?? 0, b.price_pence) : b.late_fee_pence,
        deposit_due_at: b.deposit_due_at && new Date(b.deposit_due_at).getTime() > start ? r.starts_at : b.deposit_due_at,
      } });
    });
    reload();
    if (ok) go('done');
  }

  async function confirmCancel() {
    const ok = await cancel.run(async () => {
      const r = await api.cancelBooking(token, reason.trim() || null);
      setData({ ...m, booking: { ...b, status: 'cancelled', cancelled_at: new Date().toISOString(), cancelled_by: 'client',
        cancelled_late: r.late, late_fee_pence: r.late ? fee : null } });
    });
    if (ok) { focusNext.current = true; setCancelling(false); }
    reload();
  }
  const closeCancel = () => { setCancelling(false); cancel.setError(null); };

  const when = (iso: string | Date) => `${fmtDayLong(iso, tz)} at ${fmtTime(iso, tz)}`;
  const stepIndex = ['service', 'time', 'confirm'].indexOf(mode);
  const status = STATUS[b.status];
  // A late cancellation made in good time, late only because of an earlier change inside the notice
  // period. The same test whoever cancelled, so the client and owner wording agree.
  const fromChange = lateFromEarlierChange(b, notice);

  return (
    <>
    {api.mode === 'demo' && <div className="demo-banner">Demo — bookings here aren’t real and go nowhere</div>}
    <div className="page page-public stack manage">
      <div className="hero">
        <h1>{business}</h1>
        {mode === 'view' && <p>Hi {b.first_name || 'there'}, here’s your booking</p>}
      </div>

      {mode === 'view' && (
        <>
          <div className="card stack">
            <div className="row spread booking-head">
              <h2 className="grow" tabIndex={-1} ref={b.status === 'cancelled' ? undefined : focusHere}>{b.service_name}</h2>
              <span className={`chip ${status.cls}`}>{status.label}</span>
            </div>
            <dl className="kv">
              <dt>When</dt><dd>{when(b.starts_at)}</dd>
              <dt>Length</dt><dd>{minutesLabel(b.duration_min)}</dd>
              <dt>Price</dt><dd>{money(b.price_pence)}</dd>
              <dt>Reference</dt><dd className="mono">{b.reference}</dd>
            </dl>
          </div>

          {upcoming && b.status === 'pending_deposit' && !b.deposit_paid && b.deposit_required_pence > 0 && (
            <DepositCard m={m} />
          )}

          {upcoming && b.form_needed && (
            <div className="notice stack" style={{ gap: 8 }}>
              <span>As it’s your first visit, please fill in the quick health form before your appointment. It takes about 2 minutes.</span>
              <Link className="btn small" style={{ alignSelf: 'flex-start' }} to={`/form/${token}`}>Fill in the health form</Link>
            </div>
          )}

          {upcoming && (
            <div className={`card policy stack${late ? ' late' : ''}`} style={{ gap: 4 }} role="note" aria-label="Cancellation policy">
              <h2>Cancellation policy</h2>
              {pastDeadline ? (
                <p>
                  It’s now less than {hours(notice)} before your appointment, so under the policy the full price ({money(fee)}) is payable if you cancel.
                  {canChange ? ' You can still move it, but that’s also inside the notice period.'
                    : ' To move it, please get in touch — that’s also inside the notice period.'}
                </p>
              ) : late ? (
                <p>Just so you know: as this booking was changed with {shortNotice(notice)}, the cancellation policy applies if you cancel it, and the full price ({money(fee)}) would be payable.</p>
              ) : !b.free_until ? <p>You can change or cancel free of charge any time before your appointment.</p>
                : <p>You can change or cancel free of charge until <b>{fmtDay(b.free_until, tz)} at {fmtTime(b.free_until, tz)}</b>.</p>}
              {policy && <p className="sub" style={{ whiteSpace: 'pre-wrap' }}>{policy}</p>}
            </div>
          )}

          {upcoming && !canChange && (
            <GetInTouch m={m}>
              {!m.client_self_service ? 'To change or cancel this appointment, please get in touch.'
                : b.changes_left <= 0 ? 'This booking has already been changed online a few times, so to change it again please get in touch.'
                : 'Online booking is paused at the moment, so to move your appointment or switch treatment please get in touch.'}
            </GetInTouch>
          )}

          {canCancel && (
            <div className="stack">
              {canChange && <button className="btn primary block" onClick={startChange}>Change time or treatment</button>}
              <button className="btn danger block" onClick={() => setCancelling(true)}>Cancel appointment</button>
              {canChange && b.changes_left <= 2 && (
                <p className="sub centre">You can change this booking online {b.changes_left === 1 ? 'once' : 'twice'} more.</p>
              )}
            </div>
          )}

          {b.status === 'cancelled' && (
            <div className="notice stack" style={{ gap: 6 }} role="status" tabIndex={-1} ref={focusHere}>
              <b>This appointment has been cancelled.</b>
              {b.cancelled_late && (b.cancelled_by === 'client' ? (
                <span>
                  {fromChange ? `As it had been changed with ${shortNotice(notice)}`
                    : `As it was cancelled ${notice > 0 ? `less than ${hours(notice)} before the appointment` : 'at short notice'}`},
                  under the cancellation policy the full price ({money(fee)}) may be payable. {business} will be in touch.
                </span>
              ) : (
                // Cancelled by the owner and marked late: the same words as the client's email.
                <span>
                  {fromChange ? `As it had been changed with ${shortNotice(notice)}`
                    : `As this was cancelled ${notice > 0 ? `less than ${hours(notice)} before the appointment` : 'at short notice'}`}, the
                  cancellation policy applies — {business} will be in touch.
                </span>
              ))}
            </div>
          )}
          {live && !upcoming && <div className="notice">This appointment has already started, so it can no longer be changed online.</div>}
          {(b.status === 'completed' || b.status === 'no_show') && <div className="notice">This appointment has passed, so it can no longer be changed online.</div>}
          {!upcoming && <Link className="btn" to="/book">Book another appointment</Link>}
        </>
      )}

      {inFlow && <div className="steps" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className={i <= stepIndex ? 'on' : ''} />)}</div>}

      {mode === 'service' && (
        <>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => go('view')}><Icon name="back" size={18} /> Your booking</button>
          <h2 tabIndex={-1} ref={focusHere}>Choose a treatment</h2>
          <p className="sub">To just move the time, choose your current treatment.</p>
          {!currentListed && <TreatmentButton c={current} on={!choice || choice.id === current.id} current onClick={() => choose(current)} />}
          {info.services.map((s) => (s.id === b.service_id
            ? <TreatmentButton key={s.id} c={current} description={s.description} on={!choice || choice.id === s.id} current onClick={() => choose(current)} />
            : <TreatmentButton key={s.id} c={s} description={s.description} on={choice?.id === s.id} onClick={() => choose(s)} />))}
        </>
      )}

      {mode === 'time' && choice && (
        <>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => go('service')}><Icon name="back" size={18} /> {choice.name}</button>
          <h2 tabIndex={-1} ref={focusHere}>Pick a day and time</h2>
          <p className="sub">Your appointment is now {fmtDay(b.starts_at, tz)} at {fmtTime(b.starts_at, tz)}.</p>
          <ErrorBox error={busyError ?? change.error} />
          {busyError ? null : !busyTimes ? <Spinner /> : daysWithSlots.length === 0 ? (
            <div className="notice">Sorry — there are no free times for this treatment in the next {info.max_days_ahead} days. Please get in touch directly.</div>
          ) : (
            <>
              <SlotPicker days={daysWithSlots} slotsByDay={slotsByDay} day={day} slot={slot} tz={tz}
                onDay={(d) => { setDay(d); setSlot(null); }} onSlot={(d) => { setSlot(d); change.setError(null); }} />
              {slot && !moved && (
                <p className="sub">{switched ? 'Your current time is still free for this treatment.' : 'That’s your current time — pick a new one, or go back to choose a different treatment.'}</p>
              )}
              <button className="btn primary block" disabled={!slot || (!moved && !switched)} onClick={() => go('confirm')}>Continue</button>
            </>
          )}
        </>
      )}

      {mode === 'confirm' && choice && slot && (
        <>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => go('time')}><Icon name="back" size={18} /> Change time</button>
          <h2 tabIndex={-1} ref={focusHere}>Check your new booking</h2>
          <div className="card compare">
            <div className="was">
              <span className="label">From</span>
              <b>{b.service_name}</b>
              <span>{when(b.starts_at)}</span>
              <span className="sub">{minutesLabel(b.duration_min)} · {money(b.price_pence)}</span>
            </div>
            <div className="to">
              <span className="label">To</span>
              <b className={switched ? 'changed' : ''}>{choice.name}</b>
              <span className={moved ? 'changed' : ''}>{when(slot)}</span>
              <span className="sub">{minutesLabel(choice.duration_min)} · <span className={choice.price_pence !== b.price_pence ? 'changed' : ''}>{money(choice.price_pence)}</span></span>
            </div>
          </div>
          {late ? (
            // Any change inside the notice period (a move or a switch) keeps the policy in force.
            <div className="notice warn stack" style={{ gap: 6 }} role="note" aria-label="Changing inside the notice period">
              <span>
                {pastDeadline ? `As it’s less than ${hours(notice)} before your appointment, this change falls under the cancellation policy`
                  : `As this booking was already changed with ${shortNotice(notice)}, the cancellation policy still applies`}:
                if you cancel after this, the full price ({money(feeAfter)}) is payable.
              </span>
              {policy && <span style={{ whiteSpace: 'pre-wrap' }}>{policy}</span>}
            </div>
          ) : moved && newInside && (
            <div className="notice warn" role="note" aria-label="Your new time is inside the notice period">
              Your new time is less than {hours(notice)} away, so if you need to cancel or move it after this, the full price
              ({money(choice.price_pence)}) is payable under the cancellation policy.
            </div>
          )}
          <ErrorBox error={change.error} />
          <button className="btn primary block" disabled={change.busy} onClick={confirmChange}>{change.busy ? 'Saving…' : 'Confirm change'}</button>
          <button className="btn ghost block" onClick={() => go('view')}>Keep my booking as it is</button>
        </>
      )}

      {mode === 'done' && result && (
        <div className="stack centre">
          <svg className="big-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M7 12.5l3.2 3.2L17 9" />
          </svg>
          <h2 tabIndex={-1} ref={focusHere}>Your booking has been changed</h2>
          <div className="card" style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600 }}>{result.service_name} · {money(result.price_pence)}</div>
            <div className="sub">{when(result.starts_at)}</div>
            <div className="sub">Reference <b className="mono">{result.reference}</b></div>
          </div>
          {b.has_email && <p>We’ve emailed you the new details.</p>}
          <button className="btn" onClick={() => go('view')}>Back to my booking</button>
        </div>
      )}

      <p className="sub centre">How your information is used: <Link to="/privacy">privacy notice</Link>.</p>
    </div>

    {cancelling && (
      <Sheet title="Cancel your appointment?" onClose={closeCancel}>
        <div className="stack">
          <p>{b.service_name} on {when(b.starts_at)}.</p>
          {late && (
            <div className="notice warn" role="note">
              {pastDeadline ? `As it’s less than ${hours(notice)} before your appointment` : `As this booking was changed with ${shortNotice(notice)}`},
              under the cancellation policy the full price ({money(fee)}) is payable if you cancel. {business} will be in touch about it.
            </div>
          )}
          <Field label="Reason (optional)" hint={`Only ${business} sees this.`}>
            <textarea value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorBox error={cancel.error} />
          <button className="btn danger solid block" disabled={cancel.busy} onClick={confirmCancel}>
            {cancel.busy ? 'Cancelling…' : 'Yes, cancel my appointment'}
          </button>
          <button className="btn block" onClick={closeCancel}>Keep my appointment</button>
        </div>
      </Sheet>
    )}
    </>
  );
}


function TreatmentButton({ c, description, on, current, onClick }: {
  c: Pick<Choice, 'name' | 'duration_min' | 'price_pence'>; description?: string | null; on: boolean; current?: boolean; onClick: () => void;
}) {
  return (
    <button className={`service${on ? ' on' : ''}`} onClick={onClick}>
      <div className="grow">
        {current && <span className="chip accent">Your current treatment</span>}
        <div style={{ fontWeight: 600 }}>{c.name}</div>
        <div className="sub">{minutesLabel(c.duration_min)}{description ? ` · ${description}` : ''}</div>
      </div>
      <div className="price">{money(c.price_pence)}</div>
      <span className="chev"><Icon name="chev" size={18} /></span>
    </button>
  );
}

function DepositCard({ m }: { m: ManageInfo }) {
  const { booking: b, bank, info } = m;
  const tz = info.timezone;
  const due = b.deposit_due_at;
  const overdue = !!due && new Date(due).getTime() < Date.now();
  const hasBank = !!(bank && (bank.account_name || bank.sort_code || bank.account_number));
  return (
    <div className="card attention stack" style={{ gap: 8 }}>
      <h2>Your deposit</h2>
      <p>
        To secure your appointment, please send your {money(b.deposit_required_pence)} deposit by bank transfer
        {due && !overdue && <> by <b>{fmtDay(due, tz)} at {fmtTime(due, tz)}</b></>}.
        {overdue && ' It’s now overdue, so please send it as soon as you can, or get in touch.'} It comes off your bill.
      </p>
      {hasBank ? (
        <dl className="kv">
          {bank!.account_name && <><dt>Name</dt><dd>{bank!.account_name}</dd></>}
          {bank!.sort_code && <><dt>Sort code</dt><dd className="mono">{bank!.sort_code}</dd></>}
          {bank!.account_number && <><dt>Account</dt><dd className="mono">{bank!.account_number}</dd></>}
          <dt>Reference</dt><dd className="mono">{b.reference}</dd>
        </dl>
      ) : <p>The bank details are in your confirmation email.</p>}
      <p className="sub">Please use reference <b className="mono">{b.reference}</b> so your payment can be matched to your booking.</p>
    </div>
  );
}

function GetInTouch({ m, children }: { m: ManageInfo; children: ReactNode }) {
  const { info, booking: b } = m;
  const phone = normalizeUkPhone(m.contact_phone);
  const email = info.contact_email?.trim();
  const about = `my booking on ${fmtDay(b.starts_at, info.timezone)} at ${fmtTime(b.starts_at, info.timezone)} (ref ${b.reference})`;
  return (
    <div className="card stack">
      <p>{children}</p>
      {phone || email ? (
        <div className="btn-row">
          {phone && (
            <a className="btn wa" href={whatsappLink(phone, `Hi, it’s ${b.first_name || 'me'} — about ${about}: `)} target="_blank" rel="noreferrer">
              <Icon name="whatsapp" size={20} /> WhatsApp
            </a>
          )}
          {phone && <a className="btn" href={`tel:+${phone}`}><Icon name="phone" size={20} /> Call</a>}
          {email && <a className="btn" href={`mailto:${email}?subject=${encodeURIComponent(`Booking ${b.reference}`)}`}><Icon name="mail" size={20} /> Email</a>}
        </div>
      ) : <p className="sub">Reply to your confirmation email and {info.business_name} will get back to you.</p>}
    </div>
  );
}
