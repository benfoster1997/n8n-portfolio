import { CONSULTATION_QUESTIONS, HEALTH_CONSENT_TEXT, type Answers } from '../lib/consultation';

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
  return (
    <div className="stack">
      {CONSULTATION_QUESTIONS.map((q) => (
        <fieldset key={q.id} className="field">
          <legend style={{ marginBottom: 6 }}>{q.label}</legend>
          {q.type === 'yesno' && (
            <>
              <div className="seg" role="radiogroup" aria-label={q.label}>
                {(['no', 'yes'] as const).map((v) => (
                  <button key={v} type="button" role="radio" aria-checked={answers[q.id] === v}
                    className={answers[q.id] === v ? 'on' : ''} onClick={() => set(q.id, v)}>
                    {v === 'yes' ? 'Yes' : 'No'}
                  </button>
                ))}
              </div>
              {answers[q.id] === 'yes' && (
                <input type="text" aria-label={q.detailsLabel ?? 'Details'} placeholder={q.detailsLabel ?? 'Details'} maxLength={500}
                  value={String(answers[`${q.id}_details`] ?? '')} onChange={(e) => set(`${q.id}_details`, e.target.value)} style={{ marginTop: 6 }} />
              )}
            </>
          )}
          {q.type === 'checks' && q.options.map((o) => {
            const list = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
            return (
              <label key={o} className="check" style={{ padding: '6px 0' }}>
                <input type="checkbox" checked={list.includes(o)}
                  onChange={(e) => set(q.id, e.target.checked ? [...list, o] : list.filter((x) => x !== o))} />
                <span>{o}</span>
              </label>
            );
          })}
          {q.type === 'text' && (
            <textarea value={String(answers[q.id] ?? '')} placeholder={q.placeholder} maxLength={1000} onChange={(e) => set(q.id, e.target.value)} />
          )}
        </fieldset>
      ))}
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => onConsent(e.target.checked)} />
        <span>{HEALTH_CONSENT_TEXT.replace('stored securely', `stored securely by ${businessName}`)}</span>
      </label>
      <label className="field">
        <span>Type your full name to sign</span>
        <input type="text" autoComplete="name" value={signedName} maxLength={100} onChange={(e) => onSignedName(e.target.value)} />
      </label>
    </div>
  );
}
