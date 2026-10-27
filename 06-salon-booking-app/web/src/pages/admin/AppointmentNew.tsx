import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Spinner, TopBar, useAction, useLoad } from '../../components/ui';
import { availableSlots } from '../../lib/slots';
import { addDays, fmtTime, minutesLabel, startOfDayInstant, todayInZone, zonedToInstant } from '../../lib/time';
import { isPlausibleEmail, isPlausiblePhone, money, parsePounds } from '../../lib/text';
import type { Client } from '../../lib/types';
import { Avatar } from './Clients';

export function AppointmentNew() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { data, error: loadError } = useLoad(async () => {
    const [clients, services, hours] = await Promise.all([api.listClients(), api.listServices(), api.listOpeningHours()]);
    return { clients, services: services.filter((x) => x.is_active), hours };
  }, []);

  // client
  const [clientId, setClientId] = useState<string | null>(params.get('client'));
  const [search, setSearch] = useState('');
  const [newClient, setNewClient] = useState(false);
  const [nc, setNc] = useState({ full_name: '', phone: '', email: '' });
  // treatment
  const [serviceId, setServiceId] = useState<string>('');
  const [custom, setCustom] = useState({ name: '', duration: '60', price: '' });
  // time
  const [day, setDay] = useState(params.get('d') ?? todayInZone(tz));
  const [time, setTime] = useState('');
  const [anyTime, setAnyTime] = useState(false);
  // extras
  const [askDeposit, setAskDeposit] = useState<boolean | null>(null);
  const [emailConfirm, setEmailConfirm] = useState(true);
  const [notes, setNotes] = useState('');
  const [visits, setVisits] = useState<number | null>(null);
  const { busy, error, run, setError } = useAction();

  const service = data?.services.find((x) => x.id === serviceId);
  const duration = service ? service.duration_min : Number(custom.duration) || 0;
  const client: Client | undefined = data?.clients.find((c) => c.id === clientId);

  useEffect(() => {
    if (!data || serviceId) return;
    if (data.services[0]) setServiceId(data.services[0].id);
    else setServiceId('custom');
  }, [data, serviceId]);

  useEffect(() => {
    let live = true; // ignore a late answer for a client who has since been swapped
    setVisits(null);
    if (clientId) api.countCompletedVisits(clientId).then((n) => live && setVisits(n)).catch(() => live && setVisits(0));
    return () => { live = false; };
  }, [clientId]);

  const isNew = newClient || (visits === 0 && !client?.is_regular);
  const depositOn = askDeposit ?? (isNew && s.deposit_amount_pence > 0);

  const { data: busy7 } = useLoad(
    () => api.getBusyTimes(startOfDayInstant(day, tz), startOfDayInstant(addDays(day, 1), tz)), [day]);
  const slots = useMemo(() => {
    if (!data || !busy7 || !duration) return [];
    return availableSlots(day, duration, { ...s, hours: data.hours }, busy7, new Date(), { ignoreNotice: true })
      .filter((d) => d.getTime() > Date.now() - 12 * 3600e3);
  }, [data, busy7, day, duration, s]);

  const matches = (data?.clients ?? []).filter((c) => {
    const q = search.trim().toLowerCase();
    if (!q) return false;
    return c.full_name.toLowerCase().includes(q) || (c.phone ?? '').replace(/\s/g, '').includes(q.replace(/\s/g, '')) || (c.email ?? '').includes(q);
  }).slice(0, 6);

  async function save() {
    setError(null);
    if (!time) return setError(new Error('Pick a time.'));
    if (!duration || duration < 5) return setError(new Error('Set how long the appointment takes.'));
    const name = service ? service.name : custom.name.trim();
    if (!name) return setError(new Error('Name the treatment.'));
    const price = service ? service.price_pence : custom.price ? parsePounds(custom.price) : 0;
    if (price === null) return setError(new Error('Check the price.'));
    if (newClient) {
      if (nc.full_name.trim().length < 2) return setError(new Error('Enter the client’s name.'));
      if (nc.phone && !isPlausiblePhone(nc.phone)) return setError(new Error('Check the mobile number.'));
      if (nc.email && !isPlausibleEmail(nc.email)) return setError(new Error('Check the email address.'));
    } else if (!clientId) return setError(new Error('Choose a client, or add a new one.'));
    else if (visits === null) return setError(new Error('One moment — still checking this client’s history.'));

    await run(async () => {
      let c = client!;
      if (newClient) {
        c = await api.createClient({ full_name: nc.full_name.trim(), phone: nc.phone.trim() || null, email: nc.email.trim() || null });
        // From here on she's an existing client, so a retry (say after a clash) won't add her twice.
        setNewClient(false);
        setClientId(c.id);
        setVisits(0);
        if (data) data.clients.push({ ...c, last_visit: null, visits: 0 });
      }
      const starts = zonedToInstant(day, time, tz);
      const deposit = depositOn ? s.deposit_amount_pence : 0;
      const a = await api.createAppointment({
        client_id: c.id, service_id: service?.id ?? null, service_name: name, price_pence: price, duration_min: duration,
        starts_at: starts.toISOString(), status: deposit > 0 ? 'pending_deposit' : 'confirmed', is_new_client: isNew,
        deposit_required_pence: deposit,
        deposit_due_at: deposit > 0 ? new Date(Math.min(Date.now() + s.deposit_deadline_hours * 3600e3, starts.getTime())).toISOString() : null,
        owner_notes: notes.trim() || null,
      });
      if (emailConfirm && c.email) await api.queueEmail(a.id, 'booking_received').catch(() => {});
      nav(`/appointments/${a.id}`, { replace: true });
    });
  }

  if (loadError) return <div className="page"><TopBar title="New appointment" back /><ErrorBox error={loadError} /></div>;
  if (!data) return <Spinner />;
  const hasEmail = newClient ? !!nc.email.trim() : !!client?.email;

  return (
    <div className="page stack od od-new">
      <TopBar title="New appointment" back />

      <div className={`card stack od-step${(client && !newClient) ? ' done' : ''}`}>
        <div className="od-step-head"><StepNum n={1} /><h3>Client</h3></div>
        {client && !newClient ? (
          <div className="od-picked">
            <Avatar name={client.full_name} />
            <div className="grow"><div className="od-picked-name">{client.full_name}</div><div className="sub">{client.phone || client.email || ''}{visits !== null && ` · ${visits ? `${visits} visit${visits === 1 ? '' : 's'}` : client.is_regular ? 'Regular' : 'New client'}`}</div></div>
            <button className="btn small" onClick={() => setClientId(null)}>Change</button>
          </div>
        ) : newClient ? (
          <>
            <Field label="Full name"><input type="text" autoComplete="off" value={nc.full_name} onChange={(e) => setNc({ ...nc, full_name: e.target.value })} /></Field>
            <Field label="Mobile"><input type="tel" value={nc.phone} onChange={(e) => setNc({ ...nc, phone: e.target.value })} /></Field>
            <Field label="Email (for confirmations)"><input type="email" value={nc.email} onChange={(e) => setNc({ ...nc, email: e.target.value })} /></Field>
            <button className="btn ghost" onClick={() => setNewClient(false)}>Choose an existing client instead</button>
          </>
        ) : (
          <>
            <Field label="Search by name or number">
              <input type="search" value={search} autoFocus onChange={(e) => setSearch(e.target.value)} placeholder="e.g. Amelia or 07700" />
            </Field>
            {matches.length > 0 && (
              <ul className="list card tight od-matches">
                {matches.map((c) => (
                  <li key={c.id}><button className="list-row" onClick={() => { setClientId(c.id); setSearch(''); }}>
                    <Avatar name={c.full_name} size="sm" />
                    <div className="grow"><div className="title">{c.full_name}</div><div className="meta">{c.phone || c.email}</div></div>
                    <span className="chev"><Icon name="chev" size={18} /></span>
                  </button></li>
                ))}
              </ul>
            )}
            <button className="btn od-new-client" onClick={() => { setNewClient(true); setNc({ ...nc, full_name: search }); }}><Icon name="plus" size={20} /> New client</button>
          </>
        )}
      </div>

      <div className="card stack od-step done">
        <div className="od-step-head"><StepNum n={2} /><h3>Treatment</h3></div>
        <Field label="Treatment">
          <select value={serviceId} onChange={(e) => { setServiceId(e.target.value); setTime(''); }}>
            {data.services.map((v) => <option key={v.id} value={v.id}>{v.name} · {minutesLabel(v.duration_min)} · {money(v.price_pence)}</option>)}
            <option value="custom">Something else…</option>
          </select>
        </Field>
        {serviceId === 'custom' && (
          <>
            <Field label="Name"><input type="text" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} /></Field>
            <div className="row">
              <Field label="Minutes"><input type="number" inputMode="numeric" min={5} step={5} value={custom.duration} onChange={(e) => setCustom({ ...custom, duration: e.target.value })} /></Field>
              <Field label="Price (£)"><input type="text" inputMode="decimal" value={custom.price} onChange={(e) => setCustom({ ...custom, price: e.target.value })} /></Field>
            </div>
          </>
        )}
      </div>

      <div className={`card stack od-step${time ? ' done' : ''}`}>
        <div className="od-step-head"><StepNum n={3} /><h3>When</h3></div>
        <Field label="Date"><input type="date" value={day} onChange={(e) => { setDay(e.target.value); setTime(''); }} /></Field>
        {anyTime ? (
          <Field label="Start time" hint="Any time you like — the diary still stops double-bookings.">
            <input type="time" step={300} value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        ) : (
          <>
            <span className="od-slots-label">Free times for a {minutesLabel(duration || 0)} appointment:</span>
            {slots.length ? (
              <div className="slot-grid">
                {slots.map((d) => {
                  const t = fmtTime(d, tz);
                  return <button key={t} className={`slot${time === t ? ' on' : ''}`} onClick={() => setTime(t)}>{t}</button>;
                })}
              </div>
            ) : <div className="sub od-no-slots">No free times inside opening hours.</div>}
          </>
        )}
        <button className="btn ghost small od-any-time" onClick={() => setAnyTime(!anyTime)}>{anyTime ? 'Show free times' : 'Outside opening hours / pick any time'}</button>
      </div>

      <div className="card stack od-step">
        <div className="od-step-head"><StepNum n={4} /><h3>Last details</h3></div>
        {s.deposit_amount_pence > 0 && (
          <label className="check">
            <input type="checkbox" checked={depositOn} onChange={(e) => setAskDeposit(e.target.checked)} />
            <span>Ask for a {money(s.deposit_amount_pence)} deposit by bank transfer{isNew ? ' (new client)' : ''}</span>
          </label>
        )}
        {hasEmail && (
          <label className="check">
            <input type="checkbox" checked={emailConfirm} onChange={(e) => setEmailConfirm(e.target.checked)} />
            <span>Email a confirmation to the client</span>
          </label>
        )}
        <Field label="Notes (only you see these)"><textarea value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>

      <ErrorBox error={error} />
      <button className="btn primary block od-add" disabled={busy} onClick={save}><Icon name="plus" size={20} /> {busy ? 'Saving…' : 'Add to diary'}</button>
    </div>
  );
}

/** The step's number in a pink circle (a tick once the step is filled in). Decorative: the heading names the step. */
function StepNum({ n }: { n: number }) {
  return <span className="od-step-num" aria-hidden="true"><span>{n}</span></span>;
}
