import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Api, FormInfo } from './api';
import type {
  Appointment, ApptHealth, BookingChangeResult, BookingInfo, BusyRange, Client, ClientChange, ClientLite, ClientPhoto, ConsultationForm,
  EmailLogRow, ManageInfo, OpeningHours, PatchTest, Payment, Service, Session, Settings, TaxYear, TimeOff,
} from '../lib/types';
import { emptyTaxYear } from '../lib/tax';

const PHOTO_BUCKET = 'client-photos';
const CLIENT_COLS = 'id, full_name, email, phone, phone_e164';
// Lists (Today, the diary, a client's bookings): whether the client has allergies, consent and a form
// recorded. shapeAppt keeps only whether there are allergies, never what they are.
const APPT_SELECT = `*, client:clients(${CLIENT_COLS}, allergies, health_consent_at, consultation_forms(count))`;
// One appointment: the client's health information too, for the strip at the top of its screen.
const APPT_DETAIL_SELECT = `*, client:clients(${CLIENT_COLS}, allergies, is_regular, health_consent_at, health_consent_note, `
  + 'consultation_forms(submitted_at), patch_tests(tested_on, result))';

interface ClientRow extends ClientLite {
  allergies: string | null;
  health_consent_at: string | null;
  is_regular?: boolean;
  health_consent_note?: string | null;
  /** [{ count }] in lists; one { submitted_at } for each form with a single appointment. */
  consultation_forms?: { count?: number; submitted_at?: string }[];
  patch_tests?: Pick<PatchTest, 'tested_on' | 'result'>[];
}
type ApptRow = Omit<Appointment, 'client' | 'has_form' | 'has_consent' | 'has_allergies' | 'health'> & { client: ClientRow | null };

// The database returns times as "2026-10-27T10:00:00+00:00"; the app compares
// times as ISO strings ("…T10:00:00.000Z"), so convert once, here.
const iso = (v: string | null) => (v ? new Date(v).toISOString() : v);

function shapeAppt(r: ApptRow): Appointment {
  const { client: c, ...a } = r;
  const forms = c?.consultation_forms?.[0]?.count ?? 0;
  return {
    ...a,
    client: c ? { id: c.id, full_name: c.full_name, email: c.email, phone: c.phone, phone_e164: c.phone_e164 } : undefined,
    has_form: forms > 0, has_consent: !!c?.health_consent_at, has_allergies: !!c?.allergies?.trim(),
    starts_at: iso(a.starts_at)!, ends_at: iso(a.ends_at)!, created_at: iso(a.created_at)!,
    deposit_due_at: iso(a.deposit_due_at), deposit_paid_at: iso(a.deposit_paid_at),
    cancelled_at: iso(a.cancelled_at), client_changed_at: iso(a.client_changed_at), details_sent_at: iso(a.details_sent_at),
    moved_at: iso(a.moved_at),
  };
}

/** One appointment, with the client's health information (APPT_DETAIL_SELECT). */
function shapeApptDetail(r: ApptRow): Appointment {
  const c = r.client;
  const forms = (c?.consultation_forms ?? []).flatMap((f) => (f.submitted_at ? [iso(f.submitted_at)!] : [])).sort().reverse();
  const health: ApptHealth | undefined = c ? {
    allergies: c.allergies, consent_at: iso(c.health_consent_at), consent_note: c.health_consent_note ?? null, is_regular: !!c.is_regular,
    patch_tests: (c.patch_tests ?? []).map(({ tested_on, result }) => ({ tested_on, result })).sort((x, y) => y.tested_on.localeCompare(x.tested_on)),
    forms,
  } : undefined;
  return { ...shapeAppt({ ...r, client: c && { ...c, consultation_forms: [{ count: forms.length }] } }), health };
}

function check<T>(res: { data: T; error: { message: string } | null }): T {
  if (res.error) throw new Error(res.error.message);
  return res.data;
}

/**
 * The tax estimate's table (public.tax_years) came with the estimate: an install
 * made with an older schema.sql gets it by running supabase/updates/2026-11-tax-estimate.sql.
 * Until that's done the API says the table isn't there: PGRST205 ("Could not find
 * the table 'public.tax_years' in the schema cache") now, 42P01 on older versions.
 */
function taxTableMissing(e: { code?: string; message?: string } | null): boolean {
  if (!e) return false;
  return e.code === 'PGRST205' || e.code === '42P01'
    || /could not find the table '?public\.tax_years|relation "?(public\.)?tax_years"? does not exist/i.test(e.message ?? '');
}
const shapeTaxYear = (r: TaxYear): TaxYear => ({ ...r, updated_at: iso(r.updated_at) });

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
        p_signed_name: r.signed_name, p_policy_accepted: r.policy_accepted,
      })) as { reference: string; starts_at: string };
    },
    async getForm(token) {
      return (check(await sb.rpc('public_get_form', { p_token: token })) as FormInfo | null) ?? null;
    },
    async submitForm(token, answers, consent, signedName) {
      check(await sb.rpc('public_submit_form', { p_token: token, p_answers: answers, p_health_consent: consent, p_signed_name: signedName }));
    },
    async getManagedBooking(token) {
      const m = check(await sb.rpc('public_get_booking', { p_token: token })) as ManageInfo | null;
      if (!m) return null;
      const b = m.booking;
      return {
        ...m,
        booking: {
          ...b, starts_at: iso(b.starts_at)!, ends_at: iso(b.ends_at)!, deposit_due_at: iso(b.deposit_due_at),
          cancelled_at: iso(b.cancelled_at), free_until: iso(b.free_until),
        },
      };
    },
    async getBusyTimesExcept(token, from, to) {
      const rows = check(await sb.rpc('public_busy_times_except', { p_token: token, p_from: from.toISOString(), p_to: to.toISOString() })) as BusyRange[];
      return rows.map((b) => ({ starts_at: iso(b.starts_at)!, ends_at: iso(b.ends_at)! }));
    },
    async changeBooking(token, change) {
      const r = check(await sb.rpc('public_change_booking', {
        p_token: token, p_service_id: change.service_id, p_starts_at: change.starts_at,
      })) as BookingChangeResult;
      return { ...r, starts_at: iso(r.starts_at)! };
    },
    async cancelBooking(token, reason) {
      return check(await sb.rpc('public_cancel_booking', { p_token: token, p_reason: reason })) as { late: boolean };
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
    async listUnfinished(beforeIso, limit) {
      const { data, count, error } = await sb.from('appointments').select(APPT_SELECT, { count: 'exact' })
        .in('status', ['confirmed', 'pending_deposit']).lte('ends_at', beforeIso)
        .order('starts_at').order('id').limit(limit);
      if (error) throw new Error(error.message);
      const rows = (data ?? []) as unknown as ApptRow[];
      return { appts: rows.map(shapeAppt), total: count ?? rows.length };
    },
    async getAppointment(id) {
      const r = check(await sb.from('appointments').select(APPT_DETAIL_SELECT).eq('id', id).maybeSingle()) as ApptRow | null;
      return r ? shapeApptDetail(r) : null;
    },
    async createAppointment(a) {
      // ends_at / busy_until / reference are filled in by the database trigger.
      const row = { ...a, ends_at: a.starts_at, busy_until: a.starts_at, reference: '', source: 'owner' };
      return shapeApptDetail(check(await sb.from('appointments').insert(row).select(APPT_DETAIL_SELECT).single()) as ApptRow);
    },
    async updateAppointment(id, patch) {
      return shapeApptDetail(check(await sb.from('appointments').update(patch).eq('id', id).select(APPT_DETAIL_SELECT).single()) as ApptRow);
    },
    async markDepositPaid(id, method) {
      check(await sb.rpc('owner_mark_deposit_paid', { p_appointment_id: id, p_method: method }));
    },
    async completeAppointment(id, amountPence, method, tipPence, note) {
      check(await sb.rpc('owner_complete_appointment', {
        p_appointment_id: id, p_amount_pence: amountPence, p_method: method, p_tip_pence: tipPence, p_note: note,
      }));
    },
    async cancelAppointment(id, reason, notify, late = false) {
      check(await sb.rpc('owner_cancel_appointment', { p_appointment_id: id, p_reason: reason, p_notify: notify, p_late: late }));
    },
    async queueEmail(id, kind) {
      check(await sb.rpc('owner_queue_email', { p_appointment_id: id, p_kind: kind }));
    },
    async listEmailLog(appointmentId) {
      return check(await sb.from('email_outbox')
        .select('id, kind, to_email, status, attempts, sent_at, last_error, created_at')
        .eq('appointment_id', appointmentId).order('id')) as EmailLogRow[];
    },
    async listLateCancellations(sinceIso) {
      const rows = check(await sb.from('appointments').select(APPT_SELECT)
        .eq('status', 'cancelled').eq('cancelled_late', true).gte('cancelled_at', sinceIso)
        .order('cancelled_at', { ascending: false })) as ApptRow[];
      return rows.map(shapeAppt);
    },
    async resetManageLink(id) {
      return check(await sb.rpc('owner_reset_link', { p_appointment_id: id })) as string;
    },
    async listClientChanges({ appointmentId, sinceIso }) {
      let q = sb.from('client_changes')
        .select('*, appointment:appointments(client_id, booking_name, client:clients(full_name))')
        .order('changed_at', { ascending: false }).order('id', { ascending: false }).limit(200);
      if (appointmentId) q = q.eq('appointment_id', appointmentId);
      if (sinceIso) q = q.gte('changed_at', sinceIso);
      type Row = ClientChange & { appointment: { client_id: string; booking_name: string | null; client: { full_name: string } | null } | null };
      const rows = check(await q) as Row[];
      return rows.map(({ appointment, ...c }) => ({
        ...c, changed_at: iso(c.changed_at)!, old_starts_at: iso(c.old_starts_at), new_starts_at: iso(c.new_starts_at),
        client_id: appointment?.client_id ?? null,
        client_name: appointment?.client?.full_name ?? appointment?.booking_name ?? null,
      }));
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
    async getTaxYear(startYear) {
      const res = await sb.from('tax_years').select('*').eq('start_year', startYear).maybeSingle();
      // Not updated yet: no saved figures, so the estimate works from the takings alone.
      if (taxTableMissing(res.error)) return emptyTaxYear(startYear);
      const row = check(res) as TaxYear | null;
      return row ? shapeTaxYear(row) : emptyTaxYear(startYear);
    },
    async saveTaxYear(row) {
      const res = await sb.from('tax_years')
        .upsert({ start_year: row.start_year, extra_takings_pence: row.extra_takings_pence, expenses_pence: row.expenses_pence },
          { onConflict: 'start_year' })
        .select('*').single();
      if (taxTableMissing(res.error)) throw new Error('tax_update_needed');
      return shapeTaxYear(check(res) as TaxYear);
    },

    async exportAll() {
      const tables = ['settings', 'opening_hours', 'services', 'clients', 'patch_tests', 'consultation_forms',
        'appointments', 'client_changes', 'time_off', 'payments', 'client_photos'];
      const out: Record<string, unknown[]> = {};
      for (const t of tables) {
        const key = t === 'settings' ? 'id' : t === 'opening_hours' ? 'weekday' : 'id';
        const rows = await fetchAll<unknown>(() => sb.from(t).select('*').order(key));
        out[t] = t === 'settings' ? rows.map((r) => ({ ...(r as object), email_secret_hash: undefined })) : rows;
      }
      // One row per tax year, so never more than a page. Until the update has been run there's nothing to back up.
      const tax = await sb.from('tax_years').select('*').order('start_year');
      out.tax_years = taxTableMissing(tax.error) ? [] : (check(tax) as unknown[]);
      return out;
    },
  };
  return api;
}
