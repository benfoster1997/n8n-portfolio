import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { ErrorBox, Field, useAction } from '../../components/ui';

/**
 * Sign-in only. The owner's account is created in the Supabase dashboard with
 * public sign-ups switched off (SETUP.md step 3), so there is deliberately no
 * "create account" here.
 */
export function Login() {
  const demo = api.mode === 'demo';
  const [email, setEmail] = useState(demo ? 'demo@example.com' : '');
  const [password, setPassword] = useState(demo ? 'demo' : '');
  const [mode, setMode] = useState<'signin' | 'reset'>('signin');
  const [message, setMessage] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    await run(async () => {
      if (mode === 'signin') await api.signIn(email.trim(), password);
      else {
        await api.sendPasswordReset(email.trim());
        setMessage('If that email has an account, a reset link is on its way.');
      }
    });
  }

  return (
    <div className="page stack" style={{ maxWidth: 440, paddingTop: 'calc(env(safe-area-inset-top) + 48px)' }}>
      <div className="hero">
        <h1>{mode === 'reset' ? 'Reset password' : 'Sign in'}</h1>
        <p className="sub">Your bookings and client records are private to you.</p>
      </div>
      {demo && <div className="notice">This is the demo. Just tap <b>Sign in</b> — any details work.</div>}
      <form className="stack" onSubmit={submit}>
        <Field label="Email">
          <input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        {mode === 'signin' && (
          <Field label="Password">
            <input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required={!demo} />
          </Field>
        )}
        <ErrorBox error={error} />
        {message && <div className="notice">{message}</div>}
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Please wait…' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
        </button>
      </form>
      {mode === 'reset'
        ? <button className="btn ghost" onClick={() => setMode('signin')}>Back to sign in</button>
        : !demo && <button className="btn ghost" onClick={() => setMode('reset')}>Forgotten password?</button>}
      <p className="sub centre">Looking to book an appointment? <Link to="/book">Book online</Link></p>
    </div>
  );
}
