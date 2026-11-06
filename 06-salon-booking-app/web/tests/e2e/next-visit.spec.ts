import { expect, test, type Page } from '@playwright/test';
import { zonedToInstant } from '../../src/lib/time';

// Booking the next visit straight after "Mark as done". The clock is fixed at 17:00 on Wednesday
// 4 November 2026 before the demo is seeded, so today's BIAB infills (Isla Morgan at 10:00,
// Grace Patel at 13:00) are over, and Amelia Hart's infill three weeks on (Wednesday 25 November,
// 12:30–13:30) is in the way of Grace's usual 13:00.
const NOW = new Date('2026-11-04T17:00:00Z');
const TODAY = '2026-11-04';
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300); // let a sheet finish sliding up
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoAppt {
  id: string; client_id: string; service_id: string | null; service_name: string; price_pence: number; duration_min: number;
  booking_name: string | null; status: string; starts_at: string; ends_at: string; busy_until: string; reference: string;
  public_token: string; is_new_client: boolean; deposit_required_pence: number;
}
interface DemoStore {
  appointments: DemoAppt[];
  clients: { id: string; full_name: string; email: string | null }[];
  hours: { weekday: number; close_time: string }[];
  time_off: { id: string; starts_at: string; ends_at: string; note: string | null }[];
  outbox: { appointment_id: string; kind: string }[];
}
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/** Change the demo's saved data; it's read when a page loads, so go to a page afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}
const iso = (day: string, hhmm: string) => zonedToInstant(day, hhmm).toISOString();
const clientId = async (page: Page, name: string) => (await demo(page)).clients.find((c) => c.full_name === name)!.id;
/** A client's booking that starts at this time. */
async function findBooking(page: Page, name: string, day: string, hhmm: string): Promise<DemoAppt> {
  const db = await demo(page);
  const client = db.clients.find((c) => c.full_name === name)!;
  const a = db.appointments.find((x) => x.client_id === client.id && x.starts_at === iso(day, hhmm));
  expect(a, `${name}'s booking at ${day} ${hhmm}`).toBeTruthy();
  return a!;
}

async function signIn(page: Page) {
  await page.clock.install({ time: NOW });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
/** Open an appointment and mark it as done with what the sheet suggests. */
async function finish(page: Page, a: DemoAppt, name: string) {
  await page.goto(`/appointments/${a.id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: 'Finish & take payment' }).click();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  return page.getByRole('dialog', { name: 'Next visit' });
}
const rows = (sheet: ReturnType<Page['getByRole']>) => sheet.locator('.od-next-row');

test('after Mark as done, the same treatment in 2, 3 or 4 weeks is one tap from a filled-in New appointment', async ({ page }) => {
  await signIn(page);
  const grace = await findBooking(page, 'Grace Patel', TODAY, '13:00');
  const sheet = await finish(page, grace, 'Grace Patel');
  await expect(sheet.locator('.od-next-done')).toHaveText('Done: £30 recorded.');
  await expect(sheet.getByRole('heading', { name: 'Book Grace’s next BIAB infill?' })).toBeVisible();
  // The same weekday and time, except in 3 weeks, when Amelia is in at 12:30: the nearest free time.
  await expect(rows(sheet)).toHaveText([
    'In 2 weeks · Wed 18 Nov, 13:00',
    'In 3 weeks · Nearest free time · Wed 25 Nov, 13:45',
    'In 4 weeks · Wed 2 Dec, 13:00',
    'Pick a date',
  ]);
  // Behind the sheet the appointment already says Done.
  await expect(page.locator('.od-hero .chip')).toHaveText('Done');
  await shot(page, 'v01-next-visit');

  await sheet.getByRole('link', { name: /In 2 weeks/ }).click();
  await expect(page.getByRole('heading', { name: 'New appointment' })).toBeVisible();
  await expect(page.locator('.od-picked-name')).toHaveText('Grace Patel');
  await expect(page.getByLabel('Treatment').locator('option:checked')).toHaveText('BIAB infill · 1 hr · £30');
  await expect(page.getByLabel('Date')).toHaveValue('2026-11-18');
  await expect(page.locator('.slot.on')).toHaveText('13:00');
  // A returning client now: no deposit. She has an email, so the confirmation is ticked.
  await expect(page.getByLabel(/Ask for a £10 deposit/)).not.toBeChecked();
  await expect(page.getByLabel('Email a confirmation to the client')).toBeChecked();
  await shot(page, 'v02-new-appointment-filled-in');
  await page.getByRole('button', { name: 'Add to diary' }).click();

  await expect(page.getByRole('heading', { name: 'Grace Patel' })).toBeVisible();
  await expect(page.locator('.od-when-day')).toHaveText('Wednesday 18 November');
  await expect(page.locator('.od-when-time')).toHaveText('13:00–14:00');
  await expect(page.locator('.od-hero .chip')).toHaveText('Confirmed');
  // The usual confirmation email (with her own change link), so no WhatsApp card.
  await expect(page.getByRole('region', { name: 'Added to your diary' })).toHaveCount(0);
  const db = await demo(page);
  const added = db.appointments.find((a) => a.starts_at === iso('2026-11-18', '13:00'))!;
  expect(added).toMatchObject({ client_id: grace.client_id, service_id: grace.service_id, service_name: 'BIAB infill', status: 'confirmed',
    deposit_required_pence: 0, is_new_client: false });
  expect(db.outbox.filter((o) => o.appointment_id === added.id).map((o) => o.kind)).toEqual(['booking_received']);
});

test('it never offers a clash, time off or a time outside opening hours; Not now and Pick a date', async ({ page }) => {
  await signIn(page);
  // A day off on Wednesday 18 November, and Wednesdays closing at 13:30 from now on.
  await editDemo(page, (db) => {
    db.time_off.push({ id: 'off-18', starts_at: iso('2026-11-18', '00:00'), ends_at: iso('2026-11-19', '00:00'), note: 'Holiday' });
    db.hours.find((h) => h.weekday === 3)!.close_time = '13:30';
  });
  const grace = await findBooking(page, 'Grace Patel', TODAY, '13:00');
  let sheet = await finish(page, grace, 'Grace Patel');
  await expect(rows(sheet)).toHaveText([
    // Off on the Wednesday: 13:00 on Tuesday and Thursday are as near, so the later.
    'In 2 weeks · Nearest free time · Thu 19 Nov, 13:00',
    // Closing at 13:30 with Amelia in from 12:30: the hour, and its clean-up time, has to end by 12:30.
    'In 3 weeks · Nearest free time · Wed 25 Nov, 11:15',
    // Closing at 13:30: 12:30 is the last time an hour fits.
    'In 4 weeks · Nearest free time · Wed 2 Dec, 12:30',
    'Pick a date',
  ]);
  await sheet.getByRole('button', { name: 'Not now' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.od-hero .chip')).toHaveText('Done');

  // Isla's from this morning: Pick a date starts on the client and treatment, and the time is hers to pick.
  const isla = await findBooking(page, 'Isla Morgan', TODAY, '10:00');
  sheet = await finish(page, isla, 'Isla Morgan');
  await sheet.getByRole('link', { name: 'Pick a date' }).click();
  await expect(page.getByRole('heading', { name: 'New appointment' })).toBeVisible();
  await expect(page.locator('.od-picked-name')).toHaveText('Isla Morgan');
  await expect(page.getByLabel('Treatment').locator('option:checked')).toHaveText('BIAB infill · 1 hr · £30');
  await expect(page.getByLabel('Date')).toHaveValue(TODAY);
  await expect(page.locator('.slot.on')).toHaveCount(0);
});

test('a client with no email: once it’s saved, Send on WhatsApp uses her own “Booking confirmed” wording', async ({ page }) => {
  await signIn(page);
  // Her own wording, in Settings → WhatsApp messages.
  await page.goto('/settings/messages');
  await page.getByLabel('Booking confirmed').fill('Hi {first_name}! You’re booked for {service} on {date} at {time}. {change_note} Love, {business}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // Chloe Bennett (no email address) came in at 15:00 today.
  const chloe = await clientId(page, 'Chloe Bennett');
  await editDemo(page, (db) => {
    const usual = db.appointments.find((a) => a.client_id === chloe && a.status === 'confirmed')!;
    db.appointments.push({ ...usual, id: 'chloe-today', reference: 'CHLOE1', public_token: '00000000-0000-4000-8000-0000000000c1',
      starts_at: iso(TODAY, '15:00'), ends_at: iso(TODAY, '15:45'), busy_until: iso(TODAY, '15:55') });
  });
  const sheet = await finish(page, (await demo(page)).appointments.find((a) => a.id === 'chloe-today')!, 'Chloe Bennett');
  await expect(sheet.locator('.od-next-done')).toHaveText('Done: £25 recorded.');
  await expect(sheet.getByRole('heading', { name: 'Book Chloe’s next Gel polish — hands?' })).toBeVisible();
  // She's booked in tomorrow already, so she isn't booked twice by mistake.
  await expect(sheet.getByText('Chloe is already booked in for Gel polish — hands on Thu 5 Nov, 11:00.')).toBeVisible();
  await sheet.getByRole('link', { name: 'In 2 weeks · Wed 18 Nov, 15:00' }).click();

  await expect(page.getByRole('heading', { name: 'New appointment' })).toBeVisible();
  await expect(page.locator('.slot.on')).toHaveText('15:00');
  await expect(page.getByLabel('Email a confirmation to the client')).toHaveCount(0);
  await page.getByRole('button', { name: 'Add to diary' }).click();

  await expect(page.getByRole('heading', { name: 'Chloe Bennett' })).toBeVisible();
  const card = page.getByRole('region', { name: 'Added to your diary' });
  await expect(card).toContainText('Chloe has no email address, so no confirmation email goes. Send your “Booking confirmed” message on WhatsApp instead.');
  const href = await card.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/447700900105\?text=/);
  expect(decodeURIComponent(href!.split('text=')[1])).toMatch(new RegExp(
    '^Hi Chloe! You’re booked for Gel polish — hands on Wednesday 18 November at 15:00\\. '
    + 'Need to change or cancel\\? Please do it by Monday 16 November at 15:00: http://localhost:\\d+/manage/[0-9a-f-]{36} Love, Demo Nail Studio$'));
  await shot(page, 'v03-added-send-on-whatsapp');
  // Nothing was emailed, and nothing is sent until she presses send in WhatsApp.
  const added = (await demo(page)).appointments.find((a) => a.starts_at === iso('2026-11-18', '15:00'))!;
  expect((await demo(page)).outbox.filter((o) => o.appointment_id === added.id)).toEqual([]);
  // Opened again later from the diary, it's an ordinary appointment.
  await page.goto('/diary?d=2026-11-18');
  await page.locator('.dy-day').getByRole('link', { name: /Chloe Bennett/ }).click();
  await expect(page.getByRole('heading', { name: 'Chloe Bennett' })).toBeVisible();
  await expect(page.locator('.od-hero .chip')).toHaveText('Confirmed');
  await expect(card).toHaveCount(0);
});

test('the client record’s Book an appointment starts on their last treatment', async ({ page }) => {
  await signIn(page);
  // Isla: today's BIAB infill. Her gel toes tomorrow was cancelled, so it doesn't count.
  await page.goto(`/clients/${await clientId(page, 'Isla Morgan')}`);
  await page.getByRole('link', { name: 'Book an appointment' }).click();
  await expect(page.locator('.od-picked-name')).toHaveText('Isla Morgan');
  await expect(page.getByLabel('Treatment').locator('option:checked')).toHaveText('BIAB infill · 1 hr · £30');

  // Chloe's latest is something not on the list: it comes back as "Something else…" with its details.
  const chloe = await clientId(page, 'Chloe Bennett');
  await editDemo(page, (db) => {
    const usual = db.appointments.find((a) => a.client_id === chloe && a.status === 'confirmed')!;
    db.appointments.push({ ...usual, id: 'chloe-repair', reference: 'REPAIR', public_token: '00000000-0000-4000-8000-0000000000c2',
      service_id: null, service_name: 'Nail repair', duration_min: 20, price_pence: 800,
      starts_at: iso('2026-11-09', '10:00'), ends_at: iso('2026-11-09', '10:20'), busy_until: iso('2026-11-09', '10:30') });
  });
  await page.goto(`/clients/${chloe}`);
  const book = page.getByRole('link', { name: 'Book an appointment' });
  await expect(book).toHaveAttribute('href', `/appointments/new?client=${chloe}&service=custom&name=Nail+repair&mins=20&price=8`);
  await book.click();
  await expect(page.getByLabel('Treatment')).toHaveValue('custom');
  await expect(page.getByLabel('Name')).toHaveValue('Nail repair');
  await expect(page.getByLabel('Minutes')).toHaveValue('20');
  await expect(page.getByLabel('Price (£)')).toHaveValue('8');
});

test('a time in the link that has gone since is cleared, with a note', async ({ page }) => {
  await signIn(page);
  const grace = await findBooking(page, 'Grace Patel', TODAY, '13:00');
  // Amelia is in at 12:30 that day.
  await page.goto(`/appointments/new?client=${grace.client_id}&service=${grace.service_id}&d=2026-11-25&t=12%3A30`);
  await expect(page.getByText('12:30 isn’t free any more. Pick another time.')).toBeVisible();
  await expect(page.locator('.slot.on')).toHaveCount(0);
  await page.getByRole('button', { name: '11:15' }).click();
  await expect(page.getByText('isn’t free any more')).toHaveCount(0);
  await expect(page.locator('.slot.on')).toHaveText('11:15');
});
