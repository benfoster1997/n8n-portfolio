import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { resetDemo } from '../../api/demoApi';
import { useOwner } from '../../components/owner';
import { BlockTimeSheet } from './Diary';
import { ErrorBox, Field, Icon, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { DEFAULT_TEMPLATES, TEMPLATE_PLACEHOLDERS, downloadText, friendlyError, isPlausibleEmail, money, parsePounds } from '../../lib/text';
import { WEEKDAY_NAMES, fmtDayTime, minutesLabel, todayInZone } from '../../lib/time';
import type { OpeningHours, Service, Settings as S } from '../../lib/types';

const SECTIONS = [
  { to: 'business', label: 'Business details', sub: 'Name, booking page text, your email' },
  { to: 'hours', label: 'Opening hours', sub: 'When clients can book' },
  { to: 'services', label: 'Treatments & prices', sub: 'What clients can book' },
  { to: 'time-off', label: 'Time off', sub: 'Holidays and blocked time' },
  { to: 'rules', label: 'Booking rules', sub: 'Notice, gaps, how far ahead' },
  { to: 'deposits', label: 'Deposits & bank details', sub: 'For new clients, by bank transfer' },
  { to: 'messages', label: 'WhatsApp messages', sub: 'Wording of reminders' },
  { to: 'email', label: 'Email confirmations & reminders', sub: 'Free, sent from your Gmail' },
  { to: 'backup', label: 'Back up your data', sub: 'Download everything' },
  { to: 'account', label: 'Account', sub: 'Password, sign out' },
];

export function SettingsHome() {
  const { session, settings: s } = useOwner();
  return (
    <div className="page">
      <TopBar title="Settings" />
      <div className="card tight"><ul className="list">
        {SECTIONS.map((x) => (
          <li key={x.to}><Link className="list-row" to={`/settings/${x.to}`}>
            <div className="grow"><div className="title">{x.label}</div><div className="meta">{x.sub}</div></div>
            <span className="chev"><Icon name="chev" size={18} /></span>
          </Link></li>
        ))}
      </ul></div>
      <div className="section-title">For clients</div>
      <div className="card tight"><ul className="list">
        <li><Link className="list-row" to="/book"><div className="grow"><div className="title">Your booking page</div><div className="meta">{s.booking_enabled ? 'Open for bookings' : 'Paused'}</div></div><span className="chev"><Icon name="chev" size={18} /></span></Link></li>
        <li><Link className="list-row" to="/privacy"><div className="grow"><div className="title">Privacy notice</div><div className="meta">What clients are told about their data</div></div><span className="chev"><Icon name="chev" size={18} /></span></Link></li>
      </ul></div>
      <p className="sub centre" style={{ marginTop: 16 }}>Signed in as {session.email}</p>
    </div>
  );
}

/** Shared form shell for the simple settings pages. */
function useSettingsForm<K extends keyof S>(keys: K[]) {
  const { settings, setSettings } = useOwner();
  const [draft, setDraft] = useState(() => Object.fromEntries(keys.map((k) => [k, settings[k]])) as Pick<S, K>);
  const { busy, error, run, setError } = useAction();
  const toast = useToast();
  const save = (patch: Partial<S> = draft) => run(async () => { setSettings(await api.updateSettings(patch)); toast('Saved'); });
  const set = <T extends K>(k: T, v: S[T]) => setDraft((d) => ({ ...d, [k]: v }));
  return { draft, set, save, busy, error, setError };
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  return <div className="page stack"><TopBar title={title} back="/settings" />{children}</div>;
}

const txt = (v: string | null | undefined) => v ?? '';

export function BusinessSettings() {
  const f = useSettingsForm(['business_name', 'legal_name', 'booking_intro', 'location_note', 'address', 'owner_email', 'owner_phone', 'public_site_url', 'booking_enabled']);
  const d = f.draft;
  async function submit() {
    if (!d.business_name.trim()) return f.setError(new Error('Enter your business name.'));
    if (d.owner_email && !isPlausibleEmail(d.owner_email)) return f.setError(new Error('Check your email address.'));
    if (d.public_site_url && !/^(https:\/\/[^\s/]+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)/i.test(d.public_site_url.trim()))
      return f.setError(new Error('The web address must start with https:// — tap “Use …” below to fill it in.'));
    await f.save({ ...d, business_name: d.business_name.trim(), public_site_url: d.public_site_url ? d.public_site_url.trim().replace(/\/$/, '') : null });
  }
  return (
    <Page title="Business details">
      <Field label="Business name"><input type="text" value={d.business_name} maxLength={80} onChange={(e) => f.set('business_name', e.target.value)} /></Field>
      <Field label="Your legal name" hint="Shown in the privacy notice as the person responsible for client data.">
        <input type="text" autoComplete="name" value={txt(d.legal_name)} maxLength={100} onChange={(e) => f.set('legal_name', e.target.value)} />
      </Field>
      <Field label="Booking page welcome" hint="A line or two shown above your treatments."><textarea value={txt(d.booking_intro)} maxLength={1000} onChange={(e) => f.set('booking_intro', e.target.value)} /></Field>
      <Field label="Area (shown publicly)" hint="e.g. “South Woodham Ferrers — full address in your confirmation”">
        <input type="text" value={txt(d.location_note)} maxLength={200} onChange={(e) => f.set('location_note', e.target.value)} />
      </Field>
      <Field label="Full address (only in confirmation emails)"><textarea value={txt(d.address)} maxLength={300} onChange={(e) => f.set('address', e.target.value)} /></Field>
      <Field label="Your email" hint="New booking alerts go here, and clients’ replies come here."><input type="email" value={txt(d.owner_email)} onChange={(e) => f.set('owner_email', e.target.value)} /></Field>
      <Field label="Your mobile (optional)" hint="Shown in emails so clients can WhatsApp you."><input type="tel" value={txt(d.owner_phone)} onChange={(e) => f.set('owner_phone', e.target.value)} /></Field>
      <Field label="This app’s web address" hint="Used for the booking and form links in emails.">
        <input type="text" inputMode="url" value={txt(d.public_site_url)} placeholder="https://…" onChange={(e) => f.set('public_site_url', e.target.value)} />
      </Field>
      <button className="btn small" onClick={() => f.set('public_site_url', window.location.origin)}>Use {window.location.host}</button>
      <label className="check"><input type="checkbox" checked={d.booking_enabled} onChange={(e) => f.set('booking_enabled', e.target.checked)} />
        <span>Online booking is open<br /><span className="sub">Untick to pause new online bookings (e.g. while you’re away).</span></span></label>
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy} onClick={submit}>{f.busy ? 'Saving…' : 'Save'}</button>
    </Page>
  );
}

export function RulesSettings() {
  const f = useSettingsForm(['slot_interval_min', 'buffer_min', 'min_notice_hours', 'max_days_ahead', 'reminder_hours_before']);
  const d = f.draft;
  const num = (k: keyof typeof d, label: string, hint: string, min: number, max: number, step = 1) => (
    <Field label={label} hint={hint}>
      <input type="number" inputMode="numeric" min={min} max={max} step={step} value={d[k]} onChange={(e) => f.set(k, Number(e.target.value) as never)} />
    </Field>
  );
  return (
    <Page title="Booking rules">
      {num('slot_interval_min', 'Start times every (minutes)', 'Clients can start on the hour and every 15 minutes, for example.', 5, 120, 5)}
      {num('buffer_min', 'Gap after each appointment (minutes)', 'Time to clean up and set up for the next client.', 0, 120, 5)}
      {num('min_notice_hours', 'Minimum notice (hours)', 'How soon before an appointment clients can book online.', 0, 336)}
      {num('max_days_ahead', 'Book up to (days ahead)', 'How far into the future clients can book.', 1, 365)}
      {num('reminder_hours_before', 'Reminder email (hours before)', 'When the automatic reminder email goes out.', 2, 168)}
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy} onClick={() => f.save()}>{f.busy ? 'Saving…' : 'Save'}</button>
    </Page>
  );
}

export function DepositSettings() {
  const f = useSettingsForm(['deposit_amount_pence', 'deposit_deadline_hours', 'auto_cancel_unpaid', 'bank_account_name', 'bank_sort_code', 'bank_account_number', 'cancellation_policy']);
  const d = f.draft;
  const [amount, setAmount] = useState((d.deposit_amount_pence / 100).toFixed(2));
  async function submit() {
    const pence = parsePounds(amount || '0');
    if (pence === null) return f.setError(new Error('Check the deposit amount.'));
    if (pence > 0 && (!d.bank_account_name || !d.bank_sort_code || !d.bank_account_number)) return f.setError(new Error('Add your bank details so new clients know where to pay.'));
    await f.save({ ...d, deposit_amount_pence: pence });
  }
  return (
    <Page title="Deposits & bank details">
      <p className="sub">New clients (anyone who hasn’t had a completed appointment) are asked for this deposit by bank transfer. Returning clients aren’t. Set £0 to switch deposits off.</p>
      <Field label="Deposit (£)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
      <Field label="Pay within (hours)" hint="Shown to the client."><input type="number" inputMode="numeric" min={1} max={336} value={d.deposit_deadline_hours} onChange={(e) => f.set('deposit_deadline_hours', Number(e.target.value))} /></Field>
      <label className="check">
        <input type="checkbox" checked={d.auto_cancel_unpaid} onChange={(e) => f.set('auto_cancel_unpaid', e.target.checked)} />
        <span>Release the slot automatically if the deposit hasn’t arrived in time<br />
          <span className="sub">The client is emailed. Leave this off to decide yourself — late ones are flagged on Today. Remember to mark deposits received promptly if it’s on.</span></span>
      </label>
      <div className="section-title">Bank details (sent only to clients who owe a deposit)</div>
      <Field label="Account name"><input type="text" value={txt(d.bank_account_name)} maxLength={80} onChange={(e) => f.set('bank_account_name', e.target.value)} /></Field>
      <div className="row">
        <Field label="Sort code"><input type="text" inputMode="numeric" value={txt(d.bank_sort_code)} maxLength={20} placeholder="00-00-00" onChange={(e) => f.set('bank_sort_code', e.target.value)} /></Field>
        <Field label="Account number"><input type="text" inputMode="numeric" value={txt(d.bank_account_number)} maxLength={20} onChange={(e) => f.set('bank_account_number', e.target.value)} /></Field>
      </div>
      <Field label="Cancellation policy" hint="Shown at the top of your booking page and in every confirmation and reminder email. Clients must tick to agree to it before they can book, and each booking keeps a copy of the wording they agreed to.">
        <textarea value={txt(d.cancellation_policy)} maxLength={1000} style={{ minHeight: 110 }} onChange={(e) => f.set('cancellation_policy', e.target.value)} />
      </Field>
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy} onClick={submit}>{f.busy ? 'Saving…' : 'Save'}</button>
    </Page>
  );
}

export function HoursSettings() {
  const { data, error, loading } = useLoad(() => api.listOpeningHours(), []);
  const [rows, setRows] = useState<OpeningHours[] | null>(null);
  const { busy, error: saveError, run, setError } = useAction();
  const toast = useToast();
  const list = rows ?? data ?? [];
  const upd = (i: number, patch: Partial<OpeningHours>) => setRows(list.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  async function save() {
    for (const r of list) {
      if (r.close_time <= r.open_time) return setError(new Error(`${WEEKDAY_NAMES[r.weekday]}: closing time must be after opening time.`));
      if ((r.break_start && !r.break_end) || (!r.break_start && r.break_end)) return setError(new Error(`${WEEKDAY_NAMES[r.weekday]}: give the break a start and an end.`));
      if (r.break_start && r.break_end && (r.break_end <= r.break_start || r.break_start < r.open_time || r.break_end > r.close_time))
        return setError(new Error(`${WEEKDAY_NAMES[r.weekday]}: the break must be inside opening hours.`));
    }
    if (await run(() => api.saveOpeningHours(list))) toast('Opening hours saved');
  }
  if (loading && !data) return <Spinner />;
  return (
    <Page title="Opening hours">
      <ErrorBox error={error} />
      {list.map((r, i) => (
        <div className="card stack" key={r.weekday}>
          <label className="check" style={{ padding: 0 }}>
            <input type="checkbox" checked={r.is_open} onChange={(e) => upd(i, { is_open: e.target.checked })} />
            <strong>{WEEKDAY_NAMES[r.weekday]}</strong>{!r.is_open && <span className="sub">Closed</span>}
          </label>
          {r.is_open && (
            <>
              <div className="row">
                <Field label="Opens"><input type="time" step={300} value={r.open_time} onChange={(e) => upd(i, { open_time: e.target.value })} /></Field>
                <Field label="Closes"><input type="time" step={300} value={r.close_time} onChange={(e) => upd(i, { close_time: e.target.value })} /></Field>
              </div>
              <div className="row">
                <Field label="Break from"><input type="time" step={300} value={r.break_start ?? ''} onChange={(e) => upd(i, { break_start: e.target.value || null })} /></Field>
                <Field label="Break to"><input type="time" step={300} value={r.break_end ?? ''} onChange={(e) => upd(i, { break_end: e.target.value || null })} /></Field>
              </div>
            </>
          )}
        </div>
      ))}
      <ErrorBox error={saveError} />
      <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save opening hours'}</button>
    </Page>
  );
}

export function ServicesSettings() {
  const { data, error, loading, reload } = useLoad(() => api.listServices(), []);
  const [edit, setEdit] = useState<Partial<Service> | null>(null);
  if (loading && !data) return <Spinner />;
  const active = (data ?? []).filter((x) => x.is_active);
  const old = (data ?? []).filter((x) => !x.is_active);
  return (
    <Page title="Treatments & prices">
      <ErrorBox error={error} />
      <button className="btn primary block" onClick={() => setEdit({ name: '', duration_min: 60, price_pence: 0, online_bookable: true, is_active: true, sort_order: (data?.length ?? 0) + 1 })}>
        <Icon name="plus" size={20} /> Add a treatment
      </button>
      <div className="card tight">
        {active.length === 0 ? <div className="empty">No treatments yet.</div> : (
          <ul className="list">{active.map((v) => (
            <li key={v.id}><button className="list-row" onClick={() => setEdit(v)}>
              <div className="grow"><div className="title">{v.name}</div><div className="meta">{minutesLabel(v.duration_min)} · {money(v.price_pence)}{!v.online_bookable && ' · not bookable online'}</div></div>
              <span className="chev"><Icon name="chev" size={18} /></span>
            </button></li>
          ))}</ul>
        )}
      </div>
      {old.length > 0 && <>
        <div className="section-title">Hidden</div>
        <div className="card tight"><ul className="list">{old.map((v) => (
          <li key={v.id}><button className="list-row" onClick={() => setEdit(v)}><div className="grow"><div className="title">{v.name}</div><div className="meta">Not offered</div></div></button></li>
        ))}</ul></div>
      </>}
      {edit && <ServiceSheet initial={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </Page>
  );
}

function ServiceSheet({ initial, onClose, onSaved }: { initial: Partial<Service>; onClose: () => void; onSaved: () => void }) {
  const [f, setF] = useState({
    name: initial.name ?? '', description: initial.description ?? '', duration: String(initial.duration_min ?? 60),
    price: initial.price_pence !== undefined ? (initial.price_pence / 100).toFixed(2) : '', online: initial.online_bookable ?? true,
    active: initial.is_active ?? true, sort: String(initial.sort_order ?? 0),
  });
  const { busy, error, run, setError } = useAction();
  async function save() {
    const price = parsePounds(f.price || '0');
    const duration = Number(f.duration);
    if (!f.name.trim()) return setError(new Error('Name the treatment.'));
    if (!duration || duration < 5 || duration > 600) return setError(new Error('Length must be between 5 and 600 minutes.'));
    if (price === null) return setError(new Error('Check the price.'));
    if (await run(() => api.saveService({
      ...(initial.id ? { id: initial.id } : {}), name: f.name.trim(), description: f.description.trim() || null,
      duration_min: duration, price_pence: price, online_bookable: f.online, is_active: f.active, sort_order: Number(f.sort) || 0,
    }))) onSaved();
  }
  return (
    <Sheet title={initial.id ? 'Edit treatment' : 'New treatment'} onClose={onClose}>
      <div className="stack">
        <Field label="Name"><input type="text" value={f.name} maxLength={80} placeholder="e.g. BIAB infill" onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description (optional)"><textarea value={f.description} maxLength={500} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div className="row">
          <Field label="Minutes" hint="Including removal if needed"><input type="number" inputMode="numeric" min={5} step={5} value={f.duration} onChange={(e) => setF({ ...f, duration: e.target.value })} /></Field>
          <Field label="Price (£)"><input type="text" inputMode="decimal" value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} /></Field>
        </div>
        <Field label="Order on booking page" hint="Lower numbers first"><input type="number" inputMode="numeric" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></Field>
        <label className="check"><input type="checkbox" checked={f.online} onChange={(e) => setF({ ...f, online: e.target.checked })} /><span>Clients can book this online</span></label>
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /><span>Offered (untick to hide it without losing history)</span></label>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Sheet>
  );
}

export function TimeOffSettings() {
  const { settings: s } = useOwner();
  const toast = useToast();
  const tz = s.timezone;
  const { data, error, loading, reload } = useLoad(() => api.listTimeOff(new Date().toISOString()), []);
  const [adding, setAdding] = useState(false);
  if (loading && !data) return <Spinner />;
  return (
    <Page title="Time off">
      <ErrorBox error={error} />
      <button className="btn primary block" onClick={() => setAdding(true)}><Icon name="plus" size={20} /> Block time</button>
      <div className="card tight">
        {(data ?? []).length === 0 ? <div className="empty">No time off coming up.</div> : (
          <ul className="list">{(data ?? []).map((t) => (
            <li key={t.id} className="list-row">
              <div className="grow"><div className="title">{t.note || 'Time off'}</div><div className="meta">{fmtDayTime(t.starts_at, tz)} → {fmtDayTime(t.ends_at, tz)}</div></div>
              <button className="icon-btn" aria-label="Remove" onClick={async () => {
                if (!window.confirm('Remove this time off? Clients will be able to book it.')) return;
                try { await api.deleteTimeOff(t.id); reload(); } catch (e) { toast(friendlyError(e)); }
              }}><Icon name="trash" size={20} /></button>
            </li>
          ))}</ul>
        )}
      </div>
      {adding && <BlockTimeSheet day={todayInZone(tz)} tz={tz} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
    </Page>
  );
}

export function MessageSettings() {
  const f = useSettingsForm(['wa_template_reminder', 'wa_template_deposit', 'wa_template_confirmed']);
  const d = f.draft;
  const box = (k: 'wa_template_reminder' | 'wa_template_deposit' | 'wa_template_confirmed', label: string, def: string) => (
    <Field label={label}>
      <textarea style={{ minHeight: 130 }} value={d[k] ?? def} maxLength={1000} onChange={(e) => f.set(k, e.target.value)} />
      <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => f.set(k, null)}>Reset to default</button>
    </Field>
  );
  return (
    <Page title="WhatsApp messages">
      <p className="sub">These fill in automatically when you tap a WhatsApp button. Words in curly brackets are swapped for the real details:</p>
      <p className="mono" style={{ fontSize: '0.82rem' }}>{TEMPLATE_PLACEHOLDERS.join(' ')}</p>
      {box('wa_template_reminder', 'Reminder', DEFAULT_TEMPLATES.reminder)}
      {box('wa_template_deposit', 'Deposit request', DEFAULT_TEMPLATES.deposit)}
      {box('wa_template_confirmed', 'Booking confirmed', DEFAULT_TEMPLATES.confirmed)}
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy}
        onClick={() => f.save({
          wa_template_reminder: d.wa_template_reminder && d.wa_template_reminder !== DEFAULT_TEMPLATES.reminder ? d.wa_template_reminder : null,
          wa_template_deposit: d.wa_template_deposit && d.wa_template_deposit !== DEFAULT_TEMPLATES.deposit ? d.wa_template_deposit : null,
          wa_template_confirmed: d.wa_template_confirmed && d.wa_template_confirmed !== DEFAULT_TEMPLATES.confirmed ? d.wa_template_confirmed : null,
        })}>
        {f.busy ? 'Saving…' : 'Save'}
      </button>
    </Page>
  );
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function EmailSettings() {
  const { settings: s, setSettings } = useOwner();
  const [secret, setSecret] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const toast = useToast();
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  const copy = async (t: string, what: string) => {
    try { await navigator.clipboard.writeText(t); toast(`${what} copied`); } catch { window.prompt(`Copy the ${what.toLowerCase()}:`, t); }
  };

  async function makeSecret() {
    if (s.email_secret_hash && !window.confirm('Make a new secret? The old one stops working, so you’ll need to paste the new one into the email script.')) return;
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    const value = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    await run(async () => {
      setSettings(await api.updateSettings({ email_secret_hash: await sha256Hex(value) }));
      setSecret(value);
    });
  }

  const lastPoll = s.email_last_poll_at ? new Date(s.email_last_poll_at) : null;
  const healthy = lastPoll && Date.now() - lastPoll.getTime() < 3 * 3600e3;
  return (
    <Page title="Email confirmations & reminders">
      <div className={`notice${s.email_secret_hash && !healthy ? ' warn' : ''}`}>
        {!s.email_secret_hash ? 'Not set up yet.' : lastPoll ? <>Email sender last checked in {fmtDayTime(lastPoll, s.timezone)}{healthy ? ' — working.' : ' — that’s a while ago; check the script is still running.'}</> : 'Secret created — waiting for the email script to check in.'}
      </div>
      <p>Emails are sent free from your own Gmail by a small Google script that checks for new emails every 10 minutes. Clients get:</p>
      <ul className="sub">
        <li>a booking confirmation (with bank details if they owe a deposit, and the consultation form link if they’re new)</li>
        <li>a “you’re confirmed” email when you mark their deposit received</li>
        <li>a reminder {s.reminder_hours_before} hours before</li>
        <li>a cancellation notice if you cancel</li>
      </ul>
      <p>You get an email for every new online booking{s.owner_email ? ` (to ${s.owner_email})` : ' — add your email in Business details'}.</p>
      <div className="section-title">Set-up values for the script</div>
      <div className="card stack">
        <div><div className="sub">SUPABASE_URL</div><div className="mono" style={{ overflowWrap: 'anywhere' }}>{url || '— (demo mode)'}</div></div>
        {url && <button className="btn small" onClick={() => copy(url, 'URL')}>Copy URL</button>}
        <div><div className="sub">SUPABASE_ANON_KEY</div><div className="mono" style={{ overflowWrap: 'anywhere', fontSize: '0.75rem' }}>{key ? `${key.slice(0, 24)}…` : '— (demo mode)'}</div></div>
        {key && <button className="btn small" onClick={() => copy(key, 'Key')}>Copy key</button>}
        <div><div className="sub">EMAIL_SECRET</div>
          {secret ? <div className="mono" style={{ overflowWrap: 'anywhere' }}>{secret}</div> : <div className="sub">{s.email_secret_hash ? 'Hidden — make a new one if you’ve lost it.' : 'Not created yet.'}</div>}
        </div>
        {secret && <><button className="btn small" onClick={() => copy(secret, 'Secret')}>Copy secret</button>
          <div className="notice warn">Copy it now — it’s shown only once and never stored. Paste it into the script’s settings.</div></>}
        <button className="btn primary" disabled={busy} onClick={makeSecret}>{s.email_secret_hash ? 'Make a new secret' : 'Create the secret'}</button>
        <ErrorBox error={error} />
      </div>
      <p className="sub">Step-by-step instructions are in the setup guide (SETUP.md, section “Emails”).</p>
    </Page>
  );
}

export function BackupSettings() {
  const { busy, error, run } = useAction();
  const toast = useToast();
  return (
    <Page title="Back up your data">
      <p>Download everything — clients, appointments, forms, patch tests, takings and settings — as one file. Keep it somewhere private (it contains health information). Photos aren’t included in the file.</p>
      <p className="sub">The free database plan keeps its own backups only for a short time, so download one now and then, e.g. at the start of each month.</p>
      <ErrorBox error={error} />
      <button className="btn primary block" disabled={busy} onClick={() => run(async () => {
        const all = await api.exportAll();
        downloadText(`bookings-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(all, null, 2), 'application/json');
        toast('Backup downloaded');
      })}>{busy ? 'Preparing…' : 'Download backup'}</button>
    </Page>
  );
}

export function AccountSettings() {
  const { session } = useOwner();
  const [pw, setPw] = useState('');
  const [sheet, setSheet] = useState(false);
  const { busy, error, run, setError } = useAction();
  const toast = useToast();
  return (
    <Page title="Account">
      <div className="card"><dl className="kv"><dt>Signed in as</dt><dd>{session.email}</dd></dl></div>
      <button className="btn" onClick={() => setSheet(true)}>Change password</button>
      <button className="btn danger" onClick={() => api.signOut()}>Sign out</button>
      {api.mode === 'demo' && (
        <button className="btn" onClick={() => { if (window.confirm('Reset the demo to its starting data?')) { resetDemo(); window.location.href = '/'; } }}>Reset demo data</button>
      )}
      {sheet && (
        <Sheet title="Change password" onClose={() => setSheet(false)}>
          <div className="stack">
            <Field label="New password" hint="At least 10 characters."><input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
            <ErrorBox error={error} />
            <button className="btn primary block" disabled={busy} onClick={async () => {
              if (pw.length < 10) return setError(new Error('Use at least 10 characters.'));
              if (await run(() => api.updatePassword(pw))) { setSheet(false); setPw(''); toast('Password changed'); }
            }}>Save password</button>
          </div>
        </Sheet>
      )}
    </Page>
  );
}
