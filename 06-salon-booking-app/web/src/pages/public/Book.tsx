import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ConsultationFields } from '../../components/ConsultationFields';
import { SlotPicker, useFreeSlots } from '../../components/SlotPicker';
import { useClientManifest } from '../../components/clientManifest';
import { ErrorBox, Field, Icon, Spinner, useAction, useLoad } from '../../components/ui';
import { blankAnswers, validateAnswers } from '../../lib/consultation';
import { openDays } from '../../lib/slots';
import { addDays, fmtDayLong, fmtTime, minutesLabel, startOfDayInstant } from '../../lib/time';
import { friendlyError, isPlausibleEmail, isPlausiblePhone, money } from '../../lib/text';
import type { BookingInfo, BusyRange } from '../../lib/types';

type Step = 'service' | 'time' | 'details' | 'done';

export function Book() {
  useClientManifest();
  const { data: info, error, loading } = useLoad(() => api.getBookingInfo(), []);
  useEffect(() => { if (info) document.title = `Book · ${info.business_name}`; }, [info]);
  if (loading) return <Spinner />;
  if (!info) return <div className="page page-public"><ErrorBox error={error ?? new Error('Booking is not available right now.')} /></div>;
  if (!info.booking_enabled) {
    return (
      <div className="page page-public stack">
        <div className="hero"><h1>{info.business_name}</h1></div>
        <div className="notice">Online booking is paused at the moment. Please get in touch directly to book.</div>
      </div>
    );
  }
  return <BookingFlow info={info} />;
}

function BookingFlow({ info }: { info: BookingInfo }) {
  const tz = info.timezone;
  const [step, setStep] = useState<Step>('service');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [day, setDay] = useState<string | null>(null);
  const [slot, setSlot] = useState<Date | null>(null);
  const [details, setDetails] = useState({ full_name: '', email: '', phone: '', notes: '' });
  const [firstVisit, setFirstVisit] = useState<boolean | null>(null);
  const [answers, setAnswers] = useState(blankAnswers);
  const [consent, setConsent] = useState(false);
  const [signedName, setSignedName] = useState('');
  const [website, setWebsite] = useState(''); // honeypot: real people never see or fill this
  const [ageOk, setAgeOk] = useState(false);
  const [policyOk, setPolicyOk] = useState(false);
  const policy = info.cancellation_policy?.trim() || null;
  const [result, setResult] = useState<{ reference: string; starts_at: string } | null>(null);
  const { busy, error, run, setError } = useAction();
  const topRef = useRef<HTMLDivElement>(null);

  const service = info.services.find((s) => s.id === serviceId);
  const days = useMemo(() => openDays(info), [info]);
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  const { data: busyTimes, error: busyError, reload: reloadBusy } = useLoad<BusyRange[]>(
    () => (firstDay ? api.getBusyTimes(startOfDayInstant(firstDay, tz), startOfDayInstant(addDays(lastDay, 1), tz)) : Promise.resolve([])),
    [firstDay, lastDay]);

  const { slotsByDay, daysWithSlots } = useFreeSlots(info, days, service?.duration_min ?? null, busyTimes);

  useEffect(() => {
    if (step === 'time' && service && (!day || !slotsByDay.get(day)?.length)) setDay(daysWithSlots[0] ?? null);
  }, [step, service, slotsByDay, day, daysWithSlots]);
  useEffect(() => { topRef.current?.scrollIntoView({ block: 'start' }); window.scrollTo(0, 0); }, [step]);

  async function submit() {
    setError(null);
    if (website) return setError(new Error('booking_failed')); // a bot filled the hidden field
    if (details.full_name.trim().length < 2) return setError(new Error('invalid_name'));
    if (!isPlausibleEmail(details.email)) return setError(new Error('invalid_email'));
    if (!isPlausiblePhone(details.phone)) return setError(new Error('invalid_phone'));
    if (firstVisit === null) return setError(new Error('Please tell us whether this is your first visit.'));
    if (firstVisit) {
      const problem = validateAnswers(answers);
      if (problem) return setError(new Error(problem));
      if (!consent) return setError(new Error('consent_required'));
      if (signedName.trim().length < 2) return setError(new Error('signature_required'));
    }
    if (!ageOk) return setError(new Error('Please confirm you are 16 or over, or that a parent or guardian is booking for you.'));
    if (policy && !policyOk) return setError(new Error('policy_required'));
    const ok = await run(async () => {
      setResult(await api.createBooking({
        service_id: service!.id, starts_at: slot!.toISOString(), full_name: details.full_name.trim(),
        email: details.email.trim(), phone: details.phone.trim(), notes: details.notes.trim() || null,
        consultation: firstVisit ? answers : null, health_consent: firstVisit ? consent : false,
        signed_name: firstVisit ? signedName.trim() : null,
        policy_accepted: !!policy && policyOk,
      }));
    });
    if (ok) setStep('done');
    else reloadBusy(); // the slot may have just gone; refresh what's free
  }

  const stepIndex = { service: 0, time: 1, details: 2, done: 3 }[step];

  return (
    <>
    {api.mode === 'demo' && <div className="demo-banner">Demo — bookings here aren’t real and go nowhere</div>}
    <div className="page page-public stack" ref={topRef}>
      <div className="hero">
        <h1>{info.business_name}</h1>
        {info.booking_intro && step === 'service' && <p>{info.booking_intro}</p>}
        {info.location_note && <p className="sub">{info.location_note}</p>}
      </div>
      {step !== 'done' && <div className="steps" aria-hidden>{[0, 1, 2].map((i) => <span key={i} className={i <= stepIndex ? 'on' : ''} />)}</div>}

      {step === 'service' && policy && (
        <div className="card policy" role="note" aria-label="Cancellation policy">
          <h2>Cancellation policy</h2>
          <p style={{ whiteSpace: 'pre-wrap' }}>{policy}</p>
        </div>
      )}

      {step === 'service' && (
        <>
          <h2>Choose a treatment</h2>
          {info.services.length === 0 && <div className="notice">No treatments are bookable online yet.</div>}
          {info.services.map((s) => (
            <button key={s.id} className={`service${serviceId === s.id ? ' on' : ''}`} onClick={() => { setServiceId(s.id); setSlot(null); setStep('time'); }}>
              <div className="grow">
                <div style={{ fontWeight: 600 }}>{s.name}</div>
                <div className="sub">{minutesLabel(s.duration_min)}{s.description ? ` · ${s.description}` : ''}</div>
              </div>
              <div className="price">{money(s.price_pence)}</div>
              <span className="chev"><Icon name="chev" size={18} /></span>
            </button>
          ))}
        </>
      )}

      {step === 'time' && service && (
        <>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setStep('service')}><Icon name="back" size={18} /> {service.name}</button>
          <h2>Pick a day and time</h2>
          <ErrorBox error={busyError} />
          {!busyTimes ? <Spinner /> : daysWithSlots.length === 0 ? (
            <div className="notice">Sorry — there are no free times in the next {info.max_days_ahead} days. Please get in touch directly.</div>
          ) : (
            <>
              <SlotPicker days={daysWithSlots} slotsByDay={slotsByDay} day={day} slot={slot} tz={tz}
                onDay={(d) => { setDay(d); setSlot(null); }} onSlot={setSlot} />
              <button className="btn primary block" disabled={!slot} onClick={() => setStep('details')}>Continue</button>
            </>
          )}
        </>
      )}

      {step === 'details' && service && slot && (
        <>
          <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => setStep('time')}><Icon name="back" size={18} /> Change time</button>
          <div className="card">
            <div style={{ fontWeight: 600 }}>{service.name} · {money(service.price_pence)}</div>
            <div className="sub">{fmtDayLong(slot, tz)} at {fmtTime(slot, tz)} ({minutesLabel(service.duration_min)})</div>
          </div>
          <h2>Your details</h2>
          <Field label="Full name"><input type="text" autoComplete="name" value={details.full_name} maxLength={100} onChange={(e) => setDetails({ ...details, full_name: e.target.value })} /></Field>
          <Field label="Email" hint="Your confirmation is sent here."><input type="email" autoComplete="email" value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} /></Field>
          <Field label="Mobile"><input type="tel" autoComplete="tel" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></Field>
          <Field label="Anything to add? (optional)" hint="e.g. colour ideas, or if you need a removal">
            <textarea value={details.notes} maxLength={1000} onChange={(e) => setDetails({ ...details, notes: e.target.value })} />
          </Field>
          <div className="visually-hidden" aria-hidden>
            <label>Website<input type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
          </div>
          <fieldset className="field">
            <legend style={{ marginBottom: 6 }}>Is this your first visit?</legend>
            <div className="seg" role="radiogroup" aria-label="Is this your first visit?">
              <button type="button" role="radio" aria-checked={firstVisit === true} className={firstVisit === true ? 'on' : ''} onClick={() => setFirstVisit(true)}>Yes, first time</button>
              <button type="button" role="radio" aria-checked={firstVisit === false} className={firstVisit === false ? 'on' : ''} onClick={() => setFirstVisit(false)}>I’ve been before</button>
            </div>
          </fieldset>
          {firstVisit && (
            <div className="card stack">
              <h3>Quick health check</h3>
              <p className="sub">So your treatment is safe for you. Only {info.business_name} sees your answers.</p>
              <ConsultationFields answers={answers} onChange={setAnswers} consent={consent} onConsent={setConsent}
                signedName={signedName} onSignedName={setSignedName} businessName={info.business_name} />
            </div>
          )}
          {info.deposit_amount_pence > 0 && (
            <div className="notice">
              New clients pay a {money(info.deposit_amount_pence)} deposit by bank transfer to secure their appointment. If this applies to you, the bank details are in your confirmation email — please pay within {info.deposit_deadline_hours} hours. The deposit comes off your bill.
            </div>
          )}
          {policy && (
            <div className="card policy stack" style={{ gap: 4 }}>
              <h3>Cancellation policy</h3>
              <p style={{ whiteSpace: 'pre-wrap' }}>{policy}</p>
              <label className="check">
                <input type="checkbox" checked={policyOk} onChange={(e) => setPolicyOk(e.target.checked)} />
                <span>I’ve read and agree to the cancellation policy.</span>
              </label>
            </div>
          )}
          <label className="check">
            <input type="checkbox" checked={ageOk} onChange={(e) => setAgeOk(e.target.checked)} />
            <span>I’m 16 or over, or I’m a parent or guardian booking for my child.</span>
          </label>
          <ErrorBox error={error ? new Error(friendlyError(error)) : null} />
          <button className="btn primary block" disabled={busy} onClick={submit}>{busy ? 'Booking…' : 'Confirm booking'}</button>
          <p className="sub centre">How your information is used: <Link to="/privacy">privacy notice</Link>.</p>
        </>
      )}

      {step === 'done' && result && service && (
        <div className="stack centre">
          <svg className="big-tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <circle cx="12" cy="12" r="10" /><path d="M7 12.5l3.2 3.2L17 9" />
          </svg>
          <h2>Booking received — thank you!</h2>
          <div className="card" style={{ textAlign: 'left' }}>
            <div style={{ fontWeight: 600 }}>{service.name}</div>
            <div className="sub">{fmtDayLong(result.starts_at, tz)} at {fmtTime(result.starts_at, tz)}</div>
            <div className="sub">Reference <b className="mono">{result.reference}</b></div>
          </div>
          <p>A confirmation is on its way to <b>{details.email.trim()}</b> (check your junk folder). {info.deposit_amount_pence > 0 && 'If you’re a new client, it has the bank details for your deposit — use your reference so it can be matched.'}</p>
          <p className="sub">Need to change or cancel? Use the link in your confirmation email.</p>
          <button className="btn" onClick={() => window.location.reload()}>Book another appointment</button>
        </div>
      )}
    </div>
    </>
  );
}
