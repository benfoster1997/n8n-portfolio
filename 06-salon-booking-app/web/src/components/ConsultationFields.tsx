import { useId, useState } from 'react';
import { Link } from 'react-router-dom';
import { ACCURACY_TEXT, CONSULTATION_QUESTIONS, HEALTH_CONSENT_TEXT, type Answers } from '../lib/consultation';
import { BrandIcon } from './brand';

/**
 * Splits a question into the question itself and the help after it, so the help can sit
 * underneath in a lighter style: "Any allergies? (for example …)" → ["Any allergies?", "For example …"].
 * The words stay the same; only the outer brackets go.
 */
function splitLabel(label: string): [string, string | null] {
  const m = /^(.+?\?)\s+(.+)$/.exec(label);
  if (!m) return [label, null];
  let hint = m[2].trim();
  if (hint.startsWith('(') && hint.endsWith(')')) hint = hint.slice(1, -1);
  return [m[1], hint.charAt(0).toUpperCase() + hint.slice(1)];
}

export function ConsultationFields({ answers, onChange, consent, onConsent, signedName, onSignedName, businessName }: {
  answers: Answers;
  onChange: (a: Answers) => void;
  consent: boolean;
  onConsent: (v: boolean) => void;
  signedName: string;
  onSignedName: (v: string) => void;
  businessName: string;
}) {
  const set = (k: string, v: unknown) => onChange({ ...answers, [k]: v });
  // Two separate ticks; the form only counts as consented when both are ticked.
  const [accurate, setAccurate] = useState(consent);
  const [agrees, setAgrees] = useState(consent);
  const update = (a: boolean, g: boolean) => { setAccurate(a); setAgrees(g); onConsent(a && g); };
  const uid = useId();
  const signature = signedName.trim();
  return (
    <div className="consult">
      {CONSULTATION_QUESTIONS.map((q, i) => {
        const [question, hint] = splitLabel(q.label);
        const legendId = `${uid}-${q.id}`;
        return (
          <fieldset key={q.id} className={`consult-q consult-q--${q.type}`}>
            <legend id={legendId} className="consult-legend">
              <span className="consult-num" aria-hidden="true">{i + 1}</span>
              <span className="consult-ask">
                <span className="consult-question">{question}</span>
                {hint && <>{' '}<span className="consult-hint">{hint}</span></>}
              </span>
            </legend>
            <div className="consult-answer">
              {q.type === 'yesno' && (
                <>
                  <div className="seg consult-seg" role="radiogroup" aria-label={q.label}>
                    {(['no', 'yes'] as const).map((v) => (
                      <button key={v} type="button" role="radio" aria-checked={answers[q.id] === v}
                        className={answers[q.id] === v ? 'on' : ''} onClick={() => set(q.id, v)}>
                        {v === 'yes' ? 'Yes' : 'No'}
                      </button>
                    ))}
                  </div>
                  {answers[q.id] === 'yes' && (
                    <div className="consult-details">
                      <input type="text" aria-label={q.detailsLabel ?? 'Details'} placeholder={q.detailsLabel ?? 'Details'} maxLength={500}
                        value={String(answers[`${q.id}_details`] ?? '')} onChange={(e) => set(`${q.id}_details`, e.target.value)} />
                    </div>
                  )}
                </>
              )}
              {q.type === 'checks' && (
                <div className="consult-checks">
                  {q.options.map((o) => {
                    const list = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
                    return (
                      <label key={o} className="check consult-check">
                        <input type="checkbox" checked={list.includes(o)}
                          onChange={(e) => set(q.id, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                        <span>{o}</span>
                      </label>
                    );
                  })}
                </div>
              )}
              {q.type === 'text' && (
                <textarea aria-labelledby={legendId} value={String(answers[q.id] ?? '')} placeholder={q.placeholder} maxLength={1000}
                  onChange={(e) => set(q.id, e.target.value)} />
              )}
            </div>
          </fieldset>
        );
      })}

      <div className="consult-consent">
        <p className="consult-consent-head">
          <span className="consult-consent-icon"><BrandIcon name="shield-heart" size={20} /></span>
          <span>Consent and signature</span>
        </p>
        <label className="check consult-tick">
          <input type="checkbox" checked={accurate} onChange={(e) => update(e.target.checked, agrees)} />
          <span>{ACCURACY_TEXT(businessName)}</span>
        </label>
        <label className="check consult-tick">
          <input type="checkbox" checked={agrees} onChange={(e) => update(accurate, e.target.checked)} />
          <span>{HEALTH_CONSENT_TEXT(businessName)} <Link to="/privacy" target="_blank">How it’s kept</Link></span>
        </label>
        <div className="consult-sign">
          <label className="field">
            <span>Type your full name to sign</span>
            <input type="text" autoComplete="name" value={signedName} maxLength={100} onChange={(e) => onSignedName(e.target.value)} />
          </label>
          {/* A preview of the typed name as a signature; the field above is what's read and sent. */}
          <div className={`consult-pad${signature ? ' is-signed' : ''}`} aria-hidden="true">
            <span className="consult-pad-x">×</span>
            <span className="consult-pad-name">{signature || 'Your signature'}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
