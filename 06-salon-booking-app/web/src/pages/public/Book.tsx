import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { ConsultationFields } from '../../components/ConsultationFields';
import { SlotPicker, useFreeSlots } from '../../components/SlotPicker';
import { useClientManifest } from '../../components/clientManifest';
import { Badge, BrandFooter, BrandHero, Heart, ScriptTitle } from '../../components/brand';
import { AddOnsMenu, InfoBadges, TreatmentMenu, TreatmentRow } from '../../components/public/menu';
import {
  Celebration, ChosenTreatment, ContactButtons, GroupHead, GroupIcon, NextArrow, NoTimeSuits, PolicyCard, PublicLoading, PublicProblem, RefStub,
  ShareWithFriend, StickyAction, Steps, Ticket, type ContactWays,
} from '../../components/public/parts';
import { ErrorBox, Field, Icon, Spinner, useAction, useLoad } from '../../components/ui';
import { blankAnswers, validateAnswers } from '../../lib/consultation';
import { findTreatment } from '../../lib/freeTimes';
import { bookingTitle } from '../../lib/head';
import { openDays } from '../../lib/slots';
import { HEARD_FROM, HEARD_FROM_DETAIL_MAX, LINK_FROM, readSource, takesDetail } from '../../lib/source';
import { addDays, fmtDayLong, fmtTime, minutesLabel, startOfDayInstant } from '../../lib/time';
import { friendlyError, isNetworkError, isPlausibleEmail, isPlausiblePhone, money, suggestEmail } from '../../lib/text';
import type { BookingExtras, BookingInfo, BusyRange, HeardFrom } from '../../lib/types';

type Step = 'service' | 'time' | 'details' | 'done';

/** The database's answers that mean the chosen time can't be booked any more: back to the free times. */
const TIME_GONE = ['slot_taken', 'too_soon', 'too_far', 'closed', 'outside_hours', 'invalid_time'];

/** Answers that leave nothing to do but get in touch, so her "Message me" buttons go under them. */
const GET_IN_TOUCH = ['busy_try_later', 'booking_failed', 'too_many_bookings', 'booking_disabled'];

const messageOf = (e: unknown) => (e instanceof Error ? e.message : String((e as { message?: unknown } | null)?.message ?? e));

/**
 * Where this visit came from: ?from= on her link, or the site that sent them (readSource in lib/source).
 * Read once, the first time the booking page opens, and kept in the page only: nothing is stored on the
 * visitor's phone (no cookies or storage, which PECR covers). Reading the privacy notice and coming back
 * is in-app navigation, so it's still known then.
 */
let visitSource: string | null | undefined;
export function sourceOfVisit(): string | null {
  if (visitSource === undefined) visitSource = readSource({ search: window.location.search, referrer: document.referrer });
  return visitSource;
}

/** The answer picked to begin with when they came through a friend's share or her printed card. They can change it. */
export function answerFromLink(source: string | null): HeardFrom | null {
  return source === LINK_FROM.friend ? 'friend' : source === LINK_FROM.card ? 'card' : null;
}

/**
 * The optional answers that go with a booking. "How did you hear about me?" is only asked of first-timers,
 * so it only goes with "Yes, first time", and its few words only with A friend or Other. The offers box
 * counts only when ticked. createBooking leaves out whatever is blank.
 */
export function bookingExtras({ source, firstVisit, heard, detail, offersOk }: {
  source: string | null; firstVisit: boolean | null; heard: HeardFrom | null; detail: string; offersOk: boolean;
}): BookingExtras {
  const asked = firstVisit === true ? heard : null;
  return {
    link_source: source,
    heard_from: asked,
    heard_from_detail: takesDetail(asked) ? detail.trim() || null : null,
    first_visit: firstVisit,
    marketing_ok: offersOk,
  };
}

/** A failed booking that's best sorted out by getting in touch (not one with its own next step, like no signal or a time gone). */
export function needsContact(e: unknown): boolean {
  if (!e) return false;
  const msg = messageOf(e);
  return GET_IN_TOUCH.some((code) => msg.includes(code));
}

const contactWays = (info: BookingInfo): ContactWays =>
  ({ instagram: info.instagram_handle, facebook: info.facebook_handle, email: info.contact_email });

/** An email address that, when it won't fit on one line, breaks after its @ first. */
function Address({ email }: { email: string }) {
  const at = email.lastIndexOf('@') + 1;
  return <>{email.slice(0, at)}<wbr />{email.slice(at)}</>;
}

/**
 * What a failed "Confirm booking" means for the client:
 * - 'no_reply': the signal dropped, so the booking may or may not have gone through. Retrying
 *   straight away could book twice, or say their own time has just been taken.
 * - 'time_gone': the time has just been taken (or is now too soon): pick another.
 * - 'other': anything else, said in plain words on the details step.
 */
export function bookingFailure(e: unknown): 'no_reply' | 'time_gone' | 'other' {
  if (isNetworkError(e)) return 'no_reply';
  const msg = messageOf(e);
  return TIME_GONE.some((code) => msg.includes(code)) ? 'time_gone' : 'other';
}

export function Book() {
  useClientManifest();
  const [source] = useState(sourceOfVisit);
  const { data: info, error, loading } = useLoad(() => api.getBookingInfo(), []);
  // The same title as the page's built-in head, so the default name is never advertised here either.
  useEffect(() => { if (info) document.title = bookingTitle(info.business_name); }, [info]);
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
        <ContactButtons {...contactWays(info)} />
        <InfoBadges safety={info.safety_note} />
        <BrandFooter instagram={info.instagram_handle} facebook={info.facebook_handle} />
      </div>
      </>
    );
  }
  return <BookingFlow info={info} source={source} />;
}

function BookingFlow({ info, source }: { info: BookingInfo; source: string | null }) {
  const tz = info.timezone;
  const [params] = useSearchParams();
  // A link for one treatment ("…/book?treatment=biab-infill", from Share free times) opens straight on
  // its free times. One that isn't bookable online (or no longer exists) opens the usual page.
  const [linked] = useState(() => findTreatment(params.get('treatment'), info.services));
  const [step, setStep] = useState<Step>(linked ? 'time' : 'service');
  const [serviceId, setServiceId] = useState<string | null>(linked?.id ?? null);
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
  // "How did you hear about me?" (first-timers only, optional), with the few words for A friend and Other kept apart.
  const [heard, setHeard] = useState<HeardFrom | null>(() => answerFromLink(source));
  const [heardWords, setHeardWords] = useState<Record<'friend' | 'other', string>>({ friend: '', other: '' });
  // "Message me about short-notice spaces and offers": unticked until they tick it.
  const [offersOk, setOffersOk] = useState(false);
  // "Did you mean …?" for an email address that looks mistyped, worked out when they leave the field.
  const [emailHint, setEmailHint] = useState<string | null>(null);
  const contact = contactWays(info);
  const policy = info.cancellation_policy?.trim() || null;
  const [result, setResult] = useState<{ reference: string; starts_at: string } | null>(null);
  const { busy, error, run, setError } = useAction();
  // Back on the free times because the time they chose has gone: why, above the times.
  const [timeGone, setTimeGone] = useState<string | null>(null);
  // The time they were booking when the signal dropped: it may now be theirs.
  const [noReplyFor, setNoReplyFor] = useState<string | null>(null);
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
    const at = slot!.toISOString();
    let failed: unknown = null;
    const ok = await run(async () => {
      try {
        setResult(await api.createBooking({
          service_id: service!.id, starts_at: at, full_name: details.full_name.trim(),
          email: details.email.trim(), phone: details.phone.trim(), notes: details.notes.trim() || null,
          consultation: firstVisit ? answers : null, health_consent: firstVisit ? consent : false,
          signed_name: firstVisit ? signedName.trim() : null,
          policy_accepted: !!policy && policyOk,
          extras: bookingExtras({
            source, firstVisit, heard, detail: heard === 'friend' || heard === 'other' ? heardWords[heard] : '', offersOk,
          }),
        }));
      } catch (e) {
        failed = e;
        throw e;
      }
    });
    if (ok) { setStep('done'); return; }
    const why = bookingFailure(failed);
    if (why === 'no_reply') {
      // The booking may have been made with the reply lost on the way back: check before trying again.
      setNoReplyFor(at);
      setError(new Error('booking_no_reply'));
      return;
    }
    reloadBusy(); // the time may have just gone; refresh what's free
    if (why === 'time_gone') {
      // If that's the time they were booking when the signal dropped, it may be theirs now.
      setTimeGone(noReplyFor === at
        ? 'That time is booked now. If it was you, a moment ago, check your email for your confirmation. Otherwise, please pick another time.'
        : friendlyError(failed));
      setError(null);
      setSlot(null);
      setStep('time');
    }
  }

  const stepIndex = { service: 0, time: 1, details: 2, done: 3 }[step];
  const socials = { instagram: info.instagram_handle, facebook: info.facebook_handle };

  return (
    <>
    {api.mode === 'demo' && <div className="demo-banner">Demo — bookings here aren’t real and go nowhere</div>}
    <div className={`page page-public stack book book--${step}`} ref={topRef}>
      <BrandHero name={info.business_name} compact={step !== 'service'}
        tagline={step === 'service' || step === 'done' ? info.tagline : null}
        strapline={step === 'service' ? info.strapline : null}
        intro={step === 'service' ? info.booking_intro : null} />
      {/* no location in the hero: step 1 shows it as the Location badge, as on her price list */}
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
          <ChosenTreatment name={service.name} durationMin={service.duration_min} pricePence={service.price_pence}
            onChange={() => { setTimeGone(null); setStep('service'); }} />
          <ScriptTitle className="step-title">Pick a day and time</ScriptTitle>
          {timeGone && <div className="notice warn pub-time-gone" role="alert">{timeGone}</div>}
          <ErrorBox error={busyError} />
          {!busyTimes ? <Spinner /> : daysWithSlots.length === 0 ? (
            <div className="notice stack pub-no-times">
              <p>Sorry — there are no free times in the next {info.max_days_ahead} days. Please get in touch directly.</p>
              <ContactButtons {...contact} />
            </div>
          ) : (
            <>
              <SlotPicker days={daysWithSlots} slotsByDay={slotsByDay} day={day} slot={slot} tz={tz}
                onDay={(d) => { setDay(d); setSlot(null); }} onSlot={(t) => { setSlot(t); setTimeGone(null); }} />
              <NoTimeSuits {...contact} />
              <StickyAction when={slot} tz={tz}>
                <button className="btn primary block" disabled={!slot} onClick={() => setStep('details')}>Continue <NextArrow /></button>
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
          <ScriptTitle className="step-title">Your details</ScriptTitle>
          <section className="pub-group">
            <Field label="Full name"><input type="text" autoComplete="name" value={details.full_name} maxLength={100} onChange={(e) => setDetails({ ...details, full_name: e.target.value })} /></Field>
            <div className="pub-email">
              <Field label="Email" hint="Your confirmation is sent here.">
                <input type="email" autoComplete="email" value={details.email}
                  onChange={(e) => { setDetails({ ...details, email: e.target.value }); setEmailHint(null); }}
                  onBlur={() => setEmailHint(suggestEmail(details.email))} />
              </Field>
              {/* Only ever a suggestion: the address changes only if they tap Use this. */}
              <div aria-live="polite">
                {emailHint && (
                  <p className="pub-email-hint">
                    <span>Did you mean <b><Address email={emailHint} /></b>?</span>
                    <button type="button" className="btn small"
                      onClick={() => { setDetails((d) => ({ ...d, email: emailHint })); setEmailHint(null); }}>Use this</button>
                  </p>
                )}
              </div>
            </div>
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
            // Optional, and only asked of first-timers. Tapping the chosen answer again clears it.
            <fieldset className="pub-group pub-heard">
              <legend className="group-head">
                <GroupIcon name="chat" /><span>How did you hear about me? <span className="pub-optional">(optional)</span></span>
              </legend>
              <div className="pub-chips" role="radiogroup" aria-label="How did you hear about me?">
                {HEARD_FROM.map(({ value, label }) => (
                  <button key={value} type="button" role="radio" aria-checked={heard === value}
                    className={heard === value ? 'pub-chip on' : 'pub-chip'} onClick={() => setHeard(heard === value ? null : value)}>
                    {label}
                  </button>
                ))}
              </div>
              {(heard === 'friend' || heard === 'other') && (
                <Field key={heard} label={heard === 'friend' ? 'Who recommended you? (optional, first name is fine)' : 'Where? (optional)'}>
                  <input type="text" autoComplete="off" maxLength={HEARD_FROM_DETAIL_MAX} value={heardWords[heard]}
                    onChange={(e) => setHeardWords({ ...heardWords, [heard]: e.target.value })} />
                </Field>
              )}
            </fieldset>
          )}
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
          <div className="pub-group pub-offers">
            <label className="check">
              <input type="checkbox" checked={offersOk} onChange={(e) => setOffersOk(e.target.checked)} />
              <span>Message me about <span className="pub-nowrap">short-notice</span> spaces and offers (you can say stop any time)</span>
            </label>
          </div>
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
          {needsContact(error) && <ContactButtons {...contact} />}
          <button className="btn primary block pub-confirm" disabled={busy} onClick={submit}>
            {busy ? 'Booking…' : <>Confirm booking <Heart size={18} className="pub-confirm-heart" /></>}
          </button>
          <p className="sub centre">How your information is used: <Link to="/privacy">privacy notice</Link>.</p>
        </>
      )}

      {step === 'done' && result && service && (
        <div className="stack pub-done">
          <Celebration />
          {/* the no-break space keeps the dash with "received" when the title wraps */}
          <h2 className="pub-done-title">Booking received&nbsp;— thank you!</h2>
          <Ticket iso={result.starts_at} tz={tz} kicker="Your appointment" title={service.name} price={money(service.price_pence)}
            lines={[`${fmtDayLong(result.starts_at, tz)} at ${fmtTime(result.starts_at, tz)}`, minutesLabel(service.duration_min)]}
            stub={<RefStub reference={result.reference} />} />
          <ul className="pub-next" role="list">
            <li><GroupIcon name="mail" /><span>A confirmation is on its way to <b>{details.email.trim()}</b>. It can take up to 10 minutes: if it isn’t there by then, check your junk folder.</span></li>
            {info.deposit_amount_pence > 0 && (
              <li><GroupIcon name="bank" /><span>If you’re a new client, it has the bank details for your deposit — use your reference so it can be matched.</span></li>
            )}
            <li><GroupIcon name="calendar" /><span>Need to change or cancel? Use the link in your confirmation email.</span></li>
          </ul>
          <ShareWithFriend business={info.business_name} />
          <button className="btn block" onClick={() => window.location.reload()}>Book another appointment</button>
          <BrandFooter {...socials} />
        </div>
      )}
    </div>
    </>
  );
}
