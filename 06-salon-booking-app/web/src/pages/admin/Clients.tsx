import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Sheet, Spinner, TopBar, useAction, useLoad } from '../../components/ui';
import { fmtDay } from '../../lib/time';
import { isPlausibleEmail, isPlausiblePhone } from '../../lib/text';

// ---------------------------------------------------------------------------
// Small presentational helpers shared by the owner's detail screens
// (clients, client record, appointment, new appointment, money, settings).
// ---------------------------------------------------------------------------

/** "Grace Patel" → "GP", "Cher" → "C". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = Array.from(parts[0])[0] ?? '';
  const last = parts.length > 1 ? Array.from(parts[parts.length - 1])[0] ?? '' : '';
  return (first + last).toUpperCase();
}

const TONES = ['pink', 'lemon', 'lilac'] as const;

/** Initials in a soft pink, lemon or lilac circle; the same name always gets the same colour. Decorative. */
export function Avatar({ name, size = 'md' }: { name: string; size?: 'sm' | 'md' | 'lg' }) {
  let h = 0;
  for (const ch of name) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return <span className={`od-avatar od-avatar-${size} od-tone-${TONES[h % TONES.length]}`} aria-hidden="true">{initials(name)}</span>;
}

const GLYPHS: Record<string, ReactNode> = {
  bank: <><path d="M3.5 9.4 12 4.3l8.5 5.1" /><path d="M5.6 10.8v6.4M10 10.8v6.4M14 10.8v6.4M18.4 10.8v6.4M3.5 20h17" /></>,
  cash: <><rect x="2.8" y="6.3" width="18.4" height="11.8" rx="2.4" /><circle cx="12" cy="12.2" r="2.7" /><path d="M6.2 9.6v5.2M17.8 9.6v5.2" /></>,
  download: <><path d="M12 4.2v10.6M7.6 10.6 12 15l4.4-4.4" /><path d="M5 19.6h14" /></>,
  refund: <><path d="M8.6 6.4 4.6 10.4l4 4" /><path d="M4.8 10.4H14a5 5 0 0 1 0 10h-2.5" /></>,
  store: <><path d="M4.5 10.6V19a1.2 1.2 0 0 0 1.2 1.2h12.6a1.2 1.2 0 0 0 1.2-1.2v-8.4" /><path d="M3.4 9.2 5 4.2h14l1.6 5a2.5 2.5 0 0 1-4.3 1.9 2.6 2.6 0 0 1-4.3 0 2.6 2.6 0 0 1-4.3 0A2.5 2.5 0 0 1 3.4 9.2Z" /><path d="M10 20.2v-4.6h4v4.6" /></>,
  polish: <><rect x="6.6" y="11" width="10.8" height="9.8" rx="2.6" /><path d="M9.4 11V8.4h5.2V11M10.6 8.4V3.4h2.8v5" /></>,
  sliders: <><path d="M4 7h9.5M17.5 7H20M4 17h2.5M10.5 17H20" /><circle cx="15.5" cy="7" r="2" /><circle cx="8.5" cy="17" r="2" /></>,
  user: <><circle cx="12" cy="8.4" r="3.7" /><path d="M4.6 20c.9-3.8 3.9-5.9 7.4-5.9s6.5 2.1 7.4 5.9" /></>,
  pound: <><circle cx="12" cy="12" r="8.6" /><path d="M14.6 8.6a2.4 2.4 0 0 0-4.3 1.5v5.6M8.8 12.6h4.4M8.8 15.7h6.6" /></>,
  calendarOff: <><rect x="3.4" y="4.8" width="17.2" height="15.6" rx="3" /><path d="M3.4 9.6h17.2M8 2.8v3.8M16 2.8v3.8M9.8 12.6l4.4 4.4M14.2 12.6l-4.4 4.4" /></>,
  calendar: <><rect x="3.4" y="4.8" width="17.2" height="15.6" rx="3" /><path d="M3.4 9.6h17.2M8 2.8v3.8M16 2.8v3.8" /><path d="M8 13.4h.01M12 13.4h.01M16 13.4h.01M8 16.8h.01M12 16.8h.01" strokeWidth={2.4} /></>,
  doc: <><path d="M13.8 3.5H7.6A1.6 1.6 0 0 0 6 5.1v13.8a1.6 1.6 0 0 0 1.6 1.6h8.8a1.6 1.6 0 0 0 1.6-1.6V7.7Z" /><path d="M13.8 3.5v4.2H18M9 12.2h6M9 15.6h4.2" /></>,
  pencil: <><path d="M4.5 19.5 5.6 15 15.8 4.8a2 2 0 0 1 2.9 2.9L8.5 17.9Z" /><path d="M14 6.6l2.9 2.9" /></>,
  flask: <><path d="M9.4 3.6h5.2M10.4 3.6v5.3L5.6 17.4a2.1 2.1 0 0 0 1.8 3.1h9.2a2.1 2.1 0 0 0 1.8-3.1L13.6 8.9V3.6" /><path d="M7.4 14.4h9.2" /></>,
  globe: <><circle cx="12" cy="12" r="8.6" /><path d="M3.6 12h16.8M12 3.4c2.3 2.4 3.4 5.3 3.4 8.6s-1.1 6.2-3.4 8.6c-2.3-2.4-3.4-5.3-3.4-8.6s1.1-6.2 3.4-8.6Z" /></>,
  alert: <><circle cx="12" cy="12" r="8.6" /><path d="M12 7.6v5.4M12 16.4v.1" /></>,
  clock: <><circle cx="12" cy="12" r="8.6" /><path d="M12 7.4V12l3.1 2" /></>,
  receipt: <><path d="M6 3.6h12v16.8l-2-1.4-2 1.4-2-1.4-2 1.4-2-1.4-2 1.4Z" /><path d="M9 8.4h6M9 11.8h6M9 15.2h3.6" /></>,
  heart: <path d="M12.1 19.6s-7.3-4.3-8.6-9.1C2.6 7.3 4.6 4.7 7.6 4.7c1.9 0 3.4 1.1 4.5 2.8 1.1-1.7 2.6-2.8 4.5-2.8 3 0 5 2.6 4.1 5.8-1.3 4.8-8.6 9.1-8.6 9.1Z" />,
  lock: <><rect x="5" y="10.4" width="14" height="10" rx="2.4" /><path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" /></>,
  eye: <><path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12Z" /><circle cx="12" cy="12" r="2.8" /></>,
};

/** Line icons used on these screens (24px grid, currentColor). Decorative. */
export function Glyph({ name, size = 20 }: { name: keyof typeof GLYPHS | string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {GLYPHS[name]}
    </svg>
  );
}

// ---------------------------------------------------------------------------

export function Clients() {
  const { settings: s } = useOwner();
  const { data, error, loading } = useLoad(() => api.listClients(), []);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const [stale, setStale] = useState(false);
  const needle = q.trim().toLowerCase();
  // Clients not seen for 3+ years (or never, and added 6+ months ago) are due for deletion under the privacy notice.
  const isStale = (c: { last_visit: string | null; created_at: string }) => {
    const cutoff = (iso: string, days: number) => Date.now() - new Date(iso).getTime() > days * 86400e3;
    return c.last_visit ? cutoff(c.last_visit, 3 * 365) : cutoff(c.created_at, 183);
  };
  const staleCount = (data ?? []).filter(isStale).length;
  const list = (data ?? []).filter((c) => !stale || isStale(c)).filter((c) => !needle
    || c.full_name.toLowerCase().includes(needle)
    || (c.phone ?? '').replace(/\s/g, '').includes(needle.replace(/\s/g, ''))
    || (c.email ?? '').includes(needle));

  return (
    <div className="page od od-clients">
      <TopBar title="Clients" right={<button className="icon-btn" aria-label="Add client" onClick={() => setAdding(true)}><Icon name="plus" /></button>} />
      <div className="od-search">
        <input type="search" placeholder={`Search ${data?.length ?? ''} clients`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />
      </div>
      {staleCount > 0 && (
        <label className="check od-check-card">
          <input type="checkbox" checked={stale} onChange={(e) => setStale(e.target.checked)} />
          <span>Show only the {staleCount} client{staleCount === 1 ? '' : 's'} due for deletion<br />
            <span className="sub">Not seen for 3 years, or never visited and added over 6 months ago — your privacy notice says these are deleted.</span></span>
        </label>
      )}
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : (
        <div className="card tight od-client-list">
          {list.length === 0 ? <div className="empty">{needle ? 'No matches.' : 'No clients yet — they appear here when someone books.'}</div> : (
            <ul className="list">
              {list.map((c) => (
                <li key={c.id}>
                  <Link className="list-row od-client-row" to={`/clients/${c.id}`}>
                    <Avatar name={c.full_name} />
                    <div className="grow">
                      <div className="od-name-line">
                        <span className="title">{c.full_name}</span>
                        {c.allergies ? <span className="od-tag od-tag-allergy" title="Allergy noted">Allergy</span> : null}
                        {c.is_regular ? <span className="od-tag od-tag-regular">Regular</span> : null}
                      </div>
                      <div className="meta">{c.visits ? `${c.visits} visit${c.visits === 1 ? '' : 's'} · last ${fmtDay(c.last_visit!, s.timezone)}` : 'No completed visits yet'}</div>
                    </div>
                    <span className="chev"><Icon name="chev" size={18} /></span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {adding && <ClientSheet onClose={() => setAdding(false)} />}
    </div>
  );
}

export function ClientSheet({ initial, onClose, onSaved }: {
  initial?: { id: string; full_name: string; phone: string | null; email: string | null };
  onClose: () => void;
  onSaved?: () => void;
}) {
  const nav = useNavigate();
  const [f, setF] = useState({ full_name: initial?.full_name ?? '', phone: initial?.phone ?? '', email: initial?.email ?? '' });
  const { busy, error, run, setError } = useAction();
  async function save() {
    if (f.full_name.trim().length < 2) return setError(new Error('Enter a name.'));
    if (f.phone && !isPlausiblePhone(f.phone)) return setError(new Error('Check the mobile number.'));
    if (f.email && !isPlausibleEmail(f.email)) return setError(new Error('Check the email address.'));
    const body = { full_name: f.full_name.trim(), phone: f.phone.trim() || null, email: f.email.trim() || null };
    await run(async () => {
      if (initial) { await api.updateClient(initial.id, body); onSaved?.(); onClose(); }
      else { const c = await api.createClient(body); nav(`/clients/${c.id}`); }
    });
  }
  return (
    <Sheet title={initial ? 'Edit details' : 'New client'} onClose={onClose}>
      <div className="stack">
        <Field label="Full name"><input type="text" value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Mobile"><input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Sheet>
  );
}
