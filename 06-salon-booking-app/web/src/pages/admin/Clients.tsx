import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Sheet, Spinner, TopBar, useAction, useLoad } from '../../components/ui';
import { fmtDay } from '../../lib/time';
import { isPlausibleEmail, isPlausiblePhone } from '../../lib/text';

export function Clients() {
  const { settings: s } = useOwner();
  const { data, error, loading } = useLoad(() => api.listClients(), []);
  const [q, setQ] = useState('');
  const [adding, setAdding] = useState(false);
  const needle = q.trim().toLowerCase();
  const list = (data ?? []).filter((c) => !needle
    || c.full_name.toLowerCase().includes(needle)
    || (c.phone ?? '').replace(/\s/g, '').includes(needle.replace(/\s/g, ''))
    || (c.email ?? '').includes(needle));

  return (
    <div className="page">
      <TopBar title="Clients" right={<button className="icon-btn" aria-label="Add client" onClick={() => setAdding(true)}><Icon name="plus" /></button>} />
      <input type="search" placeholder={`Search ${data?.length ?? ''} clients`} value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search clients" />
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : (
        <div className="card tight" style={{ marginTop: 12 }}>
          {list.length === 0 ? <div className="empty">{needle ? 'No matches.' : 'No clients yet — they appear here when someone books.'}</div> : (
            <ul className="list">
              {list.map((c) => (
                <li key={c.id}>
                  <Link className="list-row" to={`/clients/${c.id}`}>
                    <div className="grow">
                      <div className="title">{c.full_name}{c.allergies ? <span className="flag" title="Allergy noted"> ⚠︎</span> : null}</div>
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
