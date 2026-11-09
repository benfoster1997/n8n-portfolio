// Shapes of the data the app works with. They mirror supabase/schema.sql.

export type ApptStatus = 'pending_deposit' | 'confirmed' | 'completed' | 'cancelled' | 'no_show';
export type PayMethod = 'cash' | 'bank_transfer';
export type PayKind = 'deposit' | 'payment' | 'tip' | 'refund' | 'other';
export type EmailKind =
  | 'booking_received' | 'deposit_received' | 'reminder' | 'cancelled' | 'changed'
  | 'owner_new_booking' | 'owner_changed' | 'owner_cancelled';
export type CancelledBy = 'client' | 'owner' | 'system';
/** "How did you hear about me?": the six answers the database keeps (labels: HEARD_FROM in lib/source). */
export type HeardFrom = 'instagram' | 'facebook' | 'google' | 'friend' | 'card' | 'other';

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
  /**
   * The WhatsApp thank-you after Mark as done that asks for a Google review (null: DEFAULT_TEMPLATES.review).
   * This and review_link are null in the live app until supabase/updates/2026-11-growth.sql has been run,
   * and saving them fails with NeedsUpdateError (api/api.ts).
   */
  wa_template_review: string | null;
  /** Her Google review link, for the message's {review_link}: https, no spaces (check it with isReviewLink). Owner-side only. */
  review_link: string | null;
  booking_enabled: boolean;
  legal_name: string | null;
  auto_cancel_unpaid: boolean;
  /** Notice the cancellation policy asks for. Later client cancellations are flagged as late. 0 = none. */
  cancel_notice_hours: number;
  /** Clients can change or cancel their own booking from the link in their emails. */
  client_self_service: boolean;
  /** The booking page's look (Settings → Booking page). All public: see BookingPageText. */
  tagline: string | null;
  strapline: string | null;
  extras_menu: string | null;
  safety_note: string | null;
  instagram_handle: string | null;
  facebook_handle: string | null;
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
  /** A regular moved over from another system: never asked for a new-client deposit. */
  is_regular: boolean;
  /** When the client gave explicit consent to health information being kept. */
  health_consent_at: string | null;
  health_consent_note: string | null;
  /**
   * When the client said she may message them about short-notice spaces and offers (null: they haven't).
   * These three are null in the live app until supabase/updates/2026-11-growth.sql has been run,
   * and saving them fails with NeedsUpdateError (api/api.ts).
   */
  marketing_ok_at: string | null;
  /** How they said so: "Ticked on the booking page", or her own note. Up to 100 characters. */
  marketing_ok_note: string | null;
  /** When she last asked them for a Google review. */
  review_asked_at: string | null;
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
  /** The cancellation policy the client agreed to when booking online. */
  cancellation_policy_agreed: string | null;
  owner_notes: string | null;
  reminder_email_sent_at: string | null;
  whatsapp_reminder_sent_at: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_by: CancelledBy | null;
  /** The client cancelled inside the cancellation notice period. */
  cancelled_late: boolean;
  /** How many times the client has changed this booking online. */
  client_change_count: number;
  client_changed_at: string | null;
  /** When the client was last emailed their details after booking (a change notice or re-sent confirmation). */
  details_sent_at: string | null;
  /** When the start time last moved. */
  moved_at: string | null;
  /** The full price payable under the policy, fixed once the client changed or cancelled inside the notice period. */
  late_fee_pence: number | null;
  /** The mobile typed with an online booking when it differs from the client's record, for the owner to check. */
  booking_phone: string | null;
  /**
   * Where an online booking came from: the link's ?from= or the site that sent them ('instagram', 'card',
   * 'free-times', …; see readSource and foundYouLabel in lib/source). These four are null in the live
   * app until supabase/updates/2026-11-growth.sql has been run, and saving one fails with NeedsUpdateError.
   */
  link_source: string | null;
  /** "How did you hear about me?" (optional, asked of first-timers), or noted by the owner. */
  heard_from: HeardFrom | null;
  /** A few words with A friend or Other, such as the friend's name. Up to 60 characters, never a link. */
  heard_from_detail: string | null;
  /** The client's own answer to "Is this your first visit?" when booking online. Deposits follow is_new_client, never this. */
  first_visit_said: boolean | null;
  created_at: string;
  client?: ClientLite;
  /** True when the client has at least one consultation form on file. */
  has_form?: boolean;
  /** The client's consent to keeping health information is recorded: from the online form, or by the owner (Record consent). */
  has_consent?: boolean;
  /** The client has allergies recorded. Only that: lists show an "Allergy" tag, never the details. */
  has_allergies?: boolean;
  /** One appointment on its own (getAppointment, updateAppointment): the client's health information, for the strip at the top. */
  health?: ApptHealth;
}

/** A client's health information as the appointment screen shows it. */
export interface ApptHealth {
  allergies: string | null;
  /** When consent to keeping health information was given, and how ("Paper consultation form", "Online consultation form", …). */
  consent_at: string | null;
  consent_note: string | null;
  /** A regular moved over from another system (never asked for a new-client deposit). */
  is_regular: boolean;
  /** Newest first. */
  patch_tests: Pick<PatchTest, 'tested_on' | 'result'>[];
  /** When each consultation form was filled in, newest first. */
  forms: string[];
}

/** One change a client made to their own booking online. */
export interface ClientChange {
  id: number;
  appointment_id: string;
  changed_at: string;
  action: 'moved' | 'treatment' | 'moved_treatment' | 'cancelled';
  old_starts_at: string | null;
  new_starts_at: string | null;
  old_service_name: string | null;
  new_service_name: string | null;
  old_price_pence: number | null;
  new_price_pence: number | null;
  /** Made with less notice than the cancellation policy asks for. */
  late: boolean;
  /** The client's reason, if they gave one when cancelling. */
  note: string | null;
  /** Filled in by the owner's list: whose booking it is. */
  client_name?: string | null;
  client_id?: string | null;
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

/** The owner's own figures for one tax year's "Tax to put aside" estimate (Money → Tax year). */
export interface TaxYear {
  /** The year the tax year starts: 2026 for 6 April 2026 to 5 April 2027. */
  start_year: number;
  /** Takings not recorded in the app, e.g. bookings taken through another app before switching. 0 to £1,000,000. */
  extra_takings_pence: number;
  /** Business expenses for the tax year. 0 to £1,000,000. */
  expenses_pence: number;
  /** Null when nothing has been saved for the year yet. */
  updated_at: string | null;
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

/** The owner's own words for the booking page: its header, add-ons menu, safety badge and social links. */
export interface BookingPageText {
  /** Pink handwritten line under the business name, e.g. "Happy hands, happy you". Up to 120 characters. */
  tagline: string | null;
  /** Spaced capitals with hearts between, e.g. "Gel, BIAB, Nail art". Up to 80 characters. */
  strapline: string | null;
  /** Add-ons price list as plain text; read it with parseMenu() in lib/text. Up to 2,000 characters. */
  extras_menu: string | null;
  /** The PPE and hygiene badge. Up to 300 characters. */
  safety_note: string | null;
  /** Handles only, no @ or web address: [A-Za-z0-9._], 1–30 characters. */
  instagram_handle: string | null;
  /** [A-Za-z0-9._], 2–24 characters. */
  /** The page's name in its web address: [A-Za-z0-9.], 5–50 characters. */
  facebook_handle: string | null;
}

/** What the public booking page is allowed to know. */
export interface BookingInfo extends BookingPageText {
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
  legal_name: string | null;
  contact_email: string | null;
  hours: OpeningHours[];
  services: Pick<Service, 'id' | 'name' | 'description' | 'duration_min' | 'price_pence'>[];
}

/** What a client sees about their own booking on the manage page. */
export interface ManagedBooking {
  reference: string;
  status: ApptStatus;
  first_name: string;
  service_id: string | null;
  service_name: string;
  price_pence: number;
  duration_min: number;
  starts_at: string;
  ends_at: string;
  deposit_required_pence: number;
  deposit_due_at: string | null;
  deposit_paid: boolean;
  cancelled_at: string | null;
  cancelled_by: CancelledBy | null;
  cancelled_late: boolean;
  /** Online changes still allowed before they have to get in touch. */
  changes_left: number;
  /** Changes and cancellations are confirmed by email. */
  has_email: boolean;
  /** Set once they've changed it inside the notice period: any cancellation is then late, and this is payable. */
  late_fee_pence: number | null;
  /** A new client who hasn't filled in the consultation form yet. */
  form_needed: boolean;
  /** After this time, cancelling (or moving) is inside the notice period. Null when there is no notice period. */
  free_until: string | null;
}

export interface ManageInfo {
  info: BookingInfo;
  booking: ManagedBooking;
  contact_phone: string | null;
  cancel_notice_hours: number;
  client_self_service: boolean;
  /** Only while a deposit is still owed. */
  bank: { account_name: string | null; sort_code: string | null; account_number: string | null } | null;
}

export interface BookingChangeResult {
  reference: string;
  starts_at: string;
  service_name: string;
  price_pence: number;
  /** Made inside the notice period (a move or a treatment switch). */
  late: boolean;
}

export interface BusyRange {
  starts_at: string;
  ends_at: string;
}

/**
 * The booking page's optional answers (public_create_booking's p_extras). The database tidies them and
 * leaves out anything odd, so they can never stop a booking. Blank ones aren't sent at all.
 */
export interface BookingExtras {
  /** Where the link came from: readSource() in lib/source. */
  link_source?: string | null;
  /** "How did you hear about me?" */
  heard_from?: HeardFrom | null;
  /** A few words with A friend or Other, such as the friend's name (kept to 60 characters; never a link). */
  heard_from_detail?: string | null;
  /** Their answer to "Is this your first visit?" (false is an answer too). */
  first_visit?: boolean | null;
  /** Ticked "message me about short-notice spaces and offers" (unticked to begin with). */
  marketing_ok?: boolean;
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
  /** Ticked "I agree to the cancellation policy". */
  policy_accepted: boolean;
  /** The optional answers. Still books if the database update for them hasn't been run (they're left out). */
  extras?: BookingExtras;
}

/**
 * One booking by a new client, for Money → New clients (listNewClientBookings): booked online by someone
 * who said it was their first visit, or a booking she made for a new client. Count them with summariseNewClients.
 */
export interface NewClientBooking {
  id: string;
  client_id: string;
  status: ApptStatus;
  /** When it was booked. */
  created_at: string;
  link_source: string | null;
  heard_from: HeardFrom | null;
  heard_from_detail: string | null;
  /** The client's name now, from their record. */
  full_name: string | null;
}

/** A client who's happy to hear about short-notice spaces and offers, and has a mobile (listShortNoticeClients). */
export interface ShortNoticeClient {
  id: string;
  full_name: string;
  /** For whatsappLink(): only clients with a mobile are listed. */
  phone_e164: string;
  /** When they said yes. */
  marketing_ok_at: string;
  /** How: "Ticked on the booking page", or her own note. */
  marketing_ok_note: string | null;
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
