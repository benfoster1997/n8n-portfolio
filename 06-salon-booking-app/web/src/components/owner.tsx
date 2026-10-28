import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api } from '../api';
import type { Session, Settings } from '../lib/types';
import { Icon, Spinner } from './ui';
import { Sprig } from './brand';
import { Login } from '../pages/admin/Login';

interface OwnerCtx {
  session: Session;
  settings: Settings;
  refreshSettings: () => Promise<void>;
  setSettings: (s: Settings) => void;
}
const Ctx = createContext<OwnerCtx | null>(null);

export function useOwner(): OwnerCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error('useOwner outside OwnerGate');
  return v;
}

type GateState =
  | { kind: 'loading' }
  | { kind: 'signed-out' }
  | { kind: 'not-owner'; session: Session }
  | { kind: 'error'; error: unknown }
  | { kind: 'ready'; session: Session; settings: Settings };

/** Shows the sign-in screen until the owner is signed in, then the app. */
export function OwnerGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<GateState>({ kind: 'loading' });
  const stateRef = useRef(state);
  stateRef.current = state;
  const seq = useRef(0);

  const resolve = useCallback(async (session: Session | null) => {
    const my = ++seq.current; // a slower, older check must never overwrite a newer one
    if (!session) { setState({ kind: 'signed-out' }); return; }
    try {
      // The first account to sign in claims the app; everyone else is refused.
      const isOwner = await api.claimOwner();
      if (my !== seq.current) return;
      if (!isOwner) { setState({ kind: 'not-owner', session }); return; }
      const settings = await api.getSettings();
      if (my !== seq.current) return;
      setState({ kind: 'ready', session, settings });
    } catch (error) {
      if (my === seq.current) setState({ kind: 'error', error });
    }
  }, []);

  useEffect(() => {
    let live = true;
    api.getSession().then((s) => { if (live) void resolve(s); });
    const off = api.onAuthChange((s) => {
      if (!live) return;
      const cur = stateRef.current;
      // Supabase re-announces the same sign-in whenever the app comes back to
      // the screen (e.g. after sending a WhatsApp). Nothing has changed: ignore it.
      if (s && cur.kind === 'ready' && cur.session.userId === s.userId) return;
      if (!s && cur.kind === 'signed-out') return;
      void resolve(s);
    });
    return () => { live = false; off(); };
  }, [resolve]);

  if (state.kind === 'loading') return <Spinner />;
  if (state.kind === 'signed-out') return <Login />;
  if (state.kind === 'error') {
    return (
      <GateScreen icon="alert" title="Can’t open the diary"
        actions={<>
          <button className="btn primary block" onClick={() => window.location.reload()}>Try again</button>
          <button className="btn block" onClick={() => api.signOut()}>Sign out</button>
        </>}>
        <p className="gate-text">{state.error instanceof Error ? state.error.message : String(state.error)}</p>
        <p className="gate-note">If it keeps happening, sign out and sign in again.</p>
      </GateScreen>
    );
  }
  if (state.kind === 'not-owner') {
    return (
      <GateScreen icon="lock" title="This diary already has an owner"
        actions={<button className="btn primary block" onClick={() => api.signOut()}>Sign out</button>}>
        <p className="gate-text">You’re signed in as <b>{state.session.email}</b>, but this app belongs to another account. Only the owner can see bookings and client records.</p>
      </GateScreen>
    );
  }
  const value: OwnerCtx = {
    session: state.session,
    settings: state.settings,
    setSettings: (settings) => setState((cur) => (cur.kind === 'ready' ? { ...cur, settings } : cur)),
    refreshSettings: async () => {
      const settings = await api.getSettings();
      setState((cur) => (cur.kind === 'ready' ? { ...cur, settings } : cur));
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The full-screen message for a signed-in account that can't use the diary: a soft card with a lemon sprig. */
function GateScreen({ icon, title, actions, children }: { icon: 'alert' | 'lock'; title: string; actions: ReactNode; children: ReactNode }) {
  return (
    <div className="page gate-page">
      <div className="card gate-card">
        <Sprig corner="tr" size={118} className="gate-sprig" />
        <span className="gate-ico" aria-hidden="true">
          <svg viewBox="0 0 24 24" width={28} height={28} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            {icon === 'lock'
              ? <><rect x="5" y="10.5" width="14" height="10" rx="2.5" /><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" /><path d="M12 14.5v2.5" /></>
              : <><circle cx="12" cy="12" r="8.6" /><path d="M12 7.6v5.6M12 16.4v.1" /></>}
          </svg>
        </span>
        <h1>{title}</h1>
        {children}
        <div className="gate-actions">{actions}</div>
      </div>
    </div>
  );
}

const TABS = [
  { to: '/', label: 'Today', icon: 'today', end: true },
  { to: '/diary', label: 'Diary', icon: 'diary', end: false },
  { to: '/clients', label: 'Clients', icon: 'clients', end: false },
  { to: '/money', label: 'Money', icon: 'money', end: false },
  { to: '/settings', label: 'Settings', icon: 'settings', end: false },
];

/** Pages with no tab of their own keep the tab they're opened from lit: appointments under Diary, reminders under Today. */
function parentTab(pathname: string): string | null {
  if (pathname.startsWith('/appointments')) return '/diary';
  if (pathname.startsWith('/reminders')) return '/';
  return null;
}

export function AdminLayout() {
  const parent = parentTab(useLocation().pathname);
  return (
    <div className="app">
      {api.mode === 'demo' && <div className="demo-banner">Demo — invented data, saved only in this browser</div>}
      <Outlet />
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive || t.to === parent ? 'active' : '')}>
            <Icon name={t.icon} />
            <span className="tab-label">{t.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
