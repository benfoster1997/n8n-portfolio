import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { api } from '../api';
import type { Session, Settings } from '../lib/types';
import { Icon, Spinner } from './ui';
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

  const resolve = useCallback(async (session: Session | null) => {
    if (!session) { setState({ kind: 'signed-out' }); return; }
    try {
      // The first account to sign in claims the app; everyone else is refused.
      const isOwner = await api.claimOwner();
      if (!isOwner) { setState({ kind: 'not-owner', session }); return; }
      const settings = await api.getSettings();
      setState({ kind: 'ready', session, settings });
    } catch (error) {
      setState({ kind: 'error', error });
    }
  }, []);

  useEffect(() => {
    let live = true;
    api.getSession().then((s) => { if (live) void resolve(s); });
    const off = api.onAuthChange((s) => {
      if (!live) return;
      setState((cur) => (cur.kind === 'ready' && s && cur.session.userId === s.userId ? cur : { kind: 'loading' }));
      void resolve(s);
    });
    return () => { live = false; off(); };
  }, [resolve]);

  if (state.kind === 'loading') return <Spinner />;
  if (state.kind === 'signed-out') return <Login />;
  if (state.kind === 'error') {
    return (
      <div className="page stack">
        <h1>Can’t open the diary</h1>
        <p className="sub">{state.error instanceof Error ? state.error.message : String(state.error)}</p>
        <button className="btn primary" onClick={() => window.location.reload()}>Try again</button>
        <button className="btn" onClick={() => api.signOut()}>Sign out</button>
      </div>
    );
  }
  if (state.kind === 'not-owner') {
    return (
      <div className="page stack">
        <h1>This diary already has an owner</h1>
        <p>You’re signed in as {state.session.email}, but this app belongs to another account. Only the owner can see bookings and client records.</p>
        <button className="btn primary" onClick={() => api.signOut()}>Sign out</button>
      </div>
    );
  }
  const value: OwnerCtx = {
    session: state.session,
    settings: state.settings,
    setSettings: (settings) => setState({ ...state, settings }),
    refreshSettings: async () => setState({ ...state, settings: await api.getSettings() }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

const TABS = [
  { to: '/', label: 'Today', icon: 'today', end: true },
  { to: '/diary', label: 'Diary', icon: 'diary', end: false },
  { to: '/clients', label: 'Clients', icon: 'clients', end: false },
  { to: '/money', label: 'Money', icon: 'money', end: false },
  { to: '/settings', label: 'Settings', icon: 'settings', end: false },
];

export function AdminLayout() {
  return (
    <div className="app">
      {api.mode === 'demo' && <div className="demo-banner">Demo — invented data, saved only in this browser</div>}
      <Outlet />
      <nav className="tabbar" aria-label="Main">
        {TABS.map((t) => (
          <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <Icon name={t.icon} />
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
