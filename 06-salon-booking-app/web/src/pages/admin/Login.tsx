import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorBox, Field, useAction } from '../../components/ui';

export function Login() {
  const demo = api.mode === 'demo';
  const [email, setEmail] = useState(demo ? 'demo@example.com' : '');
  const [password, setPassword] = useState(demo ? 'demo' : '');
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signin');
  const [ownerExists, setOwnerExists] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  useEffect(() => {
    api.ownerExists().then(setOwnerExists).catch(() => setOwnerExists(true));
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    await run(async () => {
      if (mode === 'signin') await api.signIn(email.trim(), password);
      else if (mode === 'signup') {
        if (password.length < 10) throw new Error('Please choose a password of at least 10 characters.');
        const { needsEmailConfirm } = await api.signUp(email.trim(), password);
        if (needsEmailConfirm) setMessage('Check your email and tap the link to confirm your account, then sign in here.');
      } else {
        await api.sendPasswordReset(email.trim());
        setMessage('If that email has an account, a reset link is on its way.');
      }
    });
  }

  return (
    <div className="page stack" style={{ maxWidth: 440, paddingTop: 'calc(env(safe-area-inset-top) + 48px)' }}>
      <div className="hero">
        <h1>{mode === 'signup' ? 'Create your account' : mode === 'reset' ? 'Reset password' : 'Sign in'}</h1>
        <p className="sub">
          {mode === 'signup'
            ? 'The first account created becomes the owner of this diary. Nobody else can sign up after that.'
            : 'Your bookings and client records are private to you.'}
        </p>
      </div>
      {demo && <div className="notice">This is the demo. Just tap <b>Sign in</b> — any details work.</div>}
      <form className="stack" onSubmit={submit}>
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        {mode !== 'reset' && (
          <Field label="Password">
            <input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
              value={password} onChange={(e) => setPassword(e.target.value)} required={!demo} />
          </Field>
        )}
        <ErrorBox error={error} />
        {message && <div className="notice">{message}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
      </form>
      <div className="stack" style={{ gap: 4 }}>
        {mode !== 'signin' && <button className="btn ghost" onClick={() => setMode('signin')}>Back to sign in</button>}
        {mode === 'signin' && !demo && <button className="btn ghost" onClick={() => setMode('reset')}>Forgotten password?</button>}
        {mode === 'signin' && !ownerExists && !demo && (
          <button className="btn ghost" onClick={() => setMode('signup')}>First time here? Create the owner account</button>
        )}
      </div>
      <p className="sub centre">Looking to book an appointment? <Link to="/book">Book online</Link></p>
    </div>
  );
}
