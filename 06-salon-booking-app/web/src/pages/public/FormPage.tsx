import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
import { BrandFooter, BrandHero, BrandIcon, Heart, LemonSlice, PolishBottle, ScriptTitle } from '../../components/brand';
import { ConsultationFields } from '../../components/ConsultationFields';
import { ErrorBox, Spinner, useAction, useLoad } from '../../components/ui';
import { blankAnswers, validateAnswers } from '../../lib/consultation';
import { fmtDayLong, fmtTime } from '../../lib/time';
import { useClientManifest } from '../../components/clientManifest';

/** The consultation form link sent to new clients who didn't fill it in while booking. */
export function FormPage() {
  useClientManifest();
  const { token = '' } = useParams();
  const valid = /^[0-9a-f-]{36}$/i.test(token);
  const { data, error, loading } = useLoad(() => (valid ? api.getForm(token) : Promise.resolve(null)), [token]);
  const [answers, setAnswers] = useState(blankAnswers);
  const [consent, setConsent] = useState(false);
  const [signedName, setSignedName] = useState('');
  const [done, setDone] = useState(false);
  const { busy, error: saveError, run, setError } = useAction();

  if (loading) return <Spinner />;
  if (!data) {
    return (
      <div className="page page-public form-page form-missing">
        <div className="card form-missing-card stack">
          <LemonSlice size={64} className="form-missing-art" />
          <h1>Consultation form</h1>
          {error ? <ErrorBox error={error} /> : <div className="notice">This link has expired or isn’t valid. Please get in touch if you need a new one.</div>}
          <Link className="btn primary block" to="/book">Book an appointment</Link>
        </div>
      </div>
    );
  }
  if (data.submitted || done) {
    return (
      <div className="page page-public form-page form-done">
        <BrandHero name={data.business_name} compact nameAs="p" />
        <section className="card form-thanks">
          <span className="form-thanks-mark" aria-hidden="true">
            <Heart filled size={34} className="form-thanks-heart" />
          </span>
          <h1>Thank you{data.first_name ? `, ${data.first_name}` : ''}!</h1>
          <p>Your consultation form has been received. See you on <b>{fmtDayLong(data.starts_at)}</b> at <b>{fmtTime(data.starts_at)}</b>.</p>
        </section>
        <p className="sub centre">Need to change or cancel? <Link to={`/manage/${token}`}>Manage your booking</Link></p>
        <BrandFooter />
      </div>
    );
  }

  async function submit() {
    const problem = validateAnswers(answers);
    if (problem) return setError(new Error(problem));
    if (!consent) return setError(new Error('consent_required'));
    if (signedName.trim().length < 2) return setError(new Error('signature_required'));
    if (await run(() => api.submitForm(token, answers, consent, signedName.trim()))) setDone(true);
  }

  return (
    <div className="page page-public form-page">
      <BrandHero name={data.business_name} compact />
      <section className="card form-intro">
        <PolishBottle size={74} className="form-intro-bottle" />
        <p className="form-kicker">Consultation form</p>
        <p className="form-hello">Hi {data.first_name}<span className="visually-hidden"> —</span><Heart size={18} className="form-hello-heart" /></p>
        <p className="form-intro-text">
          before your <b>{data.service_name}</b> on <b>{fmtDayLong(data.starts_at)} at {fmtTime(data.starts_at)}</b>, please
          answer a few quick questions so your treatment is safe for you.
        </p>
      </section>
      <ScriptTitle className="form-title">Quick health check</ScriptTitle>
      <div className="card form-card">
        <ConsultationFields answers={answers} onChange={setAnswers} consent={consent} onConsent={setConsent}
          signedName={signedName} onSignedName={setSignedName} businessName={data.business_name} />
      </div>
      <ErrorBox error={saveError} />
      <button className="btn primary block form-send" disabled={busy} onClick={submit}>
        {busy ? 'Sending…' : 'Send form'}
        {!busy && <BrandIcon name="sparkle" size={20} strokeWidth={2} />}
      </button>
      <div className="form-links">
        <p className="sub centre">Need to change or cancel? <Link to={`/manage/${token}`}>Manage your booking</Link></p>
        <p className="sub centre">See the <Link to="/privacy">privacy notice</Link> for how your information is kept.</p>
      </div>
      <BrandFooter />
    </div>
  );
}
