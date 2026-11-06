import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Backups that really save on her iPhone, and the Money spreadsheet saved the same way. The
// clock is fixed at 09:00 on Friday 6 November 2026 before the demo is seeded. Chromium on Linux
// has no share sheet, so it downloads instead; an iPhone's share sheet is stood in for by
// `iPhoneShareSheet`, which keeps what it was given.
const NOW = new Date('2026-11-06T09:00:00Z');
const KEY = 'salon-demo-v4';
const LAST_BACKUP = 'salon-last-backup';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function signIn(page: Page, now = NOW) {
  await page.clock.install({ time: now });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

interface Shared { name: string; type: string; text: string; bom: boolean }
/**
 * A share sheet like an iPhone's: it takes the kinds of file in `takes`, and `answer` says what
 * she does with it: chooses somewhere (Save to Files), closes it, or it can't open.
 */
async function iPhoneShareSheet(page: Page, takes: string[], answer: 'save' | 'close' | 'fail' = 'save') {
  await page.addInitScript(([types, how]) => {
    const w = window as unknown as { __shared: Shared[] };
    w.__shared = [];
    Object.defineProperty(navigator, 'canShare', {
      configurable: true, value: (d?: ShareData) => !!d?.files?.length && d.files.every((f) => (types as string[]).includes(f.type)),
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async (d: ShareData) => {
        for (const f of d.files ?? []) {
          const b = new Uint8Array(await f.arrayBuffer());
          w.__shared.push({ name: f.name, type: f.type, text: await f.text(), bom: b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf });
        }
        if (Object.keys(d).some((k) => k !== 'files')) throw new Error('only the file should be shared');
        if (how === 'close') throw new DOMException('Share canceled', 'AbortError');
        if (how === 'fail') throw new DOMException('Not allowed', 'NotAllowedError');
      },
    });
  }, [takes, answer] as const);
}
const shared = (page: Page): Promise<Shared[]> => page.evaluate(() => (window as unknown as { __shared: Shared[] }).__shared);
const lastBackup = (page: Page) => page.evaluate((k) => localStorage.getItem(k), LAST_BACKUP);
const backupLine = (page: Page) => page.getByRole('link', { name: /Time for your monthly backup/ });

test('backup: get it ready, then save it; the date is kept on the phone and Today stops asking', async ({ page }) => {
  await signIn(page);
  // Never backed up on this phone: Today asks, and the line opens Back up your data.
  await expect(backupLine(page)).toContainText('There’s no backup saved on this phone yet.');
  await shot(page, 'b01-today-backup-line');
  await backupLine(page).click();
  await expect(page.getByRole('heading', { name: 'Back up your data' })).toBeVisible();
  await expect(page.getByText('The free database plan gives you no backup you can download or restore yourself, so save one at the start of each month.')).toBeVisible();
  await expect(page.getByText('Last backup: none saved on this phone yet')).toBeVisible();

  await page.getByRole('button', { name: 'Get backup ready' }).click();
  const ready = page.getByRole('region', { name: 'Your backup' });
  await expect(ready).toContainText('Your backup is ready');
  await expect(ready).toContainText('bookings-backup-2026-11-06.json');
  await expect(ready.getByText('Choose Save to Files (iCloud Drive). Don’t send it by WhatsApp or email: it has health information in it.')).toBeVisible();

  // No share sheet here, so it downloads: the whole demo, without the sign-in.
  const [download] = await Promise.all([page.waitForEvent('download'), ready.getByRole('button', { name: 'Save backup' }).click()]);
  expect(download.suggestedFilename()).toBe('bookings-backup-2026-11-06.json');
  const backup = JSON.parse(await readFile((await download.path())!, 'utf8'));
  expect(backup.clients.map((c: { full_name: string }) => c.full_name)).toContain('Grace Patel');
  expect(backup.appointments.length).toBeGreaterThan(10);
  expect(backup).not.toHaveProperty('session');
  // It never says it was saved: it asks her to check.
  await expect(ready.getByRole('status')).toHaveText('Check it’s in Files, in Downloads.');
  await expect(page.getByText(/Backup downloaded|Backup saved/)).toHaveCount(0);
  await expect(page.getByText('Last backup: Fri 6 Nov (today)')).toBeVisible();
  expect(await lastBackup(page)).toMatch(/^2026-11-06T09:0\d:\d\d\.\d{3}Z$/);
  await shot(page, 'b02-backup-downloaded');

  // Kept on this phone: Today stops asking, and Settings says when.
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(backupLine(page)).toHaveCount(0);
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.getByRole('link', { name: /Back up your data/ })).toContainText('Last backup Fri 6 Nov');
});

test('on an iPhone the backup goes to the share sheet, as the one file, for Save to Files', async ({ page }) => {
  await iPhoneShareSheet(page, ['application/json', 'text/plain']);
  await signIn(page);
  await page.goto('/settings/backup');
  await page.getByRole('button', { name: 'Get backup ready' }).click();
  const ready = page.getByRole('region', { name: 'Your backup' });
  await ready.getByRole('button', { name: 'Save backup' }).click();
  await expect(ready.getByRole('status')).toHaveText('Check it’s in Files, in iCloud Drive.');
  const files = await shared(page);
  expect(files.map((f) => [f.name, f.type])).toEqual([['bookings-backup-2026-11-06.json', 'application/json']]);
  expect(JSON.parse(files[0].text).clients.length).toBe(7);
  await expect(page.getByText('Last backup: Fri 6 Nov (today)')).toBeVisible();
  await shot(page, 'b03-backup-shared');
});

test('a share sheet that only takes text files gets the backup as a .txt', async ({ page }) => {
  await iPhoneShareSheet(page, ['text/plain']);
  await signIn(page);
  await page.goto('/settings/backup');
  await page.getByRole('button', { name: 'Get backup ready' }).click();
  await page.getByRole('button', { name: 'Save backup' }).click();
  await expect(page.getByRole('status')).toHaveText('Check it’s in Files, in iCloud Drive.');
  const files = await shared(page);
  expect(files.map((f) => [f.name, f.type])).toEqual([['bookings-backup-2026-11-06.txt', 'text/plain']]);
  expect(JSON.parse(files[0].text).clients.length).toBe(7);
});

test('closing the share sheet saves nothing and keeps no date; one that can’t open offers a download', async ({ page }) => {
  await iPhoneShareSheet(page, ['application/json'], 'close');
  await signIn(page);
  await page.goto('/settings/backup');
  await page.getByRole('button', { name: 'Get backup ready' }).click();
  await page.getByRole('button', { name: 'Save backup' }).click();
  await expect(page.getByRole('status')).toHaveText('Not saved yet: tap Save backup and choose Save to Files.');
  expect(await lastBackup(page)).toBeNull();
  await expect(page.getByText('Last backup: none saved on this phone yet')).toBeVisible();

  // The share sheet can't open at all: she can download it instead.
  await page.evaluate(() => Object.defineProperty(navigator, 'share', {
    configurable: true, value: async () => { throw new DOMException('Not allowed', 'NotAllowedError'); },
  }));
  await page.getByRole('button', { name: 'Save backup' }).click();
  await expect(page.getByRole('alert')).toContainText('Your phone couldn’t open the share sheet for the file.');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download it instead' }).click()]);
  expect(download.suggestedFilename()).toBe('bookings-backup-2026-11-06.json');
  await expect(page.getByRole('status')).toHaveText('Check it’s in Files, in Downloads.');
  await expect(page.getByText('Last backup: Fri 6 Nov (today)')).toBeVisible();
});

test('Today reminds her about five weeks after the last backup', async ({ page }) => {
  await signIn(page);
  // 34 days ago: not yet.
  await page.evaluate((k) => localStorage.setItem(k, '2026-10-03T18:00:00.000Z'), LAST_BACKUP);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.getByText('Today’s appointments')).toBeVisible();
  await expect(backupLine(page)).toHaveCount(0);
  // 35 days ago: time for the monthly backup.
  await page.evaluate((k) => localStorage.setItem(k, '2026-10-02T18:00:00.000Z'), LAST_BACKUP);
  await page.reload();
  await expect(backupLine(page)).toContainText('Your last one was Fri 2 Oct, 35 days ago.');
  await backupLine(page).click();
  await expect(page.getByText('Last backup: Fri 2 Oct (35 days ago)')).toBeVisible();
});

test('the Money spreadsheet goes to the share sheet the same way', async ({ page }) => {
  await iPhoneShareSheet(page, ['text/csv']);
  await signIn(page);
  await page.getByRole('link', { name: 'Money', exact: true }).click();
  await expect(page.getByText('Choose Save to Files, or send it to your accountant.')).toBeVisible();
  await page.getByRole('button', { name: 'Save spreadsheet (CSV)' }).click();
  await expect(page.getByText('Check it’s in Files')).toBeVisible();
  const files = await shared(page);
  expect(files.map((f) => [f.name, f.type])).toEqual([['takings-2026-11.csv', 'text/csv']]);
  // With the byte-order mark that makes Excel read the £ signs right.
  expect(files[0].bom).toBe(true);
  expect(files[0].text.startsWith('Date,Client,Description,Type,Paid by,Amount (£),Note')).toBe(true);
  await shot(page, 'b04-money-spreadsheet');
});

test('after 5 April, Today asks once for the finished tax year’s spreadsheet', async ({ page }) => {
  // Saturday 10 April 2027: the demo's takings from the fortnight before are in 2026–27, which ended on 5 April.
  await signIn(page, new Date('2027-04-10T09:00:00Z'));
  const line = page.getByRole('link', { name: /Save your 2026–27 takings spreadsheet/ });
  await expect(line).toContainText('That tax year has ended: keep a copy for your tax return and your records.');
  await line.click();
  await expect(page.getByText('Tax year 2026–27')).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save spreadsheet (CSV)' }).click()]);
  expect(download.suggestedFilename()).toBe('takings-tax-year-2026-27.csv');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByText('Today’s appointments')).toBeVisible();
  await expect(line).toHaveCount(0);
});
