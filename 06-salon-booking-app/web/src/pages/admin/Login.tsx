import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Blossom, LemonSlice, ScriptTitle, Sprig, Strapline, Wordmark } from '../../components/brand';
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
    <div className="login">
      <Sprig corner="tl" className="login-sprig" />
      <Sprig corner="tr" className="login-sprig" />
      <Sprig corner="bl" variant="slice" className="login-sprig login-sprig--low" />
      <Sprig corner="br" variant="slice" className="login-sprig login-sprig--low" />
      <div className="login-inner">
        <div className="login-brand">
          <Wordmark name="Bookings" as="p" className="login-wordmark" />
          <Strapline text="Diary, Clients, Money" className="login-strapline" />
        </div>
        <div className="login-stage">
          <LemonSlice size={118} className="login-behind login-behind--slice" />
          <Blossom size={46} className="login-behind login-behind--blossom" />
          <div className="login-card">
            <ScriptTitle as="h1" className="login-title">{mode === 'reset' ? 'Reset password' : 'Sign in'}</ScriptTitle>
            <p className="sub login-private">Your bookings and client records are private to you.</p>
            {demo && <div className="notice login-demo">This is the demo. Just tap <b>Sign in</b> — any details work.</div>}
            <form className="stack login-form" onSubmit={submit}>
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
              <button className="btn primary block login-submit" disabled={busy}>
                {busy ? 'Please wait…' : mode === 'reset' ? 'Send reset link' : 'Sign in'}
              </button>
            </form>
            {mode === 'reset'
              ? <button className="btn ghost block login-alt" onClick={() => setMode('signin')}>Back to sign in</button>
              : !demo && <button className="btn ghost block login-alt" onClick={() => setMode('reset')}>Forgotten password?</button>}
          </div>
        </div>
        <p className="sub centre login-book">Looking to book an appointment? <Link to="/book">Book online</Link></p>
      </div>
    </div>
  );
}
