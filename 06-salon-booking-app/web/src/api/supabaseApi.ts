import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Api, FormInfo } from './api';
import type {
  Appointment, BookingInfo, BusyRange, Client, ClientPhoto, ConsultationForm, EmailLogRow,
  OpeningHours, PatchTest, Payment, Service, Session, Settings, TimeOff,
} from '../lib/types';

const PHOTO_BUCKET = 'client-photos';
const APPT_SELECT = '*, client:clients(id, full_name, email, phone, phone_e164, consultation_forms(count))';

type ApptRow = Appointment & { client: (Appointment['client'] & { consultation_forms?: { count: number }[] }) | null };

// The database returns times as "2026-10-27T10:00:00+00:00"; the app compares
// times as ISO strings ("…T10:00:00.000Z"), so convert once, here.
const iso = (v: string | null) => (v ? new Date(v).toISOString() : v);

function shapeAppt(r: ApptRow): Appointment {
  const forms = r.client?.consultation_forms?.[0]?.count ?? 0;
  const client = r.client ? { id: r.client.id, full_name: r.client.full_name, email: r.client.email, phone: r.client.phone, phone_e164: r.client.phone_e164 } : undefined;
  return {
    ...r, client, has_form: forms > 0,
    starts_at: iso(r.starts_at)!, ends_at: iso(r.ends_at)!, created_at: iso(r.created_at)!,
    deposit_due_at: iso(r.deposit_due_at), deposit_paid_at: iso(r.deposit_paid_at),
  };
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

// The Supabase API returns at most 1,000 rows per request. Anything that can
// grow past that (clients, a tax year of payments, a backup) is paged.
type Ranged = { range(from: number, to: number): PromiseLike<{ data: unknown; error: { message: string } | null }> };
async function fetchAll<T>(make: () => Ranged): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const chunk = check(await make().range(from, from + 999)) as T[];
    out.push(...chunk);
    if (chunk.length < 1000) return out;
  }
}

export function supabaseApi(url: string, anonKey: string): Api {
  const sb: SupabaseClient = createClient(url, anonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const toSession = (s: { user: { id: string; email?: string | null } } | null): Session | null =>
    s ? { userId: s.user.id, email: s.user.email ?? null } : null;

  const api: Api = {
    mode: 'live',

    // --- public ---------------------------------------------------------------
    async getBookingInfo() {
      return check(await sb.rpc('public_booking_info')) as BookingInfo;
    },
    async getBusyTimes(from, to) {
      const rows = check(await sb.rpc('public_busy_times', { p_from: from.toISOString(), p_to: to.toISOString() })) as BusyRange[];
      return rows.map((b) => ({ starts_at: iso(b.starts_at)!, ends_at: iso(b.ends_at)! }));
    },
    async createBooking(r) {
      return check(await sb.rpc('public_create_booking', {
        p_service_id: r.service_id, p_starts_at: r.starts_at, p_full_name: r.full_name, p_email: r.email,
        p_phone: r.phone, p_notes: r.notes, p_consultation: r.consultation, p_health_consent: r.health_consent,
        p_signed_name: r.signed_name,
      })) as { reference: string; starts_at: string };
    },
    async getForm(token) {
      return (check(await sb.rpc('public_get_form', { p_token: token })) as FormInfo | null) ?? null;
    },
    async submitForm(token, answers, consent, signedName) {
      check(await sb.rpc('public_submit_form', { p_token: token, p_answers: answers, p_health_consent: consent, p_signed_name: signedName }));
    },

    // --- auth -------------------------------------------------------------------
    async getSession() {
      const { data } = await sb.auth.getSession();
      return toSession(data.session);
    },
    onAuthChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_e, s) => cb(toSession(s)));
      return () => data.subscription.unsubscribe();
    },
    async signIn(email, password) {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw new Error(error.message);
    },
    async signUp(email, password) {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
      if (error) throw new Error(error.message);
      return { needsEmailConfirm: !data.session };
    },
    async signOut() {
      await sb.auth.signOut();
    },
    async sendPasswordReset(email) {
      const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: `${window.location.origin}/settings/account` });
      if (error) throw new Error(error.message);
    },
    async updatePassword(password) {
      const { error } = await sb.auth.updateUser({ password });
      if (error) throw new Error(error.message);
    },
    async ownerExists() {
      return check(await sb.rpc('public_owner_exists')) as boolean;
    },
    async claimOwner() {
      return check(await sb.rpc('claim_owner')) as boolean;
    },

    // --- settings -----------------------------------------------------------------
    async getSettings() {
      return check(await sb.from('settings').select('*').eq('id', 1).single()) as Settings;
    },
    async updateSettings(patch) {
      return check(await sb.from('settings').update(patch).eq('id', 1).select('*').single()) as Settings;
    },
    async listOpeningHours() {
      const rows = check(await sb.from('opening_hours').select('*').order('weekday')) as OpeningHours[];
      return rows.map((r) => ({
        ...r,
        open_time: r.open_time.slice(0, 5), close_time: r.close_time.slice(0, 5),
        break_start: r.break_start?.slice(0, 5) ?? null, break_end: r.break_end?.slice(0, 5) ?? null,
      }));
    },
    async saveOpeningHours(rows) {
      check(await sb.from('opening_hours').upsert(rows, { onConflict: 'weekday' }));
    },
    async listServices() {
      return check(await sb.from('services').select('*').order('sort_order').order('name')) as Service[];
    },
    async saveService(s) {
      const q = s.id ? sb.from('services').update(s).eq('id', s.id) : sb.from('services').insert(s);
      return check(await q.select('*').single()) as Service;
    },
    async listTimeOff(fromIso) {
      const rows = check(await sb.from('time_off').select('*').gte('ends_at', fromIso).order('starts_at')) as TimeOff[];
      return rows.map((t) => ({ ...t, starts_at: iso(t.starts_at)!, ends_at: iso(t.ends_at)! }));
    },
    async addTimeOff(t) {
      check(await sb.from('time_off').insert(t));
    },
    async deleteTimeOff(id) {
      check(await sb.from('time_off').delete().eq('id', id));
    },

    // --- diary --------------------------------------------------------------------
    async listAppointments(fromIso, toIso) {
      const rows = check(await sb.from('appointments').select(APPT_SELECT)
        .lt('starts_at', toIso).gt('ends_at', fromIso).order('starts_at')) as ApptRow[];
      return rows.map(shapeAppt);
    },
    async getAppointment(id) {
      const r = check(await sb.from('appointments').select(APPT_SELECT).eq('id', id).maybeSingle()) as ApptRow | null;
      return r ? shapeAppt(r) : null;
    },
    async createAppointment(a) {
      // ends_at / busy_until / reference are filled in by the database trigger.
      const row = { ...a, ends_at: a.starts_at, busy_until: a.starts_at, reference: '', source: 'owner' };
      return shapeAppt(check(await sb.from('appointments').insert(row).select(APPT_SELECT).single()) as ApptRow);
    },
    async updateAppointment(id, patch) {
      return shapeAppt(check(await sb.from('appointments').update(patch).eq('id', id).select(APPT_SELECT).single()) as ApptRow);
    },
    async markDepositPaid(id, method) {
      check(await sb.rpc('owner_mark_deposit_paid', { p_appointment_id: id, p_method: method }));
    },
    async completeAppointment(id, amountPence, method, tipPence, note) {
      check(await sb.rpc('owner_complete_appointment', {
        p_appointment_id: id, p_amount_pence: amountPence, p_method: method, p_tip_pence: tipPence, p_note: note,
      }));
    },
    async cancelAppointment(id, reason, notify) {
      check(await sb.rpc('owner_cancel_appointment', { p_appointment_id: id, p_reason: reason, p_notify: notify }));
    },
    async queueEmail(id, kind) {
      check(await sb.rpc('owner_queue_email', { p_appointment_id: id, p_kind: kind }));
    },
    async listEmailLog(appointmentId) {
      return check(await sb.from('email_outbox')
        .select('id, kind, to_email, status, attempts, sent_at, last_error, created_at')
        .eq('appointment_id', appointmentId).order('id')) as EmailLogRow[];
    },

    // --- clients -------------------------------------------------------------------
    async listClients() {
      const clients = await fetchAll<Client>(() => sb.from('clients').select('*').order('full_name').order('id'));
      const visits = await fetchAll<{ client_id: string; starts_at: string }>(() =>
        sb.from('appointments').select('client_id, starts_at').eq('status', 'completed').order('id'));
      const by = new Map<string, { last: string; n: number }>();
      for (const v of visits) {
        const cur = by.get(v.client_id);
        if (!cur) by.set(v.client_id, { last: v.starts_at, n: 1 });
        else { cur.n += 1; if (v.starts_at > cur.last) cur.last = v.starts_at; }
      }
      return clients.map((c) => ({ ...c, last_visit: by.get(c.id)?.last ?? null, visits: by.get(c.id)?.n ?? 0 }));
    },
    async getClient(id) {
      return check(await sb.from('clients').select('*').eq('id', id).maybeSingle()) as Client | null;
    },
    async createClient(c) {
      return check(await sb.from('clients').insert(c).select('*').single()) as Client;
    },
    async updateClient(id, patch) {
      return check(await sb.from('clients').update(patch).eq('id', id).select('*').single()) as Client;
    },
    async deleteClient(id) {
      const photos = check(await sb.from('client_photos').select('storage_path').eq('client_id', id)) as { storage_path: string }[];
      if (photos.length) {
        const { error } = await sb.storage.from(PHOTO_BUCKET).remove(photos.map((p) => p.storage_path));
        if (error) throw new Error(error.message);
      }
      check(await sb.from('clients').delete().eq('id', id));
    },
    async deleteHealthData(clientId) {
      check(await sb.rpc('owner_delete_health_data', { p_client_id: clientId }));
    },
    async listClientAppointments(clientId) {
      const rows = check(await sb.from('appointments').select(APPT_SELECT).eq('client_id', clientId)
        .order('starts_at', { ascending: false })) as ApptRow[];
      return rows.map(shapeAppt);
    },
    async countCompletedVisits(clientId) {
      const { count, error } = await sb.from('appointments').select('id', { count: 'exact', head: true })
        .eq('client_id', clientId).eq('status', 'completed');
      if (error) throw new Error(error.message);
      return count ?? 0;
    },
    async listPatchTests(clientId) {
      return check(await sb.from('patch_tests').select('*').eq('client_id', clientId).order('tested_on', { ascending: false })) as PatchTest[];
    },
    async addPatchTest(t) {
      check(await sb.from('patch_tests').insert(t));
    },
    async deletePatchTest(id) {
      check(await sb.from('patch_tests').delete().eq('id', id));
    },
    async listForms(clientId) {
      return check(await sb.from('consultation_forms').select('*').eq('client_id', clientId)
        .order('submitted_at', { ascending: false })) as ConsultationForm[];
    },
    async listPhotos(clientId) {
      const rows = check(await sb.from('client_photos').select('*').eq('client_id', clientId)
        .order('taken_on', { ascending: false }).order('created_at', { ascending: false })) as ClientPhoto[];
      if (!rows.length) return rows;
      const { data, error } = await sb.storage.from(PHOTO_BUCKET).createSignedUrls(rows.map((r) => r.storage_path), 3600);
      if (error) throw new Error(error.message);
      const urls = new Map((data ?? []).map((d) => [d.path, d.signedUrl]));
      return rows.map((r) => ({ ...r, url: urls.get(r.storage_path) ?? undefined }));
    },
    async uploadPhoto(clientId, image, caption, takenOn) {
      const path = `${clientId}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from(PHOTO_BUCKET).upload(path, image, { contentType: 'image/jpeg', upsert: false });
      if (error) throw new Error(error.message);
      const res = await sb.from('client_photos').insert({ client_id: clientId, storage_path: path, caption, taken_on: takenOn });
      if (res.error) {
        await sb.storage.from(PHOTO_BUCKET).remove([path]);
        throw new Error(res.error.message);
      }
    },
    async deletePhoto(photo) {
      const { error } = await sb.storage.from(PHOTO_BUCKET).remove([photo.storage_path]);
      if (error) throw new Error(error.message);
      check(await sb.from('client_photos').delete().eq('id', photo.id));
    },

    // --- money -----------------------------------------------------------------------
    async listPayments(fromDate, toDate) {
      return fetchAll<Payment>(() => sb.from('payments').select('*').gte('paid_on', fromDate).lte('paid_on', toDate)
        .order('paid_on', { ascending: false }).order('created_at', { ascending: false }).order('id'));
    },
    async addPayment(p) {
      check(await sb.from('payments').insert(p));
    },
    async deletePayment(id) {
      check(await sb.from('payments').delete().eq('id', id));
    },

    async exportAll() {
      const tables = ['settings', 'opening_hours', 'services', 'clients', 'patch_tests', 'consultation_forms',
        'appointments', 'time_off', 'payments', 'client_photos'];
      const out: Record<string, unknown[]> = {};
      for (const t of tables) {
        const key = t === 'settings' ? 'id' : t === 'opening_hours' ? 'weekday' : 'id';
        const rows = await fetchAll<unknown>(() => sb.from(t).select('*').order(key));
        out[t] = t === 'settings' ? rows.map((r) => ({ ...(r as object), email_secret_hash: undefined })) : rows;
      }
      return out;
    },
  };
  return api;
}
