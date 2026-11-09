// Everything the screens need, behind one interface. Two implementations:
//   * supabaseApi — the real thing, talking to the owner's Supabase project.
//   * demoApi     — invented data kept in this browser, so the app can be
//                   tried (and tested) before anything is set up.
import type {
  Appointment, BookingChangeResult, BookingInfo, BookingRequest, BusyRange, Client, ClientChange, ClientPhoto,
  ConsultationForm, EmailKind, EmailLogRow, ManageInfo, NewAppointment, NewClientBooking, OpeningHours, PatchTest, PayMethod,
  Payment, Service, Session, Settings, ShortNoticeClient, TaxYear, TimeOff,
} from '../lib/types';

/**
 * The live database hasn't had the update for this version (supabase/updates/2026-11-growth.sql):
 * a column it adds isn't there. Only what's new fails like this (listNewClientBookings,
 * listShortNoticeClients, and saving one of the new fields); everything else works as before,
 * and bookings still go through without their optional answers. friendlyError() words it for her.
 */
export class NeedsUpdateError extends Error {
  /** The update to run in Supabase's SQL Editor. */
  readonly update = 'supabase/updates/2026-11-growth.sql';
  constructor() {
    super('growth_update_needed');
    this.name = 'NeedsUpdateError';
  }
}

/** The error is a NeedsUpdateError (or carries its code, after being passed along as a plain error). */
export const isNeedsUpdate = (e: unknown): boolean =>
  e instanceof NeedsUpdateError || (e instanceof Error && e.message === 'growth_update_needed');

export interface FormInfo {
  business_name: string;
  first_name: string;
  service_name: string;
  starts_at: string;
  submitted: boolean;
}

export interface Api {
  readonly mode: 'live' | 'demo';

  // --- public booking page -------------------------------------------------
  getBookingInfo(): Promise<BookingInfo>;
  getBusyTimes(from: Date, to: Date): Promise<BusyRange[]>;
  createBooking(req: BookingRequest): Promise<{ reference: string; starts_at: string }>;
  getForm(token: string): Promise<FormInfo | null>;
  submitForm(token: string, answers: Record<string, unknown>, consent: boolean, signedName: string): Promise<void>;

  // --- a client managing their own booking (/manage/:token) ------------------
  /** Null when the link is unknown or the appointment is long past. */
  getManagedBooking(token: string): Promise<ManageInfo | null>;
  /** Busy times for choosing a new time; the client's own booking doesn't count. */
  getBusyTimesExcept(token: string, from: Date, to: Date): Promise<BusyRange[]>;
  /** Move the booking and/or switch treatment. Null keeps that part as it is. */
  changeBooking(token: string, change: { service_id: string | null; starts_at: string | null }): Promise<BookingChangeResult>;
  cancelBooking(token: string, reason: string | null): Promise<{ late: boolean }>;

  // --- sign-in -------------------------------------------------------------
  getSession(): Promise<Session | null>;
  onAuthChange(cb: (s: Session | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  signUp(email: string, password: string): Promise<{ needsEmailConfirm: boolean }>;
  signOut(): Promise<void>;
  sendPasswordReset(email: string): Promise<void>;
  updatePassword(password: string): Promise<void>;
  ownerExists(): Promise<boolean>;
  claimOwner(): Promise<boolean>;

  // --- owner: settings -----------------------------------------------------
  getSettings(): Promise<Settings>;
  /** Saving review_link or wa_template_review fails with NeedsUpdateError until the database update has been run. */
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  listOpeningHours(): Promise<OpeningHours[]>;
  saveOpeningHours(rows: OpeningHours[]): Promise<void>;
  listServices(): Promise<Service[]>;
  saveService(s: Partial<Service> & { name: string; duration_min: number; price_pence: number }): Promise<Service>;
  listTimeOff(fromIso: string): Promise<TimeOff[]>;
  addTimeOff(t: Omit<TimeOff, 'id'>): Promise<void>;
  deleteTimeOff(id: string): Promise<void>;

  // --- owner: diary --------------------------------------------------------
  listAppointments(fromIso: string, toIso: string): Promise<Appointment[]>;
  /**
   * Appointments that had ended by `beforeIso` but still say Confirmed or Deposit due: never
   * finished, marked as a no-show or cancelled. The oldest `limit` of them, and how many there are in all.
   */
  listUnfinished(beforeIso: string, limit: number): Promise<{ appts: Appointment[]; total: number }>;
  /** With the client's health information (allergies, consent, patch tests and forms). */
  getAppointment(id: string): Promise<Appointment | null>;
  createAppointment(a: NewAppointment): Promise<Appointment>;
  /** Saving heard_from or heard_from_detail fails with NeedsUpdateError until the database update has been run. */
  updateAppointment(id: string, patch: Partial<Pick<Appointment,
    'starts_at' | 'duration_min' | 'service_name' | 'service_id' | 'price_pence' | 'owner_notes' | 'status' | 'whatsapp_reminder_sent_at'
    | 'booking_phone' | 'heard_from' | 'heard_from_detail'>>): Promise<Appointment>;
  markDepositPaid(id: string, method: PayMethod): Promise<void>;
  completeAppointment(id: string, amountPence: number, method: PayMethod, tipPence: number, note: string | null): Promise<void>;
  /** late: the client cancelled with too little notice (by phone or WhatsApp). */
  cancelAppointment(id: string, reason: string | null, notify: boolean, late?: boolean): Promise<void>;
  queueEmail(id: string, kind: Extract<EmailKind, 'booking_received' | 'deposit_received' | 'reminder' | 'changed'>): Promise<void>;
  listEmailLog(appointmentId: string): Promise<EmailLogRow[]>;
  /** Changes clients made online: for one appointment, or everything since a time (newest first). */
  listClientChanges(opts: { appointmentId?: string; sinceIso?: string }): Promise<ClientChange[]>;
  /** Late cancellations (by the client online, or marked late by the owner) cancelled since a time, newest first. */
  listLateCancellations(sinceIso: string): Promise<Appointment[]>;
  /** A new change/cancel link for a booking; the old one stops working. Returns the new token. */
  resetManageLink(id: string): Promise<string>;

  // --- owner: clients ------------------------------------------------------
  listClients(): Promise<(Client & { last_visit: string | null; visits: number })[]>;
  getClient(id: string): Promise<Client | null>;
  createClient(c: Pick<Client, 'full_name' | 'email' | 'phone'> & Partial<Pick<Client, 'allergies' | 'notes'>>): Promise<Client>;
  /** Saving marketing_ok_at, marketing_ok_note or review_asked_at fails with NeedsUpdateError until the database update has been run. */
  updateClient(id: string, patch: Partial<Pick<Client,
    'full_name' | 'email' | 'phone' | 'allergies' | 'notes' | 'is_regular' | 'health_consent_at' | 'health_consent_note'
    | 'marketing_ok_at' | 'marketing_ok_note' | 'review_asked_at'>>): Promise<Client>;
  deleteClient(id: string): Promise<void>;
  /** Consent withdrawn: delete forms, patch tests and allergy notes, keep the client. */
  deleteHealthData(clientId: string): Promise<void>;
  listClientAppointments(clientId: string): Promise<Appointment[]>;
  countCompletedVisits(clientId: string): Promise<number>;
  listPatchTests(clientId: string): Promise<PatchTest[]>;
  addPatchTest(t: Omit<PatchTest, 'id'>): Promise<void>;
  deletePatchTest(id: string): Promise<void>;
  listForms(clientId: string): Promise<ConsultationForm[]>;
  listPhotos(clientId: string): Promise<ClientPhoto[]>;
  uploadPhoto(clientId: string, image: Blob, caption: string | null, takenOn: string): Promise<void>;
  deletePhoto(photo: ClientPhoto): Promise<void>;

  // --- owner: money --------------------------------------------------------
  listPayments(fromDate: string, toDate: string): Promise<Payment[]>;
  addPayment(p: Omit<Payment, 'id' | 'created_at'>): Promise<void>;
  deletePayment(id: string): Promise<void>;
  /**
   * Her own figures for one tax year's estimate (takings not in the app, expenses).
   * Zeros when nothing is saved, and also when the database update that adds them
   * hasn't been run yet, so the estimate still shows from the takings alone.
   */
  getTaxYear(startYear: number): Promise<TaxYear>;
  /** Save (or replace) a tax year's figures. Fails with "tax_update_needed" until the database update has been run. */
  saveTaxYear(row: Pick<TaxYear, 'start_year' | 'extra_takings_pence' | 'expenses_pence'>): Promise<TaxYear>;

  // --- owner: where clients come from, and short-notice spaces ----------------
  /**
   * Bookings by new clients made (created_at) from `fromIso` up to, not including, `toIso`, oldest first:
   * online ones whose client said it was their first visit, and her own bookings for a new client
   * (is_new_client). For Money → New clients: count them with summariseNewClients() in lib/source.
   * Fails with NeedsUpdateError until the database update has been run.
   */
  listNewClientBookings(fromIso: string, toIso: string): Promise<NewClientBooking[]>;
  /**
   * Clients who said she may message them about short-notice spaces and offers, and have a mobile, by name.
   * Fails with NeedsUpdateError until the database update has been run.
   */
  listShortNoticeClients(): Promise<ShortNoticeClient[]>;

  // --- owner: backup -------------------------------------------------------
  exportAll(): Promise<Record<string, unknown[]>>;
}
