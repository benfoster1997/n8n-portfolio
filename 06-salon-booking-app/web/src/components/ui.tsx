import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import type { ApptStatus } from '../lib/types';
import { friendlyError } from '../lib/text';
import { todayInZone } from '../lib/time';

// ---------------------------------------------------------------------------
// Icons (inline SVG, so the app needs no icon font or network)
// ---------------------------------------------------------------------------
const paths: Record<string, ReactNode> = {
  today: <><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /><circle cx="12" cy="15" r="1.6" fill="currentColor" /></>,
  diary: <><rect x="3" y="4.5" width="18" height="16" rx="3" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4M7.5 13.5h3M13.5 13.5h3M7.5 17h3" /></>,
  clients: <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.7-3.6 3.3-5.5 6.5-5.5s5.8 1.9 6.5 5.5" /><path d="M16 4.8a3.3 3.3 0 0 1 0 6.4M18.2 14.8c1.7.7 2.9 2.4 3.3 5.2" /></>,
  money: <><rect x="2.5" y="6" width="19" height="12.5" rx="2.5" /><circle cx="12" cy="12.25" r="2.8" /><path d="M6 9.5v5.5M18 9.5v5.5" /></>,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  back: <path d="M15 5l-7 7 7 7" />,
  chev: <path d="M9 5l7 7-7 7" />,
  left: <path d="M15 5l-7 7 7 7" />,
  right: <path d="M9 5l7 7-7 7" />,
  whatsapp: <path d="M20.5 11.6a8.5 8.5 0 0 1-12.6 7.4L3.5 20.5l1.6-4.3A8.5 8.5 0 1 1 20.5 11.6zM9 8.5c0 3.5 3 6.5 6.5 6.5l1.2-1.4-1.9-1-1 .9a5 5 0 0 1-2.8-2.8l.9-1-1-1.9L9.5 8z" />,
  phone: <path d="M5 3.5h3.2l1.6 4-2 1.3a11 11 0 0 0 5.4 5.4l1.3-2 4 1.6V17a3 3 0 0 1-3.2 3A15 15 0 0 1 2 6.7 3 3 0 0 1 5 3.5z" />,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="M3.5 6.5l8.5 6.5 8.5-6.5" /></>,
  camera: <><path d="M3 8.5A2.5 2.5 0 0 1 5.5 6H8l1.5-2h5L16 6h2.5A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" /><circle cx="12" cy="13" r="3.8" /></>,
  bell: <><path d="M6 9a6 6 0 1 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9z" /><path d="M10 20a2 2 0 0 0 4 0" /></>,
  tick: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="M16 16l4.5 4.5" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  trash: <><path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  share: <><path d="M12 14.5V3.5M7.8 7.7 12 3.5l4.2 4.2" /><path d="M8 10.5H6.5A2.5 2.5 0 0 0 4 13v5.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V13a2.5 2.5 0 0 0-2.5-2.5H16" /></>,
  copy: <><rect x="8.5" y="8.5" width="12" height="12" rx="2.5" /><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5" /></>,
};

export function Icon({ name, size = 24, title }: { name: keyof typeof paths | string; size?: number; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {paths[name]}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Status chips
// ---------------------------------------------------------------------------
const STATUS: Record<ApptStatus, { label: string; cls: string }> = {
  pending_deposit: { label: 'Deposit due', cls: 'warn' },
  confirmed: { label: 'Confirmed', cls: 'ok' },
  completed: { label: 'Done', cls: '' },
  cancelled: { label: 'Cancelled', cls: 'danger' },
  no_show: { label: 'No-show', cls: 'danger' },
};
/** unfinished: its time has passed but it still says Confirmed or Deposit due (lib/unfinished). */
export function StatusChip({ status, unfinished }: { status: ApptStatus; unfinished?: boolean }) {
  if (unfinished) return <span className="chip warn">Not finished</span>;
  const s = STATUS[status];
  return <span className={`chip ${s.cls}`}>{s.label}</span>;
}
export const statusLabel = (s: ApptStatus) => STATUS[s].label;
/** Red chip for a change or cancellation made inside the cancellation notice period. */
export function LateChip({ children = 'Late' }: { children?: ReactNode }) {
  return <span className="chip danger">{children}</span>;
}

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------
export function TopBar({ title, back, right }: { title: ReactNode; back?: boolean | string; right?: ReactNode }) {
  const nav = useNavigate();
  return (
    <div className="topbar">
      {back && (
        <button className="icon-btn back" aria-label="Back"
          onClick={() => (typeof back === 'string' ? nav(back) : window.history.length > 1 ? nav(-1) : nav('/'))}>
          <Icon name="back" />
        </button>
      )}
      <h1>{title}</h1>
      {right}
    </div>
  );
}

export function Spinner() {
  return <div className="spinner" role="status" aria-label="Loading" />;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="error" role="alert">{friendlyError(error)}</div>;
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/**
 * A modal sheet. While it's open, focus moves into it and Tab stays inside, so keyboard and
 * VoiceOver users don't wander behind the backdrop; Escape closes it, and focus then goes
 * back to whatever opened it.
 */
export function Sheet({ title, onClose, children, closeButton = true }: {
  title: string; onClose: () => void; children: ReactNode;
  /** A round Close (X) button beside the title; turn it off where the sheet already has its own way out. */
  closeButton?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // The latest onClose, so a new function each render doesn't re-run the effect (and move focus again).
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = box.current!;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.contains(document.activeElement)) el.focus({ preventScroll: true }); // a field with autoFocus keeps it
    const onKey = (e: KeyboardEvent) => {
      // Only the top sheet answers, if one ever opens over another.
      const sheets = document.querySelectorAll('.sheet');
      if (sheets[sheets.length - 1] !== el) return;
      if (e.key === 'Escape') { e.preventDefault(); close.current(); return; }
      if (e.key !== 'Tab') return;
      const items = Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((x) => x.getClientRects().length > 0);
      const at = document.activeElement;
      if (!items.length) { e.preventDefault(); el.focus(); return; }
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && (at === first || at === el || !el.contains(at))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && (at === last || !el.contains(at))) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
      // Back where they were, unless that's gone or something else has taken focus since.
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || el.contains(now))) opener.focus();
    };
  }, []);
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div ref={box} className="sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}>
        <div className="grabber" />
        <div className="sheet-head">
          <h2 id={titleId}>{title}</h2>
          {closeButton && (
            <button type="button" className="icon-btn sheet-close" aria-label="Close" onClick={onClose}>
              <Icon name="close" size={20} />
            </button>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
const ToastCtx = createContext<(msg: string) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null);
  const timer = useRef<number>();
  const show = useCallback((m: string) => {
    setMsg(m);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      {msg && <div className="toast" role="status">{msg}</div>}
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** A background refresh that fails is tried once more after this long, before it says so. */
export const RETRY_AFTER_MS = 1500;

/**
 * Load what a screen shows, again whenever `deps` change. What's on screen stays while it
 * reloads. `reload` loads it again now; `refresh` does it in the background, trying once
 * more if that fails (see useRefreshOnReturn). `loadedAt` is when it last loaded (ms).
 */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]): {
  data: T | undefined; error: unknown; loading: boolean; loadedAt: number | null;
  reload: () => void; refresh: () => void; setData: (d: T) => void;
} {
  const [data, setData] = useState<T>();
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [tick, setTick] = useState(0);
  // The next load is a refresh in the background.
  const background = useRef(false);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const retry = background.current;
    background.current = false;
    setLoading(true);
    const attempt = (again: boolean) => {
      fn().then((d) => {
        if (!live) return;
        setData(d);
        setError(null);
        setLoadedAt(Date.now());
        setLoading(false);
      }, (e) => {
        if (!live) return;
        if (again) { timer = setTimeout(() => attempt(false), RETRY_AFTER_MS); return; }
        setError(e);
        setLoading(false);
      });
    };
    attempt(retry);
    return () => { live = false; clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  const refresh = useCallback(() => { background.current = true; setTick((t) => t + 1); }, []);
  return { data, error, loading, loadedAt, reload, refresh, setData };
}

/** What's on a screen is reloaded when she comes back to the app once it's this old (or the day has changed). */
export const STALE_AFTER_MS = 5 * 60e3;
/** iOS can fail a request made the instant the app comes back on screen, so wait about a second first. */
export const RETURN_DELAY_MS = 1000;

/**
 * Whether a screen loaded at `loadedAt` needs loading again: the day has changed since (in the
 * business's time zone), or a few minutes have passed. Never before it has loaded at all.
 */
export function isStale(loadedAt: number | null, now: number, tz: string): boolean {
  if (loadedAt === null) return false;
  return now - loadedAt >= STALE_AFTER_MS || todayInZone(tz, new Date(loadedAt)) !== todayInZone(tz, new Date(now));
}

/**
 * Reload a screen by itself when she comes back to the app (from WhatsApp, her bank app, or
 * the next morning) if the day has changed, it's a few minutes old, or its last load failed.
 * It waits about a second first, and `refresh` tries once more if that fails (useLoad). Never
 * while `blocked` (a sheet open, something unsaved or still saving): it waits until it isn't.
 */
export function useRefreshOnReturn({ loadedAt, error, refresh, blocked, tz }: {
  loadedAt: number | null; error: unknown; refresh: () => void; blocked: boolean; tz: string;
}) {
  const latest = useRef({ loadedAt, error, refresh, blocked, tz });
  latest.current = { loadedAt, error, refresh, blocked, tz };
  // Due while a sheet was open: done once it closes.
  const waiting = useRef(false);
  const due = () => {
    const l = latest.current;
    return !!l.error || isStale(l.loadedAt, Date.now(), l.tz);
  };
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const back = () => {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (document.visibilityState === 'hidden' || !due()) return;
        if (latest.current.blocked) { waiting.current = true; return; }
        latest.current.refresh();
      }, RETURN_DELAY_MS);
    };
    // Safari can also bring a page back from its back-forward cache without a visibility change.
    const shown = (e: PageTransitionEvent) => { if (e.persisted) back(); };
    document.addEventListener('visibilitychange', back);
    window.addEventListener('pageshow', shown);
    return () => {
      document.removeEventListener('visibilitychange', back);
      window.removeEventListener('pageshow', shown);
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (blocked || !waiting.current) return;
    waiting.current = false;
    if (due()) latest.current.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocked]);
}

/** Wrap an async action with busy/error state, for buttons. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value}
          className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
