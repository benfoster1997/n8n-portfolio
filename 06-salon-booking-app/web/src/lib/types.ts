// Shapes of the data the app works with. They mirror supabase/schema.sql.

export type ApptStatus = 'pending_deposit' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type PayMethod = 'cash' | 'bank_transfer';
export type PayKind = 'deposit' | 'payment' | 'tip' | 'refund' | 'other';
export type EmailKind = 'booking_received' | 'deposit_received' | 'reminder' | 'cancelled' | 'owner_new_booking';

export interface Settings {
  business_name: string;
  booking_intro: string | null;
  location_note: string | null;
  address: string | null;
  owner_email: string | null;
  owner_phone: string | null;
  public_site_url: string | null;
  timezone: string;
  slot_interval_min: number;
  buffer_min: number;
  min_notice_hours: number;
  max_days_ahead: number;
  deposit_amount_pence: number;
  deposit_deadline_hours: number;
  bank_account_name: string | null;
  bank_sort_code: string | null;
  bank_account_number: string | null;
  cancellation_policy: string | null;
  reminder_hours_before: number;
  wa_template_reminder: string | null;
  wa_template_deposit: string | null;
  wa_template_confirmed: string | null;
  booking_enabled: boolean;
  email_secret_hash: string | null;
  email_last_poll_at: string | null;
}

export interface OpeningHours {
  weekday: number; // ISO: 1 = Monday … 7 = Sunday
  is_open: boolean;
  open_time: string; // "HH:MM"
  close_time: string;
  break_start: string | null;
  break_end: string | null;
}

export interface Service {
  id: string;
  name: string;
  description: string | null;
  duration_min: number;
  price_pence: number;
  is_active: boolean;
  online_bookable: boolean;
  sort_order: number;
}

export interface Client {
  id: string;
  full_name: string;
  email: string | null;
  phone: string | null;
  phone_e164: string | null;
  allergies: string | null;
  notes: string | null;
  created_at: string;
}

export type ClientLite = Pick<Client, 'id' | 'full_name' | 'email' | 'phone' | 'phone_e164'>;

export interface Appointment {
  id: string;
  client_id: string;
  service_id: string | null;
  service_name: string;
  price_pence: number;
  duration_min: number;
  starts_at: string;
  ends_at: string;
  status: ApptStatus;
  source: 'online' | 'owner';
  booking_name: string | null;
  is_new_client: boolean;
  deposit_required_pence: number;
  deposit_due_at: string | null;
  deposit_paid_at: string | null;
  reference: string;
  public_token: string;
  client_notes: string | null;
  owner_notes: string | null;
  reminder_email_sent_at: string | null;
  whatsapp_reminder_sent_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  created_at: string;
  client?: ClientLite;
  /** True when the client has at least one consultation form on file. */
  has_form?: boolean;
}

export interface PatchTest {
  id: string;
  client_id: string;
  tested_on: string; // YYYY-MM-DD
  product: string | null;
  result: 'pass' | 'reaction' | 'pending';
  notes: string | null;
}

export interface ConsultationForm {
  id: string;
  client_id: string;
  appointment_id: string | null;
  answers: Record<string, unknown>;
  health_consent: boolean;
  signed_name: string;
  submitted_at: string;
}

export interface TimeOff {
  id: string;
  starts_at: string;
  ends_at: string;
  note: string | null;
}

export interface Payment {
  id: string;
  appointment_id: string | null;
  client_id: string | null;
  client_name: string | null;
  description: string | null;
  amount_pence: number;
  method: PayMethod;
  kind: PayKind;
  paid_on: string; // YYYY-MM-DD
  note: string | null;
  created_at: string;
}

export interface ClientPhoto {
  id: string;
  client_id: string;
  appointment_id: string | null;
  storage_path: string;
  caption: string | null;
  taken_on: string;
  url?: string;
}

export interface EmailLogRow {
  id: number;
  kind: EmailKind;
  to_email: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  attempts: number;
  sent_at: string | null;
  last_error: string | null;
  created_at: string;
}

/** What the public booking page is allowed to know. */
export interface BookingInfo {
  business_name: string;
  booking_intro: string | null;
  location_note: string | null;
  cancellation_policy: string | null;
  timezone: string;
  slot_interval_min: number;
  buffer_min: number;
  min_notice_hours: number;
  max_days_ahead: number;
  deposit_amount_pence: number;
  deposit_deadline_hours: number;
  booking_enabled: boolean;
  hours: OpeningHours[];
  services: Pick<Service, 'id' | 'name' | 'description' | 'duration_min' | 'price_pence'>[];
}

export interface BusyRange {
  starts_at: string;
  ends_at: string;
}

export interface BookingRequest {
  service_id: string;
  starts_at: string;
  full_name: string;
  email: string;
  phone: string;
  notes: string | null;
  consultation: Record<string, unknown> | null;
  health_consent: boolean;
  signed_name: string | null;
}

export interface NewAppointment {
  client_id: string;
  service_id: string | null;
  service_name: string;
  price_pence: number;
  duration_min: number;
  starts_at: string;
  status: 'pending_deposit' | 'confirmed';
  is_new_client: boolean;
  deposit_required_pence: number;
  deposit_due_at: string | null;
  owner_notes: string | null;
}

export interface Session {
  userId: string;
  email: string | null;
}
