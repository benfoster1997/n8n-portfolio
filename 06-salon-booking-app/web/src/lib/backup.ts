// When she last saved a backup, and whether she has saved a finished tax year's spreadsheet.
// Both are kept on this phone (in the browser), not in the database. If Safari's data is
// cleared they're forgotten, which only means a reminder comes early.
import { dateInZone, fmt, fmtDay, todayInZone } from './time';

const LAST_BACKUP = 'salon-last-backup';
const sheetKey = (taxYearStart: number) => `salon-tax-year-sheet-${taxYearStart}`;

/** About five weeks: Today says it's time for the monthly backup once the last one is this many days old. */
export const BACKUP_DUE_DAYS = 35;

/** The browser's storage, or null where it's blocked (some private modes throw just for asking). */
function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}
function read(key: string, store: Storage | null): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}
function write(key: string, value: string, store: Storage | null) {
  try {
    store?.setItem(key, value);
  } catch { /* full or blocked: the reminder just comes early */ }
}

/** When she last saved or downloaded a backup on this phone (an ISO time), or null. */
export function readLastBackup(store: Storage | null = storage()): string | null {
  const v = read(LAST_BACKUP, store);
  return v && !Number.isNaN(Date.parse(v)) ? v : null;
}
export function rememberBackup(at: Date = new Date(), store: Storage | null = storage()) {
  write(LAST_BACKUP, at.toISOString(), store);
}

/** Whole days from one yyyy-mm-dd to a later one. */
export function daysBetween(from: string, to: string): number {
  const day = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d) / 86400e3;
  };
  return Math.round(day(to) - day(from));
}

/** How many days ago a backup was, by the calendar in the business's time zone (0 = today). */
export function backupAgeDays(lastIso: string, now: Date, tz: string): number {
  return Math.max(0, daysBetween(dateInZone(lastIso, tz), todayInZone(tz, now)));
}

/** "Tue 3 Nov (33 days ago)", "Fri 6 Nov (today)"; one from another calendar year has its year: "Tue 30 Dec 2025 (8 days ago)". */
export function lastBackupText(lastIso: string, now: Date, tz: string): string {
  const days = backupAgeDays(lastIso, now, tz);
  const sameYear = fmt(lastIso, 'yyyy', tz) === fmt(now, 'yyyy', tz);
  const date = sameYear ? fmtDay(lastIso, tz) : fmt(lastIso, 'EEE d MMM yyyy', tz);
  return `${date} (${days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`})`;
}

/** Time for the monthly backup: none saved on this phone yet, or the last one is about five weeks old. */
export function backupDue(lastIso: string | null, now: Date, tz: string): boolean {
  return !lastIso || backupAgeDays(lastIso, now, tz) >= BACKUP_DUE_DAYS;
}

/**
 * The tax year that has just finished, whose takings spreadsheet she should save for her
 * tax return: from 6 April until 31 January, when that year's return is due. Null from
 * 1 February to 5 April.
 */
export function finishedTaxYear(today: string): number | null {
  const [y, m, d] = today.split('-').map(Number);
  if (m > 4 || (m === 4 && d >= 6)) return y - 1;
  return m === 1 ? y - 2 : null;
}

/** Whether she has saved (or downloaded) a tax year's takings spreadsheet on this phone. */
export function spreadsheetSaved(taxYearStart: number, store: Storage | null = storage()): boolean {
  return read(sheetKey(taxYearStart), store) !== null;
}
export function rememberSpreadsheet(taxYearStart: number, at: Date = new Date(), store: Storage | null = storage()) {
  write(sheetKey(taxYearStart), at.toISOString(), store);
}
