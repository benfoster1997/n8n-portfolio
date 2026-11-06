import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_DUE_DAYS, backupAgeDays, backupDue, daysBetween, finishedTaxYear, lastBackupText, readLastBackup, rememberBackup,
  rememberSpreadsheet, spreadsheetSaved,
} from '../../src/lib/backup';
import { fileSize, firstShareable, isAbort, saveFile, type ShareNavigator } from '../../src/lib/files';

// Backups that really save on her iPhone: the share sheet where the phone can share the file
// (she chooses Save to Files), a download where it can't, and the date of the last one kept
// on the phone for the "Last backup" line and Today's monthly reminder.
const TZ = 'Europe/London';

/** A stand-in for the browser's localStorage. */
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, String(v)); },
  };
}
/** Storage that refuses everything, as in some private modes. */
const blocked = {
  getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceededError'); },
} as unknown as Storage;

describe('the last backup, kept on this phone', () => {
  it('remembers when she saved one, and reads it back', () => {
    const store = memoryStorage();
    expect(readLastBackup(store)).toBeNull();
    rememberBackup(new Date('2026-11-03T10:15:00Z'), store);
    expect(readLastBackup(store)).toBe('2026-11-03T10:15:00.000Z');
  });

  it('storage that’s blocked or full: no date, and nothing breaks', () => {
    expect(() => rememberBackup(new Date(), blocked)).not.toThrow();
    expect(readLastBackup(blocked)).toBeNull();
    expect(readLastBackup(null)).toBeNull();
    const store = memoryStorage();
    store.setItem('salon-last-backup', 'not a date');
    expect(readLastBackup(store)).toBeNull();
  });

  it('“Last backup: Tue 3 Nov (33 days ago)”', () => {
    expect(lastBackupText('2026-11-03T10:15:00.000Z', new Date('2026-12-06T09:00:00Z'), TZ)).toBe('Tue 3 Nov (33 days ago)');
    expect(lastBackupText('2026-12-06T07:00:00.000Z', new Date('2026-12-06T21:00:00Z'), TZ)).toBe('Sun 6 Dec (today)');
    expect(lastBackupText('2026-12-05T22:00:00.000Z', new Date('2026-12-06T21:00:00Z'), TZ)).toBe('Sat 5 Dec (yesterday)');
    // From another calendar year, with its year.
    expect(lastBackupText('2025-12-30T12:00:00.000Z', new Date('2026-01-07T12:00:00Z'), TZ)).toBe('Tue 30 Dec 2025 (8 days ago)');
  });

  it('days are counted by the calendar in London, not by 24 hours or by UTC', () => {
    // 00:30 on 1 June in London is still 31 May in UTC.
    expect(backupAgeDays('2026-05-31T23:30:00.000Z', new Date('2026-06-02T08:00:00Z'), TZ)).toBe(1);
    // 23:50 one evening to 00:10 the next morning: a day ago.
    expect(backupAgeDays('2026-11-03T23:50:00.000Z', new Date('2026-11-04T00:10:00Z'), TZ)).toBe(1);
    expect(daysBetween('2026-10-24', '2026-11-28')).toBe(35);
  });

  it('Today says it’s time after about five weeks, or when there has never been one on this phone', () => {
    expect(BACKUP_DUE_DAYS).toBe(35);
    expect(backupDue(null, new Date('2026-11-06T09:00:00Z'), TZ)).toBe(true);
    expect(backupDue('2026-10-03T09:00:00.000Z', new Date('2026-11-06T09:00:00Z'), TZ)).toBe(false); // 34 days
    expect(backupDue('2026-10-02T09:00:00.000Z', new Date('2026-11-06T09:00:00Z'), TZ)).toBe(true); // 35 days
  });
});

describe('the finished tax year’s spreadsheet', () => {
  it('asked for from 6 April until that year’s return is due on 31 January', () => {
    expect(finishedTaxYear('2027-04-05')).toBeNull();
    expect(finishedTaxYear('2027-04-06')).toBe(2026);
    expect(finishedTaxYear('2027-11-06')).toBe(2026);
    expect(finishedTaxYear('2028-01-31')).toBe(2026);
    expect(finishedTaxYear('2028-02-01')).toBeNull();
    expect(finishedTaxYear('2028-03-31')).toBeNull();
  });

  it('remembered for each tax year once she saves it', () => {
    const store = memoryStorage();
    expect(spreadsheetSaved(2026, store)).toBe(false);
    rememberSpreadsheet(2026, new Date('2027-04-10T10:00:00Z'), store);
    expect(spreadsheetSaved(2026, store)).toBe(true);
    expect(spreadsheetSaved(2027, store)).toBe(false);
    expect(spreadsheetSaved(2026, blocked)).toBe(false);
    expect(() => rememberSpreadsheet(2026, new Date(), blocked)).not.toThrow();
  });
});

describe('saving a file: the share sheet where the phone can, a download where it can’t', () => {
  const json = new File(['{"clients":[]}'], 'bookings-backup-2026-11-06.json', { type: 'application/json' });
  const txt = new File(['{"clients":[]}'], 'bookings-backup-2026-11-06.txt', { type: 'text/plain' });
  /** A phone whose share sheet takes these kinds of file, and remembers what it was given. */
  function phone(takes: string[], share: (d: ShareData) => Promise<void> = async () => {}) {
    const shared: ShareData[] = [];
    const nav: ShareNavigator = {
      canShare: (d) => !!d?.files?.length && d.files.every((f) => takes.includes(f.type)),
      share: async (d) => { shared.push(d); await share(d); },
    };
    return { nav, shared };
  }
  afterEach(() => { vi.unstubAllGlobals(); });

  it('JSON when the share sheet takes it', () => {
    expect(firstShareable([json, txt], phone(['application/json', 'text/plain']).nav)).toBe(json);
  });
  it('plain text when that’s all it takes (MDN lists text files as shareable, not JSON)', () => {
    expect(firstShareable([json, txt], phone(['text/plain']).nav)).toBe(txt);
  });
  it('none: no share sheet, no way to check, or a check that throws', () => {
    expect(firstShareable([json, txt], phone([]).nav)).toBeNull();
    expect(firstShareable([json, txt], undefined)).toBeNull();
    expect(firstShareable([json, txt], { share: async () => {} })).toBeNull(); // an older phone: links only, no files
    expect(firstShareable([json, txt], { share: async () => {}, canShare: () => { throw new TypeError('bad'); } })).toBeNull();
  });

  it('shares only the file (text or a title alongside it can arrive in Files as a second item)', async () => {
    const { nav, shared } = phone(['application/json']);
    await expect(saveFile([json, txt], nav)).resolves.toBe('shared');
    expect(shared).toEqual([{ files: [json] }]);
  });

  it('closing the share sheet is an AbortError, and nothing is downloaded', async () => {
    const created = vi.fn(() => 'blob:x');
    vi.stubGlobal('URL', { createObjectURL: created, revokeObjectURL: () => {} });
    const { nav } = phone(['application/json'], async () => { throw new DOMException('Share canceled', 'AbortError'); });
    const err = await saveFile([json, txt], nav).catch((e) => e);
    expect(isAbort(err)).toBe(true);
    expect(created).not.toHaveBeenCalled();
    expect(isAbort(new TypeError('Load failed'))).toBe(false);
    expect(isAbort(null)).toBe(false);
  });

  it('no share sheet for it: downloads the first file through a link', async () => {
    const clicked: { href: string; download: string }[] = [];
    const link = { href: '', download: '', click() { clicked.push({ href: this.href, download: this.download }); }, remove() {} };
    vi.stubGlobal('document', { createElement: () => link, body: { appendChild: () => {} } });
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:backup', revokeObjectURL: () => {} });
    await expect(saveFile([json, txt], phone([]).nav)).resolves.toBe('downloaded');
    expect(clicked).toEqual([{ href: 'blob:backup', download: 'bookings-backup-2026-11-06.json' }]);
  });

  it('shows the size of what’s ready', () => {
    expect(fileSize(300)).toBe('1 KB');
    expect(fileSize(181_000)).toBe('177 KB');
    expect(fileSize(2_500_000)).toBe('2.4 MB');
  });
});
