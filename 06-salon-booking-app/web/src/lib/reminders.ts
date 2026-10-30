// The owner's follow-ups. Which appointments are due a one-tap WhatsApp
// reminder: she sends them once a day, so the reminder setting is counted in
// calendar days in the business's time zone (72 hours before means anything
// from tomorrow up to three days ahead). And what's still owed for a late
// cancellation, worked out the same way on Today and on the appointment.
import type { Appointment, Payment, Settings } from './types';
import { addDays, dateInZone, startOfDayInstant, todayInZone } from './time';

type Rules = Pick<Settings, 'timezone' | 'reminder_hours_before'>;
type ReminderAppt = Pick<Appointment, 'status' | 'starts_at' | 'whatsapp_reminder_sent_at'> & {
  client?: { phone_e164: string | null } | null;
};

/** 72 hours → 3 days. Never less than one (tomorrow). */
export function reminderDays(hours: number): number {
  return Math.max(1, Math.ceil(hours / 24));
}

/** The calendar dates ("YYYY-MM-DD") reminders are due for: tomorrow to today + reminderDays. */
export function reminderDates(s: Rules, now = new Date()): string[] {
  const today = todayInZone(s.timezone, now);
  return Array.from({ length: reminderDays(s.reminder_hours_before) }, (_, i) => addDays(today, i + 1));
}

/** The span to load for the reminders list: the start of today to the end of the last reminder day. */
export function reminderRange(s: Rules, now = new Date()): { fromIso: string; toIso: string } {
  const today = todayInZone(s.timezone, now);
  return {
    fromIso: startOfDayInstant(today, s.timezone).toISOString(),
    toIso: startOfDayInstant(addDays(today, reminderDays(s.reminder_hours_before) + 1), s.timezone).toISOString(),
  };
}

/** Live, still to come, inside the reminder days, not already sent, and with a mobile number. Soonest first. */
export function dueWhatsAppReminders<T extends ReminderAppt>(appts: T[], s: Rules, now = new Date()): T[] {
  const days = new Set(reminderDates(s, now));
  return appts
    .filter((a) => (a.status === 'confirmed' || a.status === 'pending_deposit')
      && new Date(a.starts_at) > now
      && days.has(dateInZone(a.starts_at, s.timezone))
      && !a.whatsapp_reminder_sent_at
      && !!a.client?.phone_e164)
    .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
}

type ChargeAppt = Pick<Appointment, 'id' | 'price_pence' | 'late_fee_pence' | 'deposit_required_pence' | 'deposit_paid_at'>;
type ChargePayment = Pick<Payment, 'appointment_id' | 'kind' | 'amount_pence'>;

/** Money recorded against a late cancellation: payments and other income linked to it (a deposit is counted separately). */
export function lateChargePayments<P extends ChargePayment>(a: Pick<Appointment, 'id'>, payments: P[]): P[] {
  return payments.filter((p) => p.appointment_id === a.id && (p.kind === 'other' || p.kind === 'payment'));
}

/**
 * A late cancellation's charge: the fee fixed when it first went late (or the
 * price), less any deposit already paid and money recorded against it since.
 * owed never goes below zero.
 */
export function lateCharge(a: ChargeAppt, payments: ChargePayment[]): { fee: number; deposit: number; received: number; owed: number } {
  const fee = a.late_fee_pence ?? a.price_pence;
  const deposit = a.deposit_paid_at ? a.deposit_required_pence : 0;
  const received = lateChargePayments(a, payments).reduce((n, p) => n + p.amount_pence, 0);
  return { fee, deposit, received, owed: Math.max(0, fee - deposit - received) };
}
