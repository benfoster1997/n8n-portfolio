import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../api';
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
      <div className="page page-public stack">
        <h1>Consultation form</h1>
        {error ? <ErrorBox error={error} /> : <div className="notice">This link has expired or isn’t valid. Please get in touch if you need a new one.</div>}
        <Link className="btn" to="/book">Book an appointment</Link>
      </div>
    );
  }
  if (data.submitted || done) {
    return (
      <div className="page page-public stack centre">
        <h1>Thank you{data.first_name ? `, ${data.first_name}` : ''}!</h1>
        <p>Your consultation form has been received. See you on {fmtDayLong(data.starts_at)} at {fmtTime(data.starts_at)}.</p>
        <p className="sub">Need to change or cancel? <Link to={`/manage/${token}`}>Manage your booking</Link></p>
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
    <div className="page page-public stack">
      <div className="hero">
        <h1>{data.business_name}</h1>
        <p>Hi {data.first_name} — before your {data.service_name} on {fmtDayLong(data.starts_at)} at {fmtTime(data.starts_at)}, please answer a few quick questions so your treatment is safe for you.</p>
      </div>
      <div className="card">
        <ConsultationFields answers={answers} onChange={setAnswers} consent={consent} onConsent={setConsent}
          signedName={signedName} onSignedName={setSignedName} businessName={data.business_name} />
      </div>
      <ErrorBox error={saveError} />
      <button className="btn primary block" disabled={busy} onClick={submit}>{busy ? 'Sending…' : 'Send form'}</button>
      <p className="sub centre">Need to change or cancel? <Link to={`/manage/${token}`}>Manage your booking</Link></p>
      <p className="sub centre">See the <Link to="/privacy">privacy notice</Link> for how your information is kept.</p>
    </div>
  );
}
