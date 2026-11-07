import { expect, test, type Page } from '@playwright/test';
import { addDays, fmtDay, fmtDayTime, zonedToInstant } from '../../src/lib/time';

// Appointments that are over but still say Confirmed or Deposit due. The clock is fixed at
// 17:00 on a Wednesday before the demo is seeded, so its appointments are over:
// Jess Collins (a new client who booked online, never sent the deposit and never came) five
// days ago, Grace Patel four days ago, and today's two (Isla Morgan at 10:00, Grace at 13:00).
const NOW = new Date('2026-11-04T17:00:00Z'); // Wednesday 4 November, 17:00 in London
const TODAY = '2026-11-04';
const at = (day: number, hhmm: string) => fmtDayTime(zonedToInstant(addDays(TODAY, day), hhmm));
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300); // let a sheet finish sliding up
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoAppt {
  id: string; booking_name: string; status: string; starts_at: string; ends_at: string; busy_until: string; duration_min: number;
  reference: string; public_token: string;
}
interface DemoStore { appointments: DemoAppt[]; clients: { id: string; full_name: string; is_regular: boolean }[]; outbox: { appointment_id: string; kind: string }[] }
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
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
const card = (page: Page) => page.locator('.card.attention', { hasText: 'Not finished yet' });
const count = (page: Page) => card(page).locator('.td-attn-count');
const tileNote = (page: Page) => page.locator('.td-tile-main .td-tile-note');
const heroChip = (page: Page) => page.locator('.od-hero .chip');
/** Answer the next confirm() and keep what it asked. */
function answerNext(page: Page, accept: boolean): { text: string } {
  const asked = { text: '' };
  page.once('dialog', (d) => { asked.text = d.message(); void (accept ? d.accept() : d.dismiss()); });
  return asked;
}
async function backToToday(page: Page) {
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

test('Today lists appointments that are over but never finished, oldest first, until each is dealt with', async ({ page }) => {
  await signIn(page);
  await expect(count(page)).toHaveText('4');
  await expect(card(page)).toContainText('These are over but were never finished. Finish each one, or mark a no-show.');
  await expect(card(page).getByRole('link')).toHaveText([
    `${at(-5, '14:00')} · Jess Collins · BIAB new set`,
    `${at(-4, '14:00')} · Grace Patel · BIAB infill`,
    `${at(0, '10:00')} · Isla Morgan · BIAB infill`,
    `${at(0, '13:00')} · Grace Patel · BIAB infill`,
  ]);
  // Today's two are over, so the tile doesn't say "All done" while they're still to finish. It counts
  // only today's: the tile is about today, and the older two are in the card.
  await expect(tileNote(page)).toHaveText('2 to finish');
  // Jess's old unpaid booking isn't counted as a deposit still to come.
  await expect(page.locator('.card.attention', { hasText: 'Deposits waiting' })).not.toContainText('Jess Collins');
  // Isla's visit this morning is over: it's listed here, not again under No consultation form on file.
  await expect(page.locator('.card.attention', { hasText: 'No consultation form on file' })).not.toContainText('Isla Morgan');
  await shot(page, 'n01-today-not-finished');

  // Jess never paid and never came: a no-show, asked about the way it is for a new client.
  await card(page).getByRole('link', { name: /Jess Collins/ }).click();
  await expect(page.getByRole('heading', { name: 'Jess Collins' })).toBeVisible();
  await expect(heroChip(page)).toHaveText('Not finished');
  const asked = answerNext(page, true);
  await page.getByRole('button', { name: 'No-show' }).click();
  await expect(heroChip(page)).toHaveText('No-show');
  expect(asked.text).toBe('Mark Jess as a no-show? It can’t be undone, and they aren’t emailed. '
    + 'Jess hasn’t had a visit marked as done, so they’ll still be asked for a £10 deposit if they book online again.');
  await backToToday(page);
  await expect(count(page)).toHaveText('3');
  await expect(card(page).getByRole('link', { name: /Jess Collins/ })).toHaveCount(0);

  // Grace's from Saturday: finished late, with the payment.
  await card(page).getByRole('link', { name: at(-4, '14:00') }).click();
  await expect(page.getByRole('heading', { name: 'Grace Patel' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish & take payment' }).click();
  await expect(page.getByLabel('Amount paid today (£)')).toHaveValue('30.00');
  await page.getByRole('button', { name: 'Mark as done' }).click();
  // From another day, Grace isn't there to agree her next visit (and its dates would count from Saturday):
  // it just says what was recorded. A visit today offers the next one (next-visit.spec.ts).
  await expect(page.locator('.toast')).toHaveText('Done: £30 recorded.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(heroChip(page)).toHaveText('Done');
  await backToToday(page);
  await expect(count(page)).toHaveText('2');
  await expect(tileNote(page)).toHaveText('2 to finish');

  // The diary says "Not finished" for those still to do, and the rest as they are.
  await page.goto(`/diary?d=${TODAY}`);
  const day = page.locator('.dy-day');
  await expect(day.getByRole('link', { name: /Isla Morgan/ }).locator('.chip')).toHaveText('Not finished');
  await expect(day.getByRole('link', { name: /Grace Patel/ }).locator('.chip')).toHaveText('Not finished');
  await shot(page, 'n02-diary-not-finished');
  await page.goto(`/diary?d=${addDays(TODAY, -4)}`);
  await expect(day.getByRole('link', { name: /Grace Patel/ }).locator('.chip')).toHaveText('Done');
  await page.goto(`/diary?d=${addDays(TODAY, -5)}`);
  await expect(day.getByRole('link', { name: /Jess Collins/ }).locator('.chip')).toHaveText('No-show');
  // Tomorrow's still say what they are.
  await page.goto(`/diary?d=${addDays(TODAY, 1)}`);
  await expect(day.getByRole('link', { name: /Chloe Bennett/ }).locator('.chip')).toHaveText('Confirmed');
  await expect(day.getByRole('link', { name: /Sophie Turner/ }).locator('.chip')).toHaveText('Deposit due');

  // Once the last two are done, nothing is listed and today is "All done".
  await editDemo(page, (db) => {
    for (const a of db.appointments) if (a.starts_at.startsWith(TODAY) && a.status === 'confirmed') a.status = 'completed';
  });
  await page.goto('/');
  await expect(tileNote(page)).toHaveText('All done');
  await expect(card(page)).toHaveCount(0);
});

test('a long list shows the oldest five, then how many more', async ({ page }) => {
  await signIn(page);
  // Six more from the weeks before she started finishing them.
  await editDemo(page, (db) => {
    const grace = db.appointments.find((a) => a.booking_name === 'Grace Patel' && a.status === 'confirmed')!;
    for (let i = 0; i < 6; i++) {
      const starts = zonedToInstant(addDays(TODAY, -30 + i), '11:00');
      const ends = new Date(starts.getTime() + grace.duration_min * 60e3).toISOString();
      db.appointments.push({ ...grace, id: `older-${i}`, reference: `OLDER${i}`, public_token: `00000000-0000-4000-8000-00000000000${i}`,
        starts_at: starts.toISOString(), ends_at: ends, busy_until: ends });
    }
  });
  await page.reload();
  await expect(count(page)).toHaveText('10');
  // The first tile still counts only today's.
  await expect(tileNote(page)).toHaveText('2 to finish');
  const rows = card(page).getByRole('link');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText(at(-30, '11:00'));
  await expect(rows.last()).toContainText(at(-26, '11:00'));
  await expect(card(page).locator('.td-unf-more')).toHaveText('and 5 more: they’ll show here as you finish these');
  await shot(page, 'n03-today-not-finished-long');

  // Finishing the oldest brings the next one up.
  await rows.first().click();
  await page.getByRole('button', { name: 'Finish & take payment' }).click();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.locator('.toast')).toHaveText('Done: £30 recorded.');
  await expect(heroChip(page)).toHaveText('Done');
  await backToToday(page);
  await expect(count(page)).toHaveText('9');
  await expect(rows.first()).toContainText(at(-29, '11:00'));
  await expect(rows.last()).toContainText(at(-25, '11:00'));
  await expect(card(page).locator('.td-unf-more')).toHaveText('and 4 more: they’ll show here as you finish these');
  // There's no way to mark them all done at once: each needs its own payment, or a no-show.
  await expect(card(page).getByRole('button')).toHaveCount(0);
});

test('the No-show question is true for a returning client and for a regular', async ({ page }) => {
  await signIn(page);
  // Isla has had visits marked as done: she won't be asked for a deposit.
  await card(page).getByRole('link', { name: /Isla Morgan/ }).click();
  let asked = answerNext(page, false);
  await page.getByRole('button', { name: 'No-show' }).click();
  await expect.poll(() => asked.text).toBe('Mark Isla as a no-show? It can’t be undone, and they aren’t emailed. '
    + 'As Isla has had a visit marked as done before, they won’t be asked for a £10 deposit if they book online again '
    + 'with the email address on their record.');
  // Saying no leaves it as it was.
  await expect(heroChip(page)).toHaveText('Not finished');

  // A regular moved across from another app, with no visit here yet. (The demo reads its data when the page loads.)
  await editDemo(page, (db) => { db.clients.find((c) => c.full_name === 'Jess Collins')!.is_regular = true; });
  await page.goto('/');
  await card(page).getByRole('link', { name: /Jess Collins/ }).click();
  asked = answerNext(page, false);
  await page.getByRole('button', { name: 'No-show' }).click();
  await expect.poll(() => asked.text).toBe('Mark Jess as a no-show? It can’t be undone, and they aren’t emailed. '
    + 'As Jess is ticked as a regular, they won’t be asked for a £10 deposit if they book online again with the email address on their record.');
  await expect(heroChip(page)).toHaveText('Not finished');

  // Chloe has had a visit marked as done, but has no email address on her record: the booking page
  // finds clients by email, so online she'd be a new client, asked for the deposit.
  await editDemo(page, (db) => {
    const usual = db.appointments.find((a) => a.booking_name === 'Chloe Bennett' && a.status === 'confirmed')!;
    const starts = zonedToInstant(TODAY, '15:00');
    const ends = new Date(starts.getTime() + usual.duration_min * 60e3).toISOString();
    db.appointments.push({ ...usual, id: 'chloe-today', reference: 'CHLOE1', public_token: '00000000-0000-4000-8000-0000000000c1',
      starts_at: starts.toISOString(), ends_at: ends, busy_until: ends });
  });
  await page.goto('/appointments/chloe-today');
  await expect(page.getByRole('heading', { name: 'Chloe Bennett' })).toBeVisible();
  asked = answerNext(page, false);
  await page.getByRole('button', { name: 'No-show' }).click();
  await expect.poll(() => asked.text).toBe('Mark Chloe as a no-show? It can’t be undone, and they aren’t emailed. '
    + 'Chloe has no email address on their record, so if they book online they’ll be asked for the £10 deposit like a new client.');
});

test('a booking that’s over doesn’t chase a deposit, send the change link or re-send the confirmation', async ({ page }) => {
  await signIn(page);
  // Jess's online booking from five days ago, still waiting for its deposit.
  await card(page).getByRole('link', { name: /Jess Collins/ }).click();
  await expect(page.getByRole('heading', { name: 'Jess Collins' })).toBeVisible();
  await expect(heroChip(page)).toHaveText('Not finished');
  await expect(page.getByText(/Waiting for the £10 deposit/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Deposit received' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Ask for the deposit/ })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Change or cancel link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Re-send confirmation email' })).toHaveCount(0);
  // WhatsApp just opens a chat with her, with nothing about the booking written in.
  const wa = page.locator('.od-contact').getByRole('link', { name: 'WhatsApp' });
  expect(decodeURIComponent((await wa.getAttribute('href'))!.split('text=')[1])).toBe('Hi Jess, ');
  // What she can do with it is all still there.
  await expect(page.getByRole('button', { name: 'Finish & take payment' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'No-show' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await shot(page, 'n05-over-no-deposit-chase');
  // Nothing was emailed.
  const jess = (await demo(page)).appointments.find((a) => a.booking_name === 'Jess Collins')!;
  expect((await demo(page)).outbox.filter((o) => o.appointment_id === jess.id)).toEqual([]);

  // Sophie's, tomorrow, still waits for its deposit as before.
  await page.goto('/');
  await page.locator('.card.attention', { hasText: 'Deposits waiting' }).getByRole('link', { name: /Sophie Turner/ }).click();
  await expect(page.getByRole('heading', { name: 'Sophie Turner' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Deposit received' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Change or cancel link' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-send confirmation email' })).toBeVisible();
  const ask = page.locator('.od-contact').getByRole('link', { name: 'WhatsApp' });
  expect(decodeURIComponent((await ask.getAttribute('href'))!.split('text=')[1])).toContain('deposit');
});

test('cancelling one that has already started: no email unless she ticks it, no late tick, and No-show suggested', async ({ page }) => {
  await signIn(page);
  // Grace's from Saturday has been and gone. She has an email address.
  await card(page).getByRole('link', { name: at(-4, '14:00') }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Cancel appointment' });
  await expect(sheet.getByText('If Grace never came, mark a no-show instead: it doesn’t email them.')).toBeVisible();
  await expect(sheet.getByLabel('Email the client to let them know')).not.toBeChecked();
  // Only that tick: nothing about a late cancellation once it has started.
  await expect(sheet.getByRole('checkbox')).toHaveCount(1);
  await expect(sheet).not.toContainText(/late cancellation|notice/);
  await shot(page, 'n04-cancel-after-start');
  await sheet.getByLabel('Reason (optional)').fill('Booked by mistake');
  await sheet.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('Cancelled by you')).toBeVisible();
  const grace = (await demo(page)).appointments.find((a) => a.booking_name === 'Grace Patel' && a.status === 'cancelled')!;
  expect((await demo(page)).outbox.filter((o) => o.appointment_id === grace.id)).toEqual([]);
  await expect(page.locator('.card.attention', { hasText: 'Late cancellation' })).toHaveCount(0);

  // From the sheet, "Mark as a no-show" asks first, and sends nothing either.
  await backToToday(page);
  await card(page).getByRole('link', { name: /Jess Collins/ }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  const asked = answerNext(page, true);
  await sheet.getByRole('button', { name: 'Mark as a no-show' }).click();
  await expect(heroChip(page)).toHaveText('No-show');
  expect(asked.text).toMatch(/^Mark Jess as a no-show\?/);
  await expect(sheet).toHaveCount(0);
  const jess = (await demo(page)).appointments.find((a) => a.booking_name === 'Jess Collins')!;
  expect((await demo(page)).outbox.filter((o) => o.appointment_id === jess.id)).toEqual([]);

  // A booking still to come is as before: the email starts ticked, and there's no No-show hint.
  await page.goto('/');
  await page.getByRole('link', { name: /Ruby Clarke/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Ruby Clarke' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(sheet.getByLabel('Email the client to let them know')).toBeChecked();
  await expect(sheet.getByRole('button', { name: 'Mark as a no-show' })).toHaveCount(0);
});

test('a client’s record shows a past booking never finished as "Not finished" too', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Jess Collins/ }).click();
  const history = page.locator('.section-title:has-text("History") + .card');
  await expect(history.getByRole('link', { name: new RegExp(fmtDay(zonedToInstant(addDays(TODAY, -5), '14:00'))) }).locator('.chip'))
    .toHaveText('Not finished');
});
