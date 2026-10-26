// Everything the screens need, behind one interface. Two implementations:
//   * supabaseApi — the real thing, talking to the owner's Supabase project.
//   * demoApi     — invented data kept in this browser, so the app can be
//                   tried (and tested) before anything is set up.
import type {
  Appointment, BookingChangeResult, BookingInfo, BookingRequest, BusyRange, Client, ClientChange, ClientPhoto,
  ConsultationForm, EmailKind, EmailLogRow, ManageInfo, NewAppointment, OpeningHours, PatchTest, PayMethod,
  Payment, Service, Session, Settings, TimeOff,
} from '../lib/types';

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
  getAppointment(id: string): Promise<Appointment | null>;
  createAppointment(a: NewAppointment): Promise<Appointment>;
  updateAppointment(id: string, patch: Partial<Pick<Appointment,
    'starts_at' | 'duration_min' | 'service_name' | 'service_id' | 'price_pence' | 'owner_notes' | 'status' | 'whatsapp_reminder_sent_at'>>): Promise<Appointment>;
  markDepositPaid(id: string, method: PayMethod): Promise<void>;
  completeAppointment(id: string, amountPence: number, method: PayMethod, tipPence: number, note: string | null): Promise<void>;
  cancelAppointment(id: string, reason: string | null, notify: boolean): Promise<void>;
  queueEmail(id: string, kind: Extract<EmailKind, 'booking_received' | 'deposit_received' | 'reminder' | 'changed'>): Promise<void>;
  listEmailLog(appointmentId: string): Promise<EmailLogRow[]>;
  /** Changes clients made online: for one appointment, or everything since a time (newest first). */
  listClientChanges(opts: { appointmentId?: string; sinceIso?: string }): Promise<ClientChange[]>;

  // --- owner: clients ------------------------------------------------------
  listClients(): Promise<(Client & { last_visit: string | null; visits: number })[]>;
  getClient(id: string): Promise<Client | null>;
  createClient(c: Pick<Client, 'full_name' | 'email' | 'phone'> & Partial<Pick<Client, 'allergies' | 'notes'>>): Promise<Client>;
  updateClient(id: string, patch: Partial<Pick<Client,
    'full_name' | 'email' | 'phone' | 'allergies' | 'notes' | 'is_regular' | 'health_consent_at' | 'health_consent_note'>>): Promise<Client>;
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

  // --- owner: backup -------------------------------------------------------
  exportAll(): Promise<Record<string, unknown[]>>;
}
