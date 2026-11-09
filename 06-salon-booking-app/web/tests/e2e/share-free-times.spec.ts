import { expect, test, type Page } from '@playwright/test';
import { zonedToInstant } from '../../src/lib/time';

// Share free times, from Today's booking-link card. The clock is fixed at 17:00 on Wednesday
// 4 November 2026 before the demo is seeded. Booked in the demo that week: Chloe Bennett on
// Thursday at 11:00 and Sophie Turner at 14:00, Ruby Clarke on Saturday at 10:30, and Monday
// 9 November is a training day (time off). BIAB infill is the most-booked treatment.
const NOW = new Date('2026-11-04T17:00:00Z');
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300); // let a sheet finish sliding up
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoStore {
  settings: { booking_enabled: boolean };
  services: { id: string; name: string; online_bookable: boolean }[];
  time_off: { id: string; starts_at: string; ends_at: string; note: string | null }[];
}
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/** Change the demo's saved data; it's read when a page loads, so reload afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}

async function signIn(page: Page) {
  await page.clock.install({ time: NOW });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
async function openSheet(page: Page) {
  await page.getByRole('button', { name: 'Share free times' }).click();
  const sheet = page.getByRole('dialog', { name: 'Share free times' });
  await expect(sheet).toBeVisible();
  return sheet;
}
const origin = (page: Page) => new URL(page.url()).origin;

const WEEK = 'Spaces for BIAB infill: Thu 5 Nov 9:30am, 6pm · Fri 6 Nov 9:30am, 3:45pm · Sat 7 Nov 9am, 2pm · Tue 10 Nov 9:30am, 3:45pm.';
const FORTNIGHT = 'Spaces for BIAB infill: Thu 5 Nov 9:30am · Fri 6 Nov 3:45pm · Tue 10 Nov 9:30am · Wed 11 Nov 3:45pm · '
  + 'Thu 12 Nov 9:30am · Fri 13 Nov 3:45pm · Mon 16 Nov 9:30am · Tue 17 Nov 3:45pm.';

test('Share free times writes this week’s real gaps for her most-booked treatment, and Copy copies it', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  const sheet = await openSheet(page);
  // Most-booked first, then her own order.
  await expect(sheet.getByLabel('Treatment').locator('option')).toHaveText(
    ['BIAB infill', 'Gel polish — hands', 'BIAB new set', 'Acrylic full set', 'Gel polish — toes', 'Removal only']);
  await expect(sheet.getByLabel('Treatment')).toHaveValue((await demo(page)).services.find((s) => s.name === 'BIAB infill')!.id);
  await expect(sheet.getByRole('radio', { name: 'This week' })).toHaveAttribute('aria-checked', 'true');
  await expect(sheet.locator('.od-share-range')).toHaveText('Wed 4 Nov to Tue 10 Nov');
  // Today is inside the 12 hours' notice, Sunday is closed and Monday is time off. At most 8 times,
  // spread over the days, each a separate space around what's booked. The link says it came from a
  // free-times post, so Money can count the new clients it brings.
  const message = `${WEEK} Book here: ${origin(page)}/book?treatment=biab-infill&from=free-times`;
  await expect(sheet.locator('.od-share-msg')).toHaveText(message);
  await expect(sheet.getByText('Only times clients can book online now. Post it on your Story or Status, or send it to someone who’s asked.')).toBeVisible();
  await shot(page, 's01-share-free-times');

  // This browser has no share sheet, so Copy is the way to share it.
  await expect(sheet.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Copy message' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Message copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(message);

  // The next 2 weeks: more days than times, so 8 days spread out, alternately early and late.
  await sheet.getByRole('radio', { name: 'Next 2 weeks' }).click();
  await expect(sheet.locator('.od-share-range')).toHaveText('Wed 4 Nov to Tue 17 Nov');
  await expect(sheet.locator('.od-share-msg')).toHaveText(`${FORTNIGHT} Book here: ${origin(page)}/book?treatment=biab-infill&from=free-times`);

  // Another treatment: its own times and its own link.
  await sheet.getByLabel('Treatment').selectOption({ label: 'Gel polish — hands' });
  await expect(sheet.locator('.od-share-msg')).toContainText('Spaces for Gel polish — hands: ');
  await expect(sheet.locator('.od-share-msg')).toContainText(`Book here: ${origin(page)}/book?treatment=gel-polish-hands&from=free-times`);
});

test('every time it lists can be booked from the link, which opens straight on that treatment', async ({ page }) => {
  await signIn(page);
  const sheet = await openSheet(page);
  const message = (await sheet.locator('.od-share-msg').textContent())!;
  const link = message.split('Book here: ')[1];
  expect(link).toBe(`${origin(page)}/book?treatment=biab-infill&from=free-times`);

  await page.goto(link);
  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await expect(page.locator('.chosen-name')).toHaveText('BIAB infill');
  await expect(page.locator('.pub-steps [aria-current="step"]')).toContainText('Time');
  const listed: Record<string, string[]> = { 5: ['09:30', '18:00'], 6: ['09:30', '15:45'], 7: ['09:00', '14:00'], 10: ['09:30', '15:45'] };
  for (const [day, times] of Object.entries(listed)) {
    // The strip runs 60 days ahead, so the month too (5 December is in it).
    await page.locator('.date-pill', { has: page.locator('.dom', { hasText: new RegExp(`^${day}$`) }) })
      .filter({ has: page.locator('.mon', { hasText: 'Nov' }) }).click();
    for (const t of times) await expect(page.locator('.slot', { hasText: t })).toHaveCount(1);
  }
  await shot(page, 's02-book-linked');
  // From there it's the usual booking: Tuesday's 3:45pm, as listed.
  await page.locator('.slot', { hasText: '15:45' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.ticket-title')).toContainText('BIAB infill');
  await expect(page.locator('.ticket-when')).toHaveText('Tuesday 10 November at 15:45');
});

test('Share opens the phone’s share sheet with the message', async ({ page }) => {
  // A phone's share sheet: keep what it was given.
  await page.addInitScript(() => {
    const w = window as unknown as { shared: unknown[] };
    w.shared = [];
    Object.defineProperty(navigator, 'share', { value: async (data: unknown) => { w.shared.push(data); }, configurable: true });
  });
  await signIn(page);
  const sheet = await openSheet(page);
  await sheet.getByRole('button', { name: 'Share', exact: true }).click();
  const shared = await page.evaluate(() => (window as unknown as { shared: unknown[] }).shared);
  expect(shared).toEqual([{ text: `${WEEK} Book here: ${origin(page)}/book?treatment=biab-infill&from=free-times` }]);
  await expect(sheet.getByRole('button', { name: 'Copy', exact: true })).toBeVisible();
});

test('with nothing free, or booking paused, it says so plainly', async ({ page }) => {
  await signIn(page);
  // Away until Wednesday 11 November.
  await editDemo(page, (db) => {
    db.time_off.push({ id: 'away', starts_at: zonedToInstant('2026-11-04', '00:00').toISOString(),
      ends_at: zonedToInstant('2026-11-11', '00:00').toISOString(), note: 'Away' });
  });
  await page.reload();
  let sheet = await openSheet(page);
  await expect(sheet.locator('.od-share-none')).toHaveText(
    'No free times for BIAB infill from Wed 4 Nov to Tue 10 Nov that clients could book online. Try the next 2 weeks.');
  await expect(sheet.getByRole('button', { name: /Copy|Share/ })).toHaveCount(0);
  await shot(page, 's03-share-nothing-free');
  await sheet.getByRole('radio', { name: 'Next 2 weeks' }).click();
  await expect(sheet.locator('.od-share-msg')).toContainText('Spaces for BIAB infill: Wed 11 Nov');

  // Online booking paused: nothing a client could book.
  await editDemo(page, (db) => { db.settings.booking_enabled = false; });
  await page.reload();
  sheet = await openSheet(page);
  await expect(sheet.locator('.od-share-none')).toHaveText(
    'Online booking is paused, so clients can’t book any times at the moment. You can open it again in Settings → Business details.');
  await expect(sheet.getByLabel('Treatment')).toHaveCount(0);

  // No treatment bookable online.
  await editDemo(page, (db) => {
    db.settings.booking_enabled = true;
    for (const s of db.services) s.online_bookable = false;
  });
  await page.reload();
  sheet = await openSheet(page);
  await expect(sheet.locator('.od-share-none')).toHaveText('None of your treatments can be booked online yet. Choose which can in Settings → Treatments & prices.');
});

test('the booking page opens on the treatment its link names; anything else opens the usual page', async ({ page }) => {
  await page.goto('/book?treatment=biab-infill');
  await expect(page.locator('.chosen-name')).toHaveText('BIAB infill');
  // Change goes back to the whole menu.
  await page.getByRole('button', { name: 'Change treatment' }).click();
  await expect(page.getByRole('button', { name: /Gel polish — hands/ })).toBeVisible();

  // By id too, which is what a link uses when two treatments' names read the same.
  const gel = (await demo(page)).services.find((s) => s.name === 'Gel polish — hands')!;
  await page.goto(`/book?treatment=${gel.id}`);
  await expect(page.locator('.chosen-name')).toHaveText('Gel polish — hands');

  // Unknown (renamed, say): the usual page, with the policy first.
  await page.goto('/book?treatment=nail-art-masterclass');
  await expect(page.getByRole('note', { name: 'Cancellation policy' })).toBeVisible();
  await expect(page.getByRole('button', { name: /BIAB infill/ })).toBeVisible();
  await expect(page.locator('.chosen-name')).toHaveCount(0);

  // Not bookable online any more: the usual page.
  await editDemo(page, (db) => { db.services.find((s) => s.name === 'Removal only')!.online_bookable = false; });
  await page.goto('/book?treatment=removal-only');
  await expect(page.getByRole('button', { name: /BIAB infill/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Removal only/ })).toHaveCount(0);
  await expect(page.locator('.chosen-name')).toHaveCount(0);
});
