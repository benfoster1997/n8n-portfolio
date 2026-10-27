import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ConsultationFields } from '../../components/ConsultationFields';
import { SlotPicker, useFreeSlots } from '../../components/SlotPicker';
import { useClientManifest } from '../../components/clientManifest';
import { Badge, BrandFooter, BrandHero, Heart, ScriptTitle } from '../../components/brand';
import { AddOnsMenu, InfoBadges, TreatmentMenu, TreatmentRow } from '../../components/public/menu';
import {
  Celebration, ChosenTreatment, GroupHead, GroupIcon, PolicyCard, PublicLoading, PublicProblem, RefStub, StickyAction, Steps, Ticket,
} from '../../components/public/parts';
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
  if (loading) return <PublicLoading />;
  if (!info) {
    return (
      <PublicProblem title="Booking">
        <ErrorBox error={error ?? new Error('Booking is not available right now.')} />
        <button className="btn primary block" onClick={() => window.location.reload()}>Try again</button>
      </PublicProblem>
    );
  }
  if (!info.booking_enabled) {
    return (
      <>
      {api.mode === 'demo' && <div className="demo-banner">Demo — bookings here aren’t real and go nowhere</div>}
      <div className="page page-public stack book">
        <BrandHero name={info.business_name} tagline={info.tagline} strapline={info.strapline} location={info.location_note} />
        <Badge icon="clock" title="Booking paused" titleAs="h2" className="book-paused">
          <p>Online booking is paused at the moment. Please get in touch directly to book.</p>
        </Badge>
        <InfoBadges safety={info.safety_note} />
        <BrandFooter instagram={info.instagram_handle} tiktok={info.tiktok_handle} facebook={info.facebook_handle} />
      </div>
      </>
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
  const socials = { instagram: info.instagram_handle, tiktok: info.tiktok_handle, facebook: info.facebook_handle };

  return (
    <>
    {api.mode === 'demo' && <div className="demo-banner">Demo — bookings here aren’t real and go nowhere</div>}
    <div className={`page page-public stack book book--${step}`} ref={topRef}>
      <BrandHero name={info.business_name} compact={step !== 'service'}
        tagline={step === 'service' || step === 'done' ? info.tagline : null}
        strapline={step === 'service' ? info.strapline : null}
        intro={step === 'service' ? info.booking_intro : null}
        location={step === 'service' ? info.location_note : null} />
      {step !== 'done' && <Steps labels={['Treatment', 'Time', 'Details']} current={stepIndex} />}

      {step === 'service' && policy && (
        <PolicyCard note>
          <p className="policy-text">{policy}</p>
        </PolicyCard>
      )}

      {step === 'service' && (
        <>
          <TreatmentMenu hint={info.services.length > 0 ? 'Tap a treatment to see the free times.' : null}>
            {info.services.length === 0 && <li className="notice">No treatments are bookable online yet.</li>}
            {info.services.map((s) => (
              <TreatmentRow key={s.id} name={s.name} durationMin={s.duration_min} pricePence={s.price_pence} description={s.description}
                on={serviceId === s.id} onClick={() => { setServiceId(s.id); setSlot(null); setStep('time'); }} />
            ))}
          </TreatmentMenu>
          <AddOnsMenu text={info.extras_menu} />
          <InfoBadges safety={info.safety_note} location={info.location_note} />
          <BrandFooter {...socials} />
        </>
      )}

      {step === 'time' && service && (
        <>
          <ChosenTreatment name={service.name} durationMin={service.duration_min} pricePence={service.price_pence} onChange={() => setStep('service')} />
          <ScriptTitle className="step-title">Pick a day and time</ScriptTitle>
          <ErrorBox error={busyError} />
          {!busyTimes ? <Spinner /> : daysWithSlots.length === 0 ? (
            <div className="notice">Sorry — there are no free times in the next {info.max_days_ahead} days. Please get in touch directly.</div>
          ) : (
            <>
              <SlotPicker days={daysWithSlots} slotsByDay={slotsByDay} day={day} slot={slot} tz={tz}
                onDay={(d) => { setDay(d); setSlot(null); }} onSlot={setSlot} />
              <StickyAction>
                <button className="btn primary block" disabled={!slot} onClick={() => setStep('details')}>Continue</button>
              </StickyAction>
            </>
          )}
        </>
      )}

      {step === 'details' && service && slot && (
        <>
          <button className="btn ghost small pub-back" onClick={() => setStep('time')}><Icon name="back" size={18} /> Change time</button>
          <Ticket iso={slot} tz={tz} kicker="Your appointment" title={service.name} price={money(service.price_pence)}
            lines={[`${fmtDayLong(slot, tz)} at ${fmtTime(slot, tz)}`, minutesLabel(service.duration_min)]} />
          <section className="pub-group">
            <GroupHead icon="user">Your details</GroupHead>
            <Field label="Full name"><input type="text" autoComplete="name" value={details.full_name} maxLength={100} onChange={(e) => setDetails({ ...details, full_name: e.target.value })} /></Field>
            <Field label="Email" hint="Your confirmation is sent here."><input type="email" autoComplete="email" value={details.email} onChange={(e) => setDetails({ ...details, email: e.target.value })} /></Field>
            <Field label="Mobile"><input type="tel" autoComplete="tel" value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} /></Field>
            <Field label="Anything to add? (optional)" hint="e.g. colour ideas, or if you need a removal">
              <textarea value={details.notes} maxLength={1000} onChange={(e) => setDetails({ ...details, notes: e.target.value })} />
            </Field>
            <div className="visually-hidden" aria-hidden>
              <label>Website<input type="text" tabIndex={-1} autoComplete="off" value={website} onChange={(e) => setWebsite(e.target.value)} /></label>
            </div>
          </section>
          <div className="pub-group pub-first">
            <fieldset className="field">
              <legend className="group-head"><GroupIcon name="sparkle" /><span>Is this your first visit?</span></legend>
              <div className="seg" role="radiogroup" aria-label="Is this your first visit?">
                <button type="button" role="radio" aria-checked={firstVisit === true} className={firstVisit === true ? 'on' : ''} onClick={() => setFirstVisit(true)}>Yes, first time</button>
                <button type="button" role="radio" aria-checked={firstVisit === false} className={firstVisit === false ? 'on' : ''} onClick={() => setFirstVisit(false)}>I’ve been before</button>
              </div>
            </fieldset>
          </div>
          {firstVisit && (
            <div className="card stack pub-group pub-health">
              <GroupHead icon="shield" as="h3">Quick health check</GroupHead>
              <p className="sub">So your treatment is safe for you. Only {info.business_name} sees your answers.</p>
              <ConsultationFields answers={answers} onChange={setAnswers} consent={consent} onConsent={setConsent}
                signedName={signedName} onSignedName={setSignedName} businessName={info.business_name} />
            </div>
          )}
          {info.deposit_amount_pence > 0 && (
            <section className="pub-group pub-deposit">
              <GroupHead icon="bank" as="h3">Deposit for new clients</GroupHead>
              <p>
                New clients pay a {money(info.deposit_amount_pence)} deposit by bank transfer to secure their appointment. If this applies to you, the bank details are in your confirmation email — please pay within {info.deposit_deadline_hours} hours. The deposit comes off your bill.
              </p>
            </section>
          )}
          {policy && (
            <PolicyCard titleAs="h3" className="pub-agree">
              <p className="policy-text">{policy}</p>
              <label className="check policy-check">
                <input type="checkbox" checked={policyOk} onChange={(e) => setPolicyOk(e.target.checked)} />
                <span>I’ve read and agree to the cancellation policy.</span>
              </label>
            </PolicyCard>
          )}
          <div className="pub-group pub-age">
            <label className="check">
              <input type="checkbox" checked={ageOk} onChange={(e) => setAgeOk(e.target.checked)} />
              <span>I’m 16 or over, or I’m a parent or guardian booking for my child.</span>
            </label>
          </div>
          <ErrorBox error={error ? new Error(friendlyError(error)) : null} />
          <button className="btn primary block pub-confirm" disabled={busy} onClick={submit}>
            {busy ? 'Booking…' : <>Confirm booking <Heart size={18} className="pub-confirm-heart" /></>}
          </button>
          <p className="sub centre">How your information is used: <Link to="/privacy">privacy notice</Link>.</p>
        </>
      )}

      {step === 'done' && result && service && (
        <div className="stack pub-done">
          <Celebration />
          <h2 className="pub-done-title">Booking received — thank you!</h2>
          <Ticket iso={result.starts_at} tz={tz} kicker="Your appointment" title={service.name} price={money(service.price_pence)}
            lines={[`${fmtDayLong(result.starts_at, tz)} at ${fmtTime(result.starts_at, tz)}`, minutesLabel(service.duration_min)]}
            stub={<RefStub reference={result.reference} />} />
          <ul className="pub-next" role="list">
            <li><GroupIcon name="mail" /><span>A confirmation is on its way to <b>{details.email.trim()}</b> (check your junk folder).</span></li>
            {info.deposit_amount_pence > 0 && (
              <li><GroupIcon name="bank" /><span>If you’re a new client, it has the bank details for your deposit — use your reference so it can be matched.</span></li>
            )}
            <li><GroupIcon name="calendar" /><span>Need to change or cancel? Use the link in your confirmation email.</span></li>
          </ul>
          <button className="btn block" onClick={() => window.location.reload()}>Book another appointment</button>
          <BrandFooter {...socials} />
        </div>
      )}
    </div>
    </>
  );
}
