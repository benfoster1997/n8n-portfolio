// Demo mode: the whole app working on invented data kept in this browser
// (localStorage). Used when no Supabase project is configured, and by the
// browser tests. The rules follow the database's as closely as matters for a
// demo; the database (supabase/schema.sql) is the real authority.
import type { Api, FormInfo } from './api';
import type {
  Appointment, BookingInfo, BusyRange, Client, ClientPhoto, ConsultationForm, EmailLogRow,
  OpeningHours, PatchTest, Payment, Service, Session, Settings, TimeOff,
} from '../lib/types';
import { addDays, dateInZone, todayInZone, zonedToInstant } from '../lib/time';
import { availableSlots } from '../lib/slots';
import { normalizeUkPhone } from '../lib/text';

const KEY = 'salon-demo-v3';
const TZ = 'Europe/London';

type Row<T> = T;
interface Store {
  settings: Settings;
  hours: OpeningHours[];
  services: Service[];
  clients: Client[];
  appointments: Row<Omit<Appointment, 'client' | 'has_form'> & { busy_until: string }>[];
  patch_tests: PatchTest[];
  forms: ConsultationForm[];
  time_off: TimeOff[];
  payments: Payment[];
  photos: ClientPhoto[];
  outbox: (EmailLogRow & { appointment_id: string })[];
  session: Session | null;
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
const ref = () => Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
const nowIso = () => new Date().toISOString();
const fail = (code: string): never => { throw new Error(code); };
const ACTIVE = new Set(['pending_deposit', 'confirmed', 'completed']);

function seed(): Store {
  const today = todayInZone(TZ);
  const at = (dayOffset: number, hhmm: string) => zonedToInstant(addDays(today, dayOffset), hhmm, TZ).toISOString();
  const settings: Settings = {
    business_name: 'Demo Nail Studio',
    booking_intro: 'Gel, BIAB and acrylic nails in a calm home studio. Book your appointment below — I’ll confirm by email.',
    location_note: 'Essex — full address in your confirmation email',
    address: '1 Example Road, Exampletown, EX1 2MP',
    owner_email: 'owner@example.com',
    owner_phone: '07700 900000',
    public_site_url: typeof window !== 'undefined' ? window.location.origin : '',
    timezone: TZ,
    slot_interval_min: 15,
    buffer_min: 10,
    min_notice_hours: 12,
    max_days_ahead: 60,
    deposit_amount_pence: 1000,
    deposit_deadline_hours: 24,
    bank_account_name: 'Demo Studio',
    bank_sort_code: '00-00-00',
    bank_account_number: '12345678',
    cancellation_policy: 'Please give at least 48 hours’ notice if you need to cancel or move your appointment. If you cancel with less than 48 hours’ notice, or don’t turn up, the full price of your treatment is payable.',
    reminder_hours_before: 24,
    wa_template_reminder: null,
    wa_template_deposit: null,
    wa_template_confirmed: null,
    booking_enabled: true,
    legal_name: 'Demo Owner',
    auto_cancel_unpaid: false,
    email_secret_hash: null,
    email_last_poll_at: null,
  };
  const hours: OpeningHours[] = [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({
    weekday,
    is_open: weekday !== 7,
    open_time: weekday === 6 ? '09:00' : '09:30',
    close_time: weekday === 6 ? '15:00' : weekday === 4 ? '19:00' : '17:30',
    break_start: null,
    break_end: null,
  }));
  const svc = (name: string, duration_min: number, pounds: number, sort_order: number, description: string | null = null): Service =>
    ({ id: uid(), name, description, duration_min, price_pence: pounds * 100, is_active: true, online_bookable: true, sort_order });
  const services = [
    svc('Gel polish — hands', 45, 25, 1, 'Cuticle tidy, shape and long-lasting gel colour.'),
    svc('BIAB new set', 75, 35, 2, 'Builder gel overlay on natural nails, with colour.'),
    svc('BIAB infill', 60, 30, 3, 'Infill within 3–4 weeks of your last set.'),
    svc('Acrylic full set', 105, 40, 4, 'Extensions with tips or forms, any shape.'),
    svc('Gel polish — toes', 45, 25, 5, null),
    svc('Removal only', 30, 10, 6, null),
  ];
  const cl = (full_name: string, phone: string, email: string | null, allergies: string | null = null, notes: string | null = null): Client =>
    ({ id: uid(), full_name, phone, phone_e164: normalizeUkPhone(phone), email, allergies, notes, is_regular: false,
      health_consent_at: allergies ? at(-40, '12:00') : null, health_consent_note: allergies ? 'Paper consultation form' : null,
      created_at: at(-60, '12:00') });
  const clients = [
    cl('Amelia Hart', '07700 900101', 'amelia@example.com', null, 'Likes almond shape, short length. Nude/pink shades.'),
    cl('Grace Patel', '07700 900102', 'grace@example.com', 'Sensitive to HEMA — use HEMA-free gel only.', 'Prefers Thursday evenings.'),
    cl('Sophie Turner', '07700 900103', 'sophie@example.com'),
    cl('Isla Morgan', '07700 900104', 'isla@example.com', null, 'Bites nails — BIAB has really helped.'),
    cl('Chloe Bennett', '07700 900105', null),
    cl('Ruby Clarke', '07700 900106', 'ruby@example.com'),
  ];
  const appts: Store['appointments'] = [];
  const add = (c: Client, s: Service, start: string, status: Appointment['status'], extra: Partial<Appointment> = {}) => {
    const ends = new Date(new Date(start).getTime() + s.duration_min * 60e3).toISOString();
    const a = {
      id: uid(), client_id: c.id, service_id: s.id, service_name: s.name, price_pence: s.price_pence,
      duration_min: s.duration_min, starts_at: start, ends_at: ends,
      busy_until: new Date(new Date(ends).getTime() + settings.buffer_min * 60e3).toISOString(),
      status, source: 'owner' as const, booking_name: c.full_name, is_new_client: false, deposit_required_pence: 0,
      deposit_due_at: null, deposit_paid_at: null, reference: ref(), public_token: uid(), client_notes: null,
      owner_notes: null, cancellation_policy_agreed: null, reminder_email_sent_at: null, whatsapp_reminder_sent_at: null, cancelled_at: null,
      cancel_reason: null, created_at: at(-14, '09:00'), ...extra,
    };
    appts.push(a);
    return a;
  };
  const [gel, biab, infill, acrylic, toes] = services;
  const [amelia, grace, sophie, isla, chloe, ruby] = clients;
  const payments: Payment[] = [];
  const paid = (a: { id: string; client_id: string; service_name: string; price_pence: number; starts_at: string }, c: Client, method: Payment['method']) =>
    payments.push({ id: uid(), appointment_id: a.id, client_id: c.id, client_name: c.full_name, description: a.service_name,
      amount_pence: a.price_pence, method, kind: 'payment', paid_on: dateInZone(a.starts_at, TZ), note: null, created_at: a.starts_at });

  // The last fortnight: completed visits with money taken.
  paid(add(amelia, biab, at(-13, '10:00'), 'completed'), amelia, 'bank_transfer');
  paid(add(grace, acrylic, at(-12, '17:00'), 'completed'), grace, 'cash');
  paid(add(isla, biab, at(-9, '11:00'), 'completed'), isla, 'bank_transfer');
  paid(add(chloe, gel, at(-8, '14:00'), 'completed'), chloe, 'cash');
  paid(add(ruby, toes, at(-6, '10:30'), 'completed'), ruby, 'cash');
  paid(add(amelia, infill, at(-2, '12:00'), 'completed'), amelia, 'bank_transfer');
  add(sophie, gel, at(-3, '15:00'), 'no_show', { is_new_client: true });

  // Today and the days ahead.
  add(isla, infill, at(0, '10:00'), 'confirmed');
  add(grace, infill, at(0, '13:00'), 'confirmed', { owner_notes: 'HEMA-free gel!' });
  add(chloe, gel, at(1, '11:00'), 'confirmed');
  const newBooking = add(sophie, biab, at(1, '14:00'), 'pending_deposit', {
    source: 'online', is_new_client: true, deposit_required_pence: 1000,
    deposit_due_at: new Date(Date.now() + 10 * 3600e3).toISOString(), created_at: new Date(Date.now() - 14 * 3600e3).toISOString(),
    client_notes: 'First time trying BIAB — would love a soft pink.',
  });
  add(ruby, gel, at(3, '10:30'), 'confirmed');
  add(amelia, infill, at(8, '12:00'), 'confirmed');

  sophie.health_consent_at = newBooking.created_at;
  sophie.health_consent_note = 'Online consultation form';
  return {
    settings, hours, services, clients, appointments: appts,
    patch_tests: [
      { id: uid(), client_id: grace.id, tested_on: addDays(today, -40), product: 'HEMA-free builder gel', result: 'pass', notes: 'No reaction after 48 hours.' },
      { id: uid(), client_id: isla.id, tested_on: addDays(today, -50), product: 'BIAB base', result: 'pass', notes: null },
    ],
    forms: [{
      id: uid(), client_id: sophie.id, appointment_id: newBooking.id, signed_name: 'Sophie Turner', health_consent: true,
      submitted_at: newBooking.created_at,
      answers: { allergies: 'no', allergies_details: '', previous_reaction: 'no', previous_reaction_details: '', conditions: [],
        medication: 'no', medication_details: '', other: 'Nails are quite thin at the moment.' },
    }],
    time_off: [{ id: uid(), starts_at: at(5, '00:00'), ends_at: at(6, '00:00'), note: 'Training day' }],
    payments,
    photos: [],
    outbox: [],
    session: null,
  };
}

function load(): Store {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Store;
  } catch { /* fall through */ }
  const s = seed();
  save(s);
  return s;
}
function save(s: Store) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage full or blocked: keep in memory */ }
}

export function resetDemo() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

export function demoApi(): Api {
  let db = load();
  const listeners = new Set<(s: Session | null) => void>();
  const commit = () => save(db);
  const clientLite = (id: string) => {
    const c = db.clients.find((x) => x.id === id);
    return c ? { id: c.id, full_name: c.full_name, email: c.email, phone: c.phone, phone_e164: c.phone_e164 } : undefined;
  };
  const shape = (a: Store['appointments'][number]): Appointment => ({
    ...a, client: clientLite(a.client_id), has_form: db.forms.some((f) => f.client_id === a.client_id),
  });
  const busyFor = (excludeId?: string): BusyRange[] => [
    ...db.appointments.filter((a) => ACTIVE.has(a.status) && a.id !== excludeId).map((a) => ({ starts_at: a.starts_at, ends_at: a.busy_until })),
    ...db.time_off.map((t) => ({ starts_at: t.starts_at, ends_at: t.ends_at })),
  ];
  const clash = (startIso: string, durationMin: number, excludeId?: string) => {
    const s = new Date(startIso).getTime();
    const e = s + (durationMin + db.settings.buffer_min) * 60e3;
    return db.appointments.some((a) => a.id !== excludeId && ACTIVE.has(a.status)
      && s < new Date(a.busy_until).getTime() && e > new Date(a.starts_at).getTime());
  };
  const queue = (appointment_id: string, kind: EmailLogRow['kind'], to: string | null | undefined) => {
    if (!to) return;
    const existing = db.outbox.find((o) => o.appointment_id === appointment_id && o.kind === kind);
    if (existing) { existing.status = 'pending'; existing.attempts = 0; return; }
    db.outbox.push({ id: db.outbox.length + 1, appointment_id, kind, to_email: to, status: 'pending', attempts: 0,
      sent_at: null, last_error: null, created_at: nowIso() });
  };
  const withBusy = (a: Omit<Store['appointments'][number], 'busy_until'>) => ({
    ...a, busy_until: new Date(new Date(a.ends_at).getTime() + db.settings.buffer_min * 60e3).toISOString(),
  });
  const delay = <T,>(v: T): Promise<T> => new Promise((r) => setTimeout(() => r(v), 60));
  const needOwner = () => { if (!db.session) fail('not_allowed'); };

  const api: Api = {
    mode: 'demo',

    async getBookingInfo() {
      const s = db.settings;
      const info: BookingInfo = {
        business_name: s.business_name, booking_intro: s.booking_intro, location_note: s.location_note,
        cancellation_policy: s.cancellation_policy, timezone: s.timezone, slot_interval_min: s.slot_interval_min,
        buffer_min: s.buffer_min, min_notice_hours: s.min_notice_hours, max_days_ahead: s.max_days_ahead,
        deposit_amount_pence: s.deposit_amount_pence, deposit_deadline_hours: s.deposit_deadline_hours,
        booking_enabled: s.booking_enabled, legal_name: s.legal_name, contact_email: s.owner_email, hours: db.hours,
        services: db.services.filter((v) => v.is_active && v.online_bookable).sort((a, b) => a.sort_order - b.sort_order)
          .map(({ id, name, description, duration_min, price_pence }) => ({ id, name, description, duration_min, price_pence })),
      };
      return delay(info);
    },
    async getBusyTimes(from, to) {
      const f = from.getTime(), t = to.getTime();
      return delay(busyFor().filter((b) => new Date(b.starts_at).getTime() < t && new Date(b.ends_at).getTime() > f));
    },
    async createBooking(r) {
      const s = db.settings;
      if (!s.booking_enabled) fail('booking_disabled');
      if (s.cancellation_policy?.trim() && !r.policy_accepted) fail('policy_required');
      const service = db.services.find((v) => v.id === r.service_id && v.is_active && v.online_bookable) ?? fail('invalid_service');
      const day = dateInZone(r.starts_at, s.timezone);
      const ok = availableSlots(day, service.duration_min, { ...s, hours: db.hours }, busyFor())
        .some((d) => d.toISOString() === new Date(r.starts_at).toISOString());
      if (!ok) fail('slot_taken');
      const email = r.email.trim().toLowerCase();
      const phone = normalizeUkPhone(r.phone);
      // Same rule as the database: match by email only, never change an existing record.
      let c = db.clients.find((x) => x.email === email);
      const created = !c;
      if (!c) {
        c = { id: uid(), full_name: r.full_name.trim(), email, phone: r.phone.trim(), phone_e164: phone, allergies: null, notes: null,
          is_regular: false, health_consent_at: null, health_consent_note: null, created_at: nowIso() };
        db.clients.push(c);
      }
      const isNew = !(c.is_regular || db.appointments.some((a) => a.client_id === c!.id && a.status === 'completed'));
      const deposit = isNew ? s.deposit_amount_pence : 0;
      const ends = new Date(new Date(r.starts_at).getTime() + service.duration_min * 60e3).toISOString();
      const a = withBusy({
        id: uid(), client_id: c.id, service_id: service.id, service_name: service.name, price_pence: service.price_pence,
        duration_min: service.duration_min, starts_at: new Date(r.starts_at).toISOString(), ends_at: ends,
        status: deposit > 0 ? 'pending_deposit' : 'confirmed', source: 'online', booking_name: r.full_name.trim(),
        is_new_client: isNew, deposit_required_pence: deposit,
        deposit_due_at: deposit > 0 ? new Date(Math.min(Date.now() + s.deposit_deadline_hours * 3600e3, new Date(r.starts_at).getTime())).toISOString() : null,
        deposit_paid_at: null, reference: ref(), public_token: uid(), client_notes: r.notes, owner_notes: null,
        cancellation_policy_agreed: s.cancellation_policy?.trim() || null,
        reminder_email_sent_at: null, whatsapp_reminder_sent_at: null, cancelled_at: null, cancel_reason: null, created_at: nowIso(),
      });
      db.appointments.push(a);
      if (r.consultation && created) {
        if (!r.health_consent) fail('consent_required');
        db.forms.push({ id: uid(), client_id: c.id, appointment_id: a.id, answers: r.consultation, health_consent: true,
          signed_name: r.signed_name ?? r.full_name, submitted_at: nowIso() });
        c.health_consent_at = nowIso();
        c.health_consent_note = 'Online consultation form';
      }
      queue(a.id, 'booking_received', email);
      queue(a.id, 'owner_new_booking', s.owner_email);
      commit();
      return delay({ reference: a.reference, starts_at: a.starts_at });
    },
    async getForm(token) {
      const a = db.appointments.find((x) => x.public_token === token && (x.status === 'pending_deposit' || x.status === 'confirmed'));
      if (!a) return delay(null);
      const c = db.clients.find((x) => x.id === a.client_id)!;
      const info: FormInfo = { business_name: db.settings.business_name, first_name: c.full_name.split(' ')[0], service_name: a.service_name,
        starts_at: a.starts_at, submitted: db.forms.some((f) => f.appointment_id === a.id) };
      return delay(info);
    },
    async submitForm(token, answers, consent, signedName) {
      const a = db.appointments.find((x) => x.public_token === token) ?? fail('not_found');
      if (db.forms.some((f) => f.appointment_id === a.id)) fail('already_submitted');
      if (!consent) fail('consent_required');
      db.forms.push({ id: uid(), client_id: a.client_id, appointment_id: a.id, answers, health_consent: true, signed_name: signedName, submitted_at: nowIso() });
      const c = db.clients.find((x) => x.id === a.client_id);
      if (c) { c.health_consent_at = nowIso(); c.health_consent_note = 'Online consultation form'; }
      commit();
      await delay(null);
    },

    async getSession() { return delay(db.session); },
    onAuthChange(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    async signIn(email) {
      db.session = { userId: 'demo-owner', email: email || 'demo@example.com' };
      commit();
      listeners.forEach((l) => l(db.session));
    },
    async signUp(email) { await api.signIn(email, ''); return { needsEmailConfirm: false }; },
    async signOut() { db.session = null; commit(); listeners.forEach((l) => l(null)); },
    async sendPasswordReset() { await delay(null); },
    async updatePassword() { await delay(null); },
    async ownerExists() { return delay(true); },
    async claimOwner() { return delay(true); },

    async getSettings() { needOwner(); return delay({ ...db.settings }); },
    async updateSettings(patch) { needOwner(); db.settings = { ...db.settings, ...patch }; commit(); return delay({ ...db.settings }); },
    async listOpeningHours() { return delay(db.hours.map((h) => ({ ...h }))); },
    async saveOpeningHours(rows) { needOwner(); db.hours = rows.map((h) => ({ ...h })); commit(); await delay(null); },
    async listServices() { return delay([...db.services].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))); },
    async saveService(s) {
      needOwner();
      if (s.id) {
        const i = db.services.findIndex((x) => x.id === s.id);
        db.services[i] = { ...db.services[i], ...s } as Service;
        commit();
        return delay(db.services[i]);
      }
      const created: Service = { id: uid(), description: null, is_active: true, online_bookable: true, sort_order: db.services.length + 1, ...s } as Service;
      db.services.push(created);
      commit();
      return delay(created);
    },
    async listTimeOff(fromIso) { return delay(db.time_off.filter((t) => t.ends_at >= fromIso).sort((a, b) => a.starts_at.localeCompare(b.starts_at))); },
    async addTimeOff(t) { needOwner(); db.time_off.push({ id: uid(), ...t }); commit(); await delay(null); },
    async deleteTimeOff(id) { needOwner(); db.time_off = db.time_off.filter((t) => t.id !== id); commit(); await delay(null); },

    async listAppointments(fromIso, toIso) {
      needOwner();
      return delay(db.appointments.filter((a) => a.starts_at < toIso && a.ends_at > fromIso)
        .sort((a, b) => a.starts_at.localeCompare(b.starts_at)).map(shape));
    },
    async getAppointment(id) { needOwner(); const a = db.appointments.find((x) => x.id === id); return delay(a ? shape(a) : null); },
    async createAppointment(n) {
      needOwner();
      if (clash(n.starts_at, n.duration_min)) fail('appointments_no_overlap');
      const ends = new Date(new Date(n.starts_at).getTime() + n.duration_min * 60e3).toISOString();
      const a = withBusy({
        id: uid(), ...n, starts_at: new Date(n.starts_at).toISOString(), ends_at: ends, source: 'owner', booking_name: null,
        deposit_paid_at: null, reference: ref(), public_token: uid(), client_notes: null, cancellation_policy_agreed: null, reminder_email_sent_at: null,
        whatsapp_reminder_sent_at: null, cancelled_at: null, cancel_reason: null, created_at: nowIso(),
      });
      db.appointments.push(a);
      commit();
      return delay(shape(a));
    },
    async updateAppointment(id, patch) {
      needOwner();
      const i = db.appointments.findIndex((x) => x.id === id);
      if (i < 0) fail('not_found');
      const cur = db.appointments[i];
      const next = { ...cur, ...patch };
      if (patch.starts_at || patch.duration_min) {
        next.starts_at = new Date(next.starts_at).toISOString();
        next.ends_at = new Date(new Date(next.starts_at).getTime() + next.duration_min * 60e3).toISOString();
        if (ACTIVE.has(next.status) && clash(next.starts_at, next.duration_min, id)) fail('appointments_no_overlap');
        if (next.starts_at !== cur.starts_at) { next.reminder_email_sent_at = null; next.whatsapp_reminder_sent_at = null; }
        if (next.deposit_due_at && next.deposit_due_at > next.starts_at) next.deposit_due_at = next.starts_at;
      }
      db.appointments[i] = withBusy(next);
      commit();
      return delay(shape(db.appointments[i]));
    },
    async markDepositPaid(id, method) {
      needOwner();
      const a = db.appointments.find((x) => x.id === id) ?? fail('not_found');
      if (a.status !== 'pending_deposit') fail('not_pending_deposit');
      a.status = 'confirmed';
      a.deposit_paid_at = nowIso();
      const c = db.clients.find((x) => x.id === a.client_id)!;
      if (a.deposit_required_pence > 0) {
        db.payments.push({ id: uid(), appointment_id: a.id, client_id: c.id, client_name: c.full_name, description: `Deposit · ${a.service_name}`,
          amount_pence: a.deposit_required_pence, method, kind: 'deposit', paid_on: todayInZone(TZ), note: null, created_at: nowIso() });
      }
      queue(a.id, 'deposit_received', c.email);
      commit();
      await delay(null);
    },
    async completeAppointment(id, amountPence, method, tipPence, note) {
      needOwner();
      const a = db.appointments.find((x) => x.id === id) ?? fail('not_found');
      if (a.status !== 'confirmed' && a.status !== 'pending_deposit') fail('not_completable');
      a.status = 'completed';
      const c = db.clients.find((x) => x.id === a.client_id)!;
      const base = { appointment_id: a.id, client_id: c.id, client_name: c.full_name, method, paid_on: todayInZone(TZ), created_at: nowIso() };
      if (amountPence > 0) db.payments.push({ id: uid(), ...base, description: a.service_name, amount_pence: amountPence, kind: 'payment', note });
      if (tipPence > 0) db.payments.push({ id: uid(), ...base, description: `Tip · ${a.service_name}`, amount_pence: tipPence, kind: 'tip', note: null });
      commit();
      await delay(null);
    },
    async cancelAppointment(id, reason, notify) {
      needOwner();
      const a = db.appointments.find((x) => x.id === id) ?? fail('not_found');
      if (a.status !== 'confirmed' && a.status !== 'pending_deposit') fail('not_cancellable');
      a.status = 'cancelled';
      a.cancelled_at = nowIso();
      a.cancel_reason = reason;
      db.outbox.filter((o) => o.appointment_id === id && o.status === 'pending').forEach((o) => { o.status = 'skipped'; });
      if (notify) queue(id, 'cancelled', db.clients.find((x) => x.id === a.client_id)?.email);
      commit();
      await delay(null);
    },
    async queueEmail(id, kind) {
      needOwner();
      const a = db.appointments.find((x) => x.id === id) ?? fail('not_found');
      const email = db.clients.find((x) => x.id === a.client_id)?.email ?? fail('no_email');
      queue(id, kind, email);
      commit();
      await delay(null);
    },
    async listEmailLog(appointmentId) { return delay(db.outbox.filter((o) => o.appointment_id === appointmentId)); },

    async listClients() {
      needOwner();
      return delay(db.clients.map((c) => {
        const done = db.appointments.filter((a) => a.client_id === c.id && a.status === 'completed');
        return { ...c, visits: done.length, last_visit: done.map((a) => a.starts_at).sort().pop() ?? null };
      }).sort((a, b) => a.full_name.localeCompare(b.full_name)));
    },
    async getClient(id) { needOwner(); return delay(db.clients.find((c) => c.id === id) ?? null); },
    async createClient(c) {
      needOwner();
      const email = c.email?.trim().toLowerCase() || null;
      if (email && db.clients.some((x) => x.email === email)) fail('A client with that email already exists');
      const created: Client = { id: uid(), full_name: c.full_name.trim(), email, phone: c.phone?.trim() || null,
        phone_e164: normalizeUkPhone(c.phone), allergies: c.allergies ?? null, notes: c.notes ?? null,
        is_regular: false, health_consent_at: null, health_consent_note: null, created_at: nowIso() };
      db.clients.push(created);
      commit();
      return delay(created);
    },
    async updateClient(id, patch) {
      needOwner();
      const c = db.clients.find((x) => x.id === id) ?? fail('not_found');
      Object.assign(c, patch);
      if ('phone' in patch) c.phone_e164 = normalizeUkPhone(c.phone);
      if ('email' in patch) c.email = c.email?.trim().toLowerCase() || null;
      commit();
      return delay({ ...c });
    },
    async deleteClient(id) {
      needOwner();
      db.clients = db.clients.filter((c) => c.id !== id);
      const gone = new Set(db.appointments.filter((a) => a.client_id === id).map((a) => a.id));
      db.appointments = db.appointments.filter((a) => a.client_id !== id);
      db.patch_tests = db.patch_tests.filter((p) => p.client_id !== id);
      db.forms = db.forms.filter((f) => f.client_id !== id);
      db.photos = db.photos.filter((p) => p.client_id !== id);
      db.outbox = db.outbox.filter((o) => !gone.has(o.appointment_id));
      db.payments.forEach((p) => { if (p.client_id === id) p.client_id = null; if (p.appointment_id && gone.has(p.appointment_id)) p.appointment_id = null; });
      commit();
      await delay(null);
    },
    async deleteHealthData(clientId) {
      needOwner();
      db.forms = db.forms.filter((f) => f.client_id !== clientId);
      db.patch_tests = db.patch_tests.filter((p) => p.client_id !== clientId);
      const c = db.clients.find((x) => x.id === clientId);
      if (c) { c.allergies = null; c.health_consent_at = null; c.health_consent_note = null; }
      commit();
      await delay(null);
    },
    async listClientAppointments(clientId) {
      needOwner();
      return delay(db.appointments.filter((a) => a.client_id === clientId).sort((a, b) => b.starts_at.localeCompare(a.starts_at)).map(shape));
    },
    async countCompletedVisits(clientId) {
      return delay(db.appointments.filter((a) => a.client_id === clientId && a.status === 'completed').length);
    },
    async listPatchTests(clientId) { return delay(db.patch_tests.filter((p) => p.client_id === clientId).sort((a, b) => b.tested_on.localeCompare(a.tested_on))); },
    async addPatchTest(t) { needOwner(); db.patch_tests.push({ id: uid(), ...t }); commit(); await delay(null); },
    async deletePatchTest(id) { needOwner(); db.patch_tests = db.patch_tests.filter((p) => p.id !== id); commit(); await delay(null); },
    async listForms(clientId) { return delay(db.forms.filter((f) => f.client_id === clientId).sort((a, b) => b.submitted_at.localeCompare(a.submitted_at))); },
    async listPhotos(clientId) { return delay(db.photos.filter((p) => p.client_id === clientId).sort((a, b) => b.taken_on.localeCompare(a.taken_on))); },
    async uploadPhoto(clientId, image, caption, takenOn) {
      needOwner();
      const url = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(r.error);
        r.readAsDataURL(image);
      });
      db.photos.push({ id: uid(), client_id: clientId, appointment_id: null, storage_path: `demo/${uid()}.jpg`, caption, taken_on: takenOn, url });
      commit();
    },
    async deletePhoto(photo) { needOwner(); db.photos = db.photos.filter((p) => p.id !== photo.id); commit(); await delay(null); },

    async listPayments(fromDate, toDate) {
      needOwner();
      return delay(db.payments.filter((p) => p.paid_on >= fromDate && p.paid_on <= toDate)
        .sort((a, b) => b.paid_on.localeCompare(a.paid_on) || b.created_at.localeCompare(a.created_at)));
    },
    async addPayment(p) { needOwner(); db.payments.push({ id: uid(), created_at: nowIso(), ...p }); commit(); await delay(null); },
    async deletePayment(id) { needOwner(); db.payments = db.payments.filter((p) => p.id !== id); commit(); await delay(null); },

    async exportAll() {
      needOwner();
      const { session: _s, ...rest } = db;
      void _s;
      return delay(rest as unknown as Record<string, unknown[]>);
    },
  };
  // Reload from storage if another tab changed the demo.
  if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { if (e.key === KEY) db = load(); });
  return api;
}
