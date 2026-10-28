import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { resetDemo } from '../../api/demoApi';
import { useOwner } from '../../components/owner';
import { BlockTimeSheet } from './Diary';
import { ErrorBox, Field, Icon, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { BrandIcon, Heart, LemonSlice, ScriptTitle, Strapline } from '../../components/brand';
import { Glyph } from './Clients';
import { AddOnsMenu } from '../../components/public/menu';
import {
  DEFAULT_TEMPLATES, TEMPLATE_PLACEHOLDERS, checkHandle, downloadText, friendlyError, isPlausibleEmail, money, parseMenu, parsePounds,
  socialLink, type SocialSite,
} from '../../lib/text';
import { WEEKDAY_NAMES, fmtDay, fmtDayTime, fmtTime, minutesLabel, todayInZone } from '../../lib/time';
import type { OpeningHours, Service, Settings as S } from '../../lib/types';

type Group = 'business' | 'bookings' | 'messages' | 'data';
const SECTIONS: { to: string; label: string; sub: string; icon: ReactNode; group: Group }[] = [
  { to: 'business', label: 'Business details', sub: 'Name, welcome line, area, contact details', icon: <Glyph name="store" />, group: 'business' },
  { to: 'booking-page', label: 'Booking page', sub: 'Tagline, strapline, add-ons, safety, socials', icon: <BrandIcon name="sparkle" size={20} />, group: 'business' },
  { to: 'hours', label: 'Opening hours', sub: 'When clients can book', icon: <Glyph name="clock" />, group: 'business' },
  { to: 'services', label: 'Treatments & prices', sub: 'What clients can book', icon: <Glyph name="polish" />, group: 'business' },
  { to: 'time-off', label: 'Time off', sub: 'Holidays and blocked time', icon: <Glyph name="calendarOff" />, group: 'business' },
  { to: 'rules', label: 'Booking rules', sub: 'Notice, gaps, how far ahead', icon: <Glyph name="sliders" />, group: 'bookings' },
  { to: 'deposits', label: 'Deposits & cancellations', sub: 'Deposits, bank details, cancellation policy', icon: <Glyph name="pound" />, group: 'bookings' },
  { to: 'messages', label: 'WhatsApp messages', sub: 'Wording of reminders', icon: <Icon name="whatsapp" size={20} />, group: 'messages' },
  { to: 'email', label: 'Email confirmations & reminders', sub: 'Free, sent from your Gmail', icon: <Icon name="mail" size={20} />, group: 'messages' },
  { to: 'backup', label: 'Back up your data', sub: 'Download everything', icon: <Glyph name="download" />, group: 'data' },
  { to: 'account', label: 'Account', sub: 'Password, sign out', icon: <Glyph name="user" />, group: 'data' },
];
const GROUPS: { id: Group; title: string }[] = [
  { id: 'business', title: 'Your business' },
  { id: 'bookings', title: 'Bookings & payments' },
  { id: 'messages', title: 'Messages' },
  { id: 'data', title: 'Your data' },
];

/** One row of the settings list: an icon in a pink circle, the name and a hint. */
function SettingsRow({ to, label, sub, icon }: { to: string; label: string; sub: ReactNode; icon: ReactNode }) {
  return (
    <li><Link className="list-row od-set-row" to={to}>
      <span className="od-ic" aria-hidden="true">{icon}</span>
      <div className="grow"><div className="title">{label}</div><div className="meta">{sub}</div></div>
      <span className="chev"><Icon name="chev" size={18} /></span>
    </Link></li>
  );
}

export function SettingsHome() {
  const { session, settings: s } = useOwner();
  return (
    <div className="page od od-settings">
      <TopBar title="Settings" />
      <div className="card od-biz">
        <span className="od-biz-badge" aria-hidden="true"><LemonSlice size={44} /></span>
        <div className="grow">
          <div className="od-biz-name">{s.business_name}</div>
          <span className={`chip ${s.booking_enabled ? 'ok' : 'warn'}`}>{s.booking_enabled ? 'Taking online bookings' : 'Online bookings paused'}</span>
        </div>
      </div>
      {GROUPS.map((g) => (
        <div key={g.id}>
          <div className="section-title">{g.title}</div>
          <div className="card tight od-set-list"><ul className="list">
            {SECTIONS.filter((x) => x.group === g.id).map((x) => <SettingsRow key={x.to} to={`/settings/${x.to}`} label={x.label} sub={x.sub} icon={x.icon} />)}
          </ul></div>
        </div>
      ))}
      <div className="section-title">For clients</div>
      <div className="card tight od-set-list"><ul className="list">
        <SettingsRow to="/book" label="Your booking page" sub={s.booking_enabled ? 'Open for bookings' : 'Paused'} icon={<Glyph name="globe" />} />
        <SettingsRow to="/privacy" label="Privacy notice" sub="What clients are told about their data" icon={<BrandIcon name="shield-heart" size={20} />} />
      </ul></div>
      <p className="od-signed-in">Signed in as {session.email}</p>
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
  return <div className="page stack od od-set-page"><TopBar title={title} back="/settings" />{children}</div>;
}

/** A titled group of settings in a card. */
function SetCard({ icon, title, intro, children, className }: { icon?: ReactNode; title: string; intro?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card stack od-set-card${className ? ` ${className}` : ''}`}>
      <div className="od-panel-head">
        {icon && <span className="od-ic small" aria-hidden="true">{icon}</span>}
        <h2 className="od-set-title">{title}</h2>
      </div>
      {intro && <p className="sub od-set-intro">{intro}</p>}
      {children}
    </section>
  );
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
      <SetCard icon={<Glyph name="store" size={18} />} title="Your business">
        <Field label="Business name"><input type="text" value={d.business_name} maxLength={80} onChange={(e) => f.set('business_name', e.target.value)} /></Field>
        <Field label="Your legal name" hint="Shown in the privacy notice as the person responsible for client data.">
          <input type="text" autoComplete="name" value={txt(d.legal_name)} maxLength={100} onChange={(e) => f.set('legal_name', e.target.value)} />
        </Field>
      </SetCard>
      <SetCard icon={<BrandIcon name="sparkle" size={18} />} title="On your booking page">
        <Field label="Booking page welcome" hint="A line or two shown above your treatments."><textarea value={txt(d.booking_intro)} maxLength={1000} onChange={(e) => f.set('booking_intro', e.target.value)} /></Field>
        <Field label="Area (shown publicly)" hint="e.g. “Home studio near the high street — full address in your confirmation”">
          {/* wraps so she can read the whole line, but stays one line: a pressed Return becomes a space */}
          <textarea className="od-area" rows={2} value={txt(d.location_note)} maxLength={200}
            onChange={(e) => f.set('location_note', e.target.value.replace(/\s*\n\s*/g, ' '))} />
        </Field>
        <label className="check od-check-row"><input type="checkbox" checked={d.booking_enabled} onChange={(e) => f.set('booking_enabled', e.target.checked)} />
          <span>Online booking is open<br /><span className="sub">Untick to pause new online bookings (e.g. while you’re away).</span></span></label>
      </SetCard>
      <SetCard icon={<Icon name="mail" size={18} />} title="Contact details">
        <Field label="Full address (only in confirmation emails)"><textarea value={txt(d.address)} maxLength={300} onChange={(e) => f.set('address', e.target.value)} /></Field>
        <Field label="Your email" hint="New booking alerts go here, and clients’ replies come here."><input type="email" value={txt(d.owner_email)} onChange={(e) => f.set('owner_email', e.target.value)} /></Field>
        <Field label="Your mobile (optional)" hint="Shown in emails so clients can WhatsApp you."><input type="tel" value={txt(d.owner_phone)} onChange={(e) => f.set('owner_phone', e.target.value)} /></Field>
      </SetCard>
      <SetCard icon={<Glyph name="globe" size={18} />} title="This app">
        <Field label="This app’s web address" hint="Used for the booking and form links in emails.">
          <input type="text" inputMode="url" value={txt(d.public_site_url)} placeholder="https://…" onChange={(e) => f.set('public_site_url', e.target.value)} />
        </Field>
        <button className="btn small od-use-host" onClick={() => f.set('public_site_url', window.location.origin)}>Use {window.location.host}</button>
      </SetCard>
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy} onClick={submit}>{f.busy ? 'Saving…' : 'Save'}</button>
    </Page>
  );
}

type HandleKey = 'instagram_handle' | 'tiktok_handle' | 'facebook_handle';
const SOCIAL_FIELDS: { site: SocialSite; key: HandleKey; label: string }[] = [
  { site: 'instagram', key: 'instagram_handle', label: 'Instagram' },
  { site: 'tiktok', key: 'tiktok_handle', label: 'TikTok' },
  { site: 'facebook', key: 'facebook_handle', label: 'Facebook page' },
];

const MENU_EXAMPLE = 'Nail art\nSimple nail art | 50p per nail\n> Lots of colours counts as detailed. Just ask!\nExtras\nChrome powder | £5';

export function BookingPageSettings() {
  const f = useSettingsForm(['tagline', 'strapline', 'extras_menu', 'safety_note', 'instagram_handle', 'tiktok_handle', 'facebook_handle']);
  const d = f.draft;
  // A price typed without its "|" turns the line into a heading: say so before it goes live.
  const priceAsHeading = parseMenu(d.extras_menu).find((x) => x.title && /£\s?\d|\d\s?p\b/i.test(x.title))?.title;
  const tidy = (v: string | null) => v?.trim() || null;
  async function submit() {
    const handles = {} as Pick<S, HandleKey>;
    for (const x of SOCIAL_FIELDS) {
      const r = checkHandle(x.site, d[x.key]);
      if (r.error) return f.setError(new Error(r.error));
      handles[x.key] = r.handle;
    }
    const saved = await f.save({
      tagline: tidy(d.tagline), strapline: tidy(d.strapline), extras_menu: tidy(d.extras_menu), safety_note: tidy(d.safety_note), ...handles,
    });
    // Show what was kept: "@name" or a pasted link becomes just the handle.
    if (saved) for (const x of SOCIAL_FIELDS) f.set(x.key, handles[x.key]);
  }
  return (
    <Page title="Booking page">
      <div className="od-page-intro">
        <p className="sub">These dress up your booking page. Leave any of them blank to leave it off.</p>
        <Link className="od-text-link" to="/settings/business">Your welcome line and area are in <span className="od-nowrap">Business details<Icon name="chev" size={16} /></span></Link>
      </div>
      <SetCard icon={<Heart size={17} />} title="Your words">
        <Field label="Tagline" hint="A short line in pink handwriting under your business name, e.g. “Happy hands, happy you”.">
          <input type="text" value={txt(d.tagline)} maxLength={120} onChange={(e) => f.set('tagline', e.target.value)} />
        </Field>
        <Field label="Strapline" hint="A few words in spaced capitals with little hearts between, e.g. “Gel, BIAB, Nail art”. Separate them with commas.">
          <input type="text" value={txt(d.strapline)} maxLength={80} onChange={(e) => f.set('strapline', e.target.value)} />
        </Field>
        {(d.strapline?.trim() || d.tagline?.trim()) && (
          <div className="od-words-preview" aria-hidden="true">
            {d.strapline?.trim() && <Strapline text={d.strapline} />}
            {d.tagline?.trim() && <p className="od-tagline">{d.tagline}<Heart size={16} /></p>}
          </div>
        )}
      </SetCard>

      <SetCard icon={<BrandIcon name="gift" size={18} />} title="Add-ons">
        <Field label="Add-ons menu" hint={<>
          One per line. <strong>Name | price</strong> is an item, a line starting with <strong>&gt;</strong> is a note, and any other
          line is a heading. Shown for information: clients add these on the day, they don’t book them online. For example:
          <span className="mono od-example">{MENU_EXAMPLE.split('\n').map((l, i) => <span key={i} className="od-ex-line">{l}</span>)}</span>
        </>}>
          <textarea className="od-menu-text" value={txt(d.extras_menu)} maxLength={2000} onChange={(e) => f.set('extras_menu', e.target.value)} />
        </Field>
        {priceAsHeading && (
          <div className="notice warn">“{priceAsHeading}” will show as a heading. To make it an item, put a | between the name and the price.</div>
        )}
        {d.extras_menu?.trim() && <><div className="od-preview-label"><Glyph name="eye" size={16} /> How it reads on your booking page:</div><AddOnsMenu titleAs="p" className="od-addons-preview" label="How your add-ons will read" text={d.extras_menu} /></>}
      </SetCard>

      <SetCard icon={<BrandIcon name="shield-heart" size={18} />} title="Safety">
        <Field label="Safety note" hint="Shown in a badge on your booking page, e.g. how you keep tools clean and the PPE you use.">
          <textarea value={txt(d.safety_note)} maxLength={300} onChange={(e) => f.set('safety_note', e.target.value)} />
        </Field>
      </SetCard>

      <SetCard icon={<BrandIcon name="instagram" size={18} />} title="Social links">
        {SOCIAL_FIELDS.map((x) => {
          const r = checkHandle(x.site, d[x.key]);
          return (
            <Field key={x.key} label={x.label}
              hint={r.handle ? `Links to ${socialLink(x.site, r.handle).replace(/^https:\/\/(www\.)?/, '')}` : 'Your handle, or paste the link to your profile.'}>
              <input type="text" value={txt(d[x.key])} maxLength={200} autoCapitalize="none" autoCorrect="off" spellCheck={false}
                placeholder={x.site === 'facebook' ? 'YourNailStudio' : '@yournailstudio'} onChange={(e) => f.set(x.key, e.target.value)} />
            </Field>
          );
        })}
      </SetCard>
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy} onClick={submit}>{f.busy ? 'Saving…' : 'Save'}</button>
      <Link className="btn block" to="/book">Preview booking page</Link>
    </Page>
  );
}

type RuleKey = 'slot_interval_min' | 'buffer_min' | 'min_notice_hours' | 'max_days_ahead' | 'reminder_hours_before';

/** The booking rules, each with the range the database allows and what to say when it's outside it. */
const RULES: { k: RuleKey; label: string; hint: string; min: number; max: number; step?: number; error: string }[] = [
  { k: 'slot_interval_min', label: 'Start times every (minutes)', hint: 'Clients can start on the hour and every 15 minutes, for example.',
    min: 5, max: 120, step: 5, error: 'Start times must be a whole number of minutes apart, from 5 to 120.' },
  { k: 'buffer_min', label: 'Gap after each appointment (minutes)', hint: 'Time to clean up and set up for the next client.',
    min: 0, max: 120, step: 5, error: 'The gap after each appointment must be a whole number of minutes from 0 to 120.' },
  { k: 'min_notice_hours', label: 'Minimum notice (hours)', hint: 'How soon before an appointment clients can book online.',
    min: 0, max: 336, error: 'Minimum notice must be a whole number of hours from 0 to 336.' },
  { k: 'max_days_ahead', label: 'Book up to (days ahead)', hint: 'How far into the future clients can book.',
    min: 1, max: 365, error: 'Book up to must be a whole number of days from 1 to 365.' },
  { k: 'reminder_hours_before', label: 'Reminders (hours before)',
    hint: 'When the reminder email goes out. WhatsApp reminders show up in your list from this many days ahead (72 hours = 3 days).',
    min: 2, max: 168, error: 'Reminders must be a whole number of hours from 2 to 168.' },
];

/** How the rules are grouped on the page. */
const RULE_GROUPS: { title: string; icon: ReactNode; keys: RuleKey[] }[] = [
  { title: 'Your diary', icon: <Glyph name="calendar" size={18} />, keys: ['slot_interval_min', 'buffer_min'] },
  { title: 'When clients can book', icon: <Glyph name="clock" size={18} />, keys: ['min_notice_hours', 'max_days_ahead'] },
  { title: 'Reminders', icon: <Icon name="bell" size={18} />, keys: ['reminder_hours_before'] },
];

export function RulesSettings() {
  const f = useSettingsForm(RULES.map((r) => r.k));
  // As typed, so an emptied box isn't quietly saved as 0.
  const [text, setText] = useState(() => Object.fromEntries(RULES.map((r) => [r.k, String(f.draft[r.k])])) as Record<RuleKey, string>);
  async function submit() {
    const patch = {} as Pick<S, RuleKey>;
    for (const r of RULES) {
      const t = text[r.k].trim();
      if (!/^\d+$/.test(t) || Number(t) < r.min || Number(t) > r.max) return f.setError(new Error(r.error));
      patch[r.k] = Number(t);
    }
    await f.save(patch);
  }
  return (
    <Page title="Booking rules">
      {RULE_GROUPS.map((g) => (
        <SetCard key={g.title} icon={g.icon} title={g.title}>
          {RULES.filter((r) => g.keys.includes(r.k)).map((r) => (
            <Field key={r.k} label={r.label} hint={r.hint}>
              <input type="number" inputMode="numeric" min={r.min} max={r.max} step={r.step ?? 1} value={text[r.k]}
                onChange={(e) => setText((t) => ({ ...t, [r.k]: e.target.value }))} />
            </Field>
          ))}
        </SetCard>
      ))}
      <ErrorBox error={f.error} />
      <button className="btn primary block" disabled={f.busy} onClick={submit}>{f.busy ? 'Saving…' : 'Save'}</button>
    </Page>
  );
}

export function DepositSettings() {
  const f = useSettingsForm(['deposit_amount_pence', 'deposit_deadline_hours', 'auto_cancel_unpaid', 'bank_account_name', 'bank_sort_code',
    'bank_account_number', 'cancellation_policy', 'cancel_notice_hours', 'client_self_service']);
  const d = f.draft;
  const [amount, setAmount] = useState((d.deposit_amount_pence / 100).toFixed(2));
  // The policy is free text: flag it if its hours don't match the notice the app checks.
  const policyHours = Number(/(\d+)\s*(?:hours|hrs)/i.exec(d.cancellation_policy ?? '')?.[1] ?? NaN);
  async function submit() {
    const pence = parsePounds(amount || '0');
    if (pence === null) return f.setError(new Error('Check the deposit amount.'));
    if (pence > 0 && (!d.bank_account_name || !d.bank_sort_code || !d.bank_account_number)) return f.setError(new Error('Add your bank details so new clients know where to pay.'));
    if (!Number.isInteger(d.cancel_notice_hours) || d.cancel_notice_hours < 0 || d.cancel_notice_hours > 336)
      return f.setError(new Error('Notice needed to cancel must be a whole number of hours, from 0 to 336.'));
    await f.save({ ...d, deposit_amount_pence: pence });
  }
  return (
    <Page title="Deposits & cancellations">
      <SetCard icon={<Glyph name="pound" size={18} />} title="New-client deposit"
        intro="New clients (anyone who hasn’t had a completed appointment) are asked for this deposit by bank transfer. Returning clients aren’t. Set £0 to switch deposits off.">
        <div className="row">
          <Field label="Deposit (£)"><input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
          <Field label="Pay within (hours)" hint="Shown to the client."><input type="number" inputMode="numeric" min={1} max={336} value={d.deposit_deadline_hours} onChange={(e) => f.set('deposit_deadline_hours', Number(e.target.value))} /></Field>
        </div>
        <label className="check od-check-row">
          <input type="checkbox" checked={d.auto_cancel_unpaid} onChange={(e) => f.set('auto_cancel_unpaid', e.target.checked)} />
          <span>Release the slot automatically if the deposit hasn’t arrived in time<br />
            <span className="sub">The client is emailed. Leave this off to decide yourself — late ones are flagged on Today. Remember to mark deposits received promptly if it’s on.</span></span>
        </label>
      </SetCard>
      <SetCard icon={<Glyph name="bank" size={18} />} title="Bank details" intro="Sent only to clients who owe a deposit.">
        <Field label="Account name"><input type="text" value={txt(d.bank_account_name)} maxLength={80} onChange={(e) => f.set('bank_account_name', e.target.value)} /></Field>
        <div className="row">
          <Field label="Sort code"><input type="text" inputMode="numeric" value={txt(d.bank_sort_code)} maxLength={20} placeholder="00-00-00" onChange={(e) => f.set('bank_sort_code', e.target.value)} /></Field>
          <Field label="Account number"><input type="text" inputMode="numeric" value={txt(d.bank_account_number)} maxLength={20} onChange={(e) => f.set('bank_account_number', e.target.value)} /></Field>
        </div>
      </SetCard>
      <SetCard icon={<Glyph name="calendarOff" size={18} />} title="Cancellations" className="od-set-cancel">
        <Field label="Cancellation policy" hint="Shown at the top of your booking page and in every confirmation and reminder email. Clients must tick to agree to it before they can book, and each booking keeps a copy of the wording they agreed to.">
          <textarea value={txt(d.cancellation_policy)} maxLength={1000} style={{ minHeight: 110 }} onChange={(e) => f.set('cancellation_policy', e.target.value)} />
        </Field>
        <Field label="Notice needed to cancel (hours)" hint="Clients can still change or cancel online after this, but it’s flagged as a late cancellation so you can charge under your policy. 0 = no notice needed, so nothing counts as late.">
          <input type="number" inputMode="numeric" min={0} max={336} value={d.cancel_notice_hours} onChange={(e) => f.set('cancel_notice_hours', Number(e.target.value))} />
        </Field>
        {Number.isFinite(policyHours) && policyHours !== d.cancel_notice_hours && (
          <div className="notice warn">Your policy wording says {policyHours} hours, but the notice here is {d.cancel_notice_hours} hours. Make them match so clients aren’t confused.</div>
        )}
        <label className="check od-check-row">
          <input type="checkbox" checked={d.client_self_service} onChange={(e) => f.set('client_self_service', e.target.checked)} />
          <span>Clients can change or cancel their booking online<br />
            <span className="sub">Their confirmation and reminder emails include a private link to do it. Untick to have them get in touch with you instead.</span></span>
        </label>
      </SetCard>
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
        <div className={`card stack od-day-card${r.is_open ? '' : ' od-day-closed'}`} key={r.weekday}>
          <label className="check od-day-toggle">
            <input type="checkbox" checked={r.is_open} onChange={(e) => upd(i, { is_open: e.target.checked })} />
            <strong>{WEEKDAY_NAMES[r.weekday]}</strong>{!r.is_open && <span className="sub od-closed-tag">Closed</span>}
          </label>
          {r.is_open && (
            <>
              <div className="row">
                <Field label="Opens"><input type="time" step={300} value={r.open_time} onChange={(e) => upd(i, { open_time: e.target.value })} /></Field>
                <Field label="Closes"><input type="time" step={300} value={r.close_time} onChange={(e) => upd(i, { close_time: e.target.value })} /></Field>
              </div>
              <div className="row od-break">
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
      <div className="card od-pricelist">
        <ScriptTitle as="p" className="od-pricelist-title">Price List</ScriptTitle>
        {active.length === 0 ? <div className="empty">No treatments yet.</div> : (
          <ul className="od-pl">{active.map((v) => (
            <li key={v.id}><button className="od-pl-row" onClick={() => setEdit(v)}>
              <span className="od-pl-line"><span className="od-pl-name">{v.name}</span><span className="od-pl-price">{money(v.price_pence)}</span></span>
              <span className="od-pl-meta">
                <span>{minutesLabel(v.duration_min)}{!v.online_bookable && ' · not bookable online'}</span>
                <span className="od-pl-chev" aria-hidden="true"><Icon name="chev" size={16} /></span>
              </span>
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

/** "Sun 1 Nov · all day" for whole days (the end is midnight after the last day), otherwise both times;
    the arrow starts the second part, so a line never ends on it. */
function TimeOffWhen({ starts, ends, tz }: { starts: string; ends: string; tz: string }) {
  if (fmtTime(starts, tz) === '00:00' && fmtTime(ends, tz) === '00:00') {
    // noon the day before the end: the last day off, whatever the clocks did that night
    const last = new Date(new Date(ends).getTime() - 12 * 3600e3);
    const first = fmtDay(starts, tz);
    const lastDay = fmtDay(last, tz);
    return first === lastDay
      ? <><span className="od-nowrap">{first}</span>{' · all day'}</>
      : <><span className="od-nowrap">{first} –</span>{' '}<span className="od-nowrap">{lastDay}</span>{' · all day'}</>;
  }
  return <><span className="od-nowrap">{fmtDayTime(starts, tz)}</span>{' '}<span className="od-nowrap">→ {fmtDayTime(ends, tz)}</span></>;
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
            <li key={t.id} className="list-row od-off-row">
              <span className="od-ic small lemon" aria-hidden="true"><Glyph name="calendarOff" size={18} /></span>
              <div className="grow"><div className="title">{t.note || 'Time off'}</div><div className="meta"><TimeOffWhen starts={t.starts_at} ends={t.ends_at} tz={tz} /></div></div>
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
  const box = (k: 'wa_template_reminder' | 'wa_template_deposit' | 'wa_template_confirmed', label: string, def: string, long = false) => (
    <section className={`card od-template${long ? ' od-template-long' : ''}`}>
      <Field label={label}>
        <textarea value={d[k] ?? def} maxLength={1000} onChange={(e) => f.set(k, e.target.value)} />
        <button className="btn ghost small" style={{ alignSelf: 'flex-start' }} onClick={() => f.set(k, null)}>Reset to default</button>
      </Field>
    </section>
  );
  return (
    <Page title="WhatsApp messages">
      <section className="card stack od-set-card od-placeholders">
        <p className="sub">These fill in automatically when you tap a WhatsApp button. Words in curly brackets are swapped for the real details:</p>
        <p className="od-ph-list">{TEMPLATE_PLACEHOLDERS.map((x) => <code key={x}>{x}</code>)}</p>
        <details className="od-more">
          <summary>How the change-or-cancel words work</summary>
          <p className="sub"><span className="mono">{'{change_note}'}</span> tells the client how to change or cancel. Usually that’s their own link and the time to do it by. Once it’s inside your notice period, it gives the link and says your cancellation policy now applies. If they’ve already changed the booking inside your notice period, it gives the link and says the policy applies if they cancel, even when the appointment is now further off. With no notice period it’s just the link, and if clients can’t change bookings online (Deposits &amp; cancellations), it asks them to get in touch.</p>
          <p className="sub"><span className="mono">{'{manage_link}'}</span> is the link on its own, and <span className="mono">{'{change_by}'}</span> is the last time to change without it counting as late — for a booking already inside your notice period that time has passed, so <span className="mono">{'{change_note}'}</span> is usually better.</p>
        </details>
      </section>
      {[d.wa_template_reminder, d.wa_template_deposit, d.wa_template_confirmed].some((t) => t && /\{(manage_link|change_by)\}/.test(t)) && (
        <div className="notice warn">Your wording uses {'{manage_link}'} or {'{change_by}'}. These go out as they are, even when the time to change by has passed or clients can’t change bookings online. Use {'{change_note}'} to have that worded for you.</div>
      )}
      {box('wa_template_reminder', 'Reminder', DEFAULT_TEMPLATES.reminder)}
      {box('wa_template_deposit', 'Deposit request', DEFAULT_TEMPLATES.deposit, true)}
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
      <div className={`notice od-status${!s.email_secret_hash ? ' od-status-off' : healthy ? ' od-status-ok' : ' warn'}`}>
        {!s.email_secret_hash ? 'Not set up yet.' : lastPoll ? <>Email sender last checked in {fmtDayTime(lastPoll, s.timezone)}{healthy ? ' — working.' : ' — that’s a while ago; check the script is still running.'}</> : 'Secret created — waiting for the email script to check in.'}
      </div>
      <section className="card stack od-set-card">
        <p>Emails are sent free from your own Gmail by a small Google script that checks for new emails every 10 minutes. Clients get:</p>
        <ul className="sub od-hearts">
          <li>a booking confirmation (with bank details if they owe a deposit, and the consultation form link if they’re new)</li>
          <li>a “you’re confirmed” email when you mark their deposit received</li>
          <li>a reminder {s.reminder_hours_before} hours before</li>
          <li>a “your booking has changed” email when they change it online, or when you move it and tick the box to tell them</li>
          <li>a cancellation email when they cancel online, or when you cancel and tick the box to tell them</li>
        </ul>
        <p>You get an email for every new online booking, and whenever a client changes or cancels online{s.owner_email ? ` (to ${s.owner_email})` : ' — add your email in Business details'}.</p>
      </section>
      <div className="section-title">Set-up values for the script</div>
      <div className="card stack od-setup">
        <div><div className="od-key">SUPABASE_URL</div><div className="mono" style={{ overflowWrap: 'anywhere' }}>{url || '— (demo mode)'}</div></div>
        {url && <button className="btn small" onClick={() => copy(url, 'URL')}>Copy URL</button>}
        <div><div className="od-key">SUPABASE_ANON_KEY</div><div className="mono" style={{ overflowWrap: 'anywhere' }}>{key ? `${key.slice(0, 24)}…` : '— (demo mode)'}</div></div>
        {key && <button className="btn small" onClick={() => copy(key, 'Key')}>Copy key</button>}
        <div><div className="od-key">EMAIL_SECRET</div>
          {secret ? <div className="mono" style={{ overflowWrap: 'anywhere' }}>{secret}</div> : <div className="od-well">{s.email_secret_hash ? 'Hidden — make a new one if you’ve lost it.' : 'Not created yet.'}</div>}
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
      <section className="card stack od-set-card od-backup">
        <span className="od-ic od-backup-ic" aria-hidden="true"><Glyph name="download" size={24} /></span>
        <p>Download everything — clients, appointments, forms, patch tests, takings and settings — as one file. Keep it somewhere private (it contains health information). Photos aren’t included in the file.</p>
        <p className="sub">The free database plan keeps its own backups only for a short time, so download one now and then, e.g. at the start of each month.</p>
      </section>
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
      <div className="card od-account">
        <span className="od-ic" aria-hidden="true"><Glyph name="user" size={22} /></span>
        <dl className="od-account-who"><dt>Signed in as</dt><dd>{session.email}</dd></dl>
      </div>
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
