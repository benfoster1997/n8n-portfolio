import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { zonedToInstant } from '../../src/lib/time';

// The app left open on her phone keeps itself up to date: Today, the Diary, the reminders list and
// an open appointment reload when she comes back to it (the day has changed, or a few minutes
// have passed), about a second after, trying once more if that fails. With no signal, everyone
// is told so in plain words, and a client whose signal drops at Confirm booking is told to check
// their email first. The clock is fixed before the demo is seeded: Wednesday 4 November 2026,
// with Isla Morgan at 10:00 and Grace Patel at 13:00 that day, and Chloe Bennett at 11:00 the next.
const NOW = new Date('2026-11-04T09:00:00Z');
const TODAY = '2026-11-04';
const KEY = 'salon-demo-v4';
const NO_SIGNAL = 'No signal: check your connection and try again.';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoAppt {
  id: string; client_id: string; booking_name: string | null; status: string; starts_at: string; ends_at: string; busy_until: string;
  reference: string; public_token: string; cancelled_at: string | null; cancelled_by: string | null; cancel_reason: string | null;
  cancelled_late: boolean; whatsapp_reminder_sent_at: string | null;
}
interface DemoStore {
  appointments: DemoAppt[];
  clients: { id: string; full_name: string }[];
  outbox: { appointment_id: string; kind: string; to_email: string }[];
}
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/**
 * Meanwhile, somewhere else (a client online, or the app on another device): the demo's saved data
 * changes, and the app hears about it as it would from another tab. Nothing on screen changes until it reloads.
 */
async function meanwhile(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => {
    localStorage.setItem(key, json);
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, [KEY, JSON.stringify(db)]);
}
const iso = (day: string, hhmm: string) => zonedToInstant(day, hhmm).toISOString();
/** A copy of one of the client's bookings, at another time. */
function addBooking(db: DemoStore, name: string, day: string, hhmm: string, minutes = 45) {
  const client = db.clients.find((c) => c.full_name === name)!;
  const like = db.appointments.find((a) => a.client_id === client.id)!;
  const start = new Date(iso(day, hhmm));
  db.appointments.push({
    ...like, id: `meanwhile-${db.appointments.length}`, status: 'confirmed', starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + minutes * 60e3).toISOString(), busy_until: new Date(start.getTime() + (minutes + 10) * 60e3).toISOString(),
    reference: 'MEANWH', public_token: `00000000-0000-4000-8000-${String(db.appointments.length).padStart(12, '0')}`,
    cancelled_at: null, cancelled_by: null, cancel_reason: null, whatsapp_reminder_sent_at: null,
  });
}
const booking = (db: DemoStore, name: string, day: string, hhmm: string) => {
  const client = db.clients.find((c) => c.full_name === name)!;
  return db.appointments.find((a) => a.client_id === client.id && a.starts_at === iso(day, hhmm))!;
};

/** Lets a test send the app to the background and bring it back, as going to WhatsApp and back does. */
async function phone(page: Page) {
  await page.addInitScript(() => {
    let state: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => state === 'hidden' });
    const w = window as unknown as { __away: () => void; __back: () => void };
    w.__away = () => { state = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); };
    w.__back = () => { state = 'visible'; document.dispatchEvent(new Event('visibilitychange')); };
  });
}
const away = (page: Page) => page.evaluate(() => (window as unknown as { __away: () => void }).__away());
const back = (page: Page) => page.evaluate(() => (window as unknown as { __back: () => void }).__back());
/** Away from the app for a while (the clock keeps running), then back. */
async function awayFor(page: Page, time: string) {
  await away(page);
  await page.clock.fastForward(time);
  await back(page);
}

const updated = (page: Page) => page.locator('.td-updated');
async function signIn(page: Page, now = NOW) {
  await page.clock.install({ time: now });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  // Loaded: it says when.
  await expect(updated(page)).toHaveText(/^Updated /);
}
const todays = (page: Page) => page.locator('.td-timeline').first();

test('Today left open overnight is up to date when she comes back to it in the morning', async ({ page }) => {
  await phone(page);
  await signIn(page, new Date('2026-11-04T21:58:00Z')); // Wednesday, 21:58
  await expect(page.getByText('Good evening')).toBeVisible();
  await expect(page.getByText('Wednesday 4 November')).toBeVisible();
  await expect(updated(page)).toHaveText(/^Updated 21:58/);
  await expect(todays(page)).toContainText('Isla Morgan');

  await awayFor(page, '10:33:00'); // 08:31 on Thursday
  await expect(updated(page)).toHaveText(/^Updated 08:31/);
  await expect(page.getByText('Good morning')).toBeVisible();
  await expect(page.getByText('Thursday 5 November')).toBeVisible();
  await expect(todays(page)).toContainText('Chloe Bennett');
  await expect(todays(page)).not.toContainText('Isla Morgan');
  await shot(page, 'u01-today-next-morning');
});

test('“Updated 09:00” on Today: tap it to load everything again now', async ({ page }) => {
  await signIn(page);
  await expect(updated(page)).toHaveText(/^Updated 09:00/);
  await meanwhile(page, (db) => addBooking(db, 'Ruby Clarke', TODAY, '15:30'));
  await page.clock.fastForward('02:00');
  await expect(todays(page)).not.toContainText('Ruby Clarke');
  await updated(page).click();
  await expect(todays(page)).toContainText('Ruby Clarke');
  await expect(updated(page)).toHaveText(/^Updated 09:02/);
});

test('the Diary, the reminders list and an open appointment reload when she comes back after a few minutes', async ({ page }) => {
  await phone(page);
  await signIn(page);

  // The Diary: not after two minutes away, but after six.
  await page.getByRole('link', { name: 'Diary', exact: true }).click();
  const day = page.locator('.dy-day');
  await expect(day).toContainText('Isla Morgan');
  await meanwhile(page, (db) => addBooking(db, 'Ruby Clarke', TODAY, '15:30'));
  await awayFor(page, '02:00');
  await page.waitForTimeout(1_500); // past the second it waits
  await expect(day).not.toContainText('Ruby Clarke');
  await awayFor(page, '04:00');
  await expect(day).toContainText('Ruby Clarke');

  // An open appointment: Isla cancels online while it's open.
  const isla = booking(await demo(page), 'Isla Morgan', TODAY, '10:00');
  await page.goto(`/appointments/${isla.id}`);
  await expect(page.locator('.od-hero .chip')).toHaveText('Confirmed');
  await meanwhile(page, (db) => {
    const a = booking(db, 'Isla Morgan', TODAY, '10:00');
    Object.assign(a, { status: 'cancelled', cancelled_by: 'client', cancelled_at: new Date().toISOString(), cancel_reason: 'Poorly, sorry' });
  });
  await awayFor(page, '06:00');
  await expect(page.getByText('Cancelled by the client online')).toBeVisible();

  // The reminders list: a reminder sent from another device shows as sent.
  await page.goto('/reminders');
  const chloe = page.locator('.rm-item', { hasText: 'Chloe Bennett' });
  await expect(chloe.getByRole('link', { name: 'Send reminder' })).toBeVisible();
  await meanwhile(page, (db) => { booking(db, 'Chloe Bennett', '2026-11-05', '11:00').whatsapp_reminder_sent_at = new Date().toISOString(); });
  await awayFor(page, '06:00');
  await expect(chloe).toContainText('WhatsApp opened');
});

/** WhatsApp opens in a new tab: stand in for it, so nothing leaves the machine. */
const whatsApp = (page: Page) => page.context().route('https://wa.me/**', (r) => r.fulfill({ body: 'WhatsApp' }));
const reminderRow = (page: Page, name: string) => page.locator('.rm-item', { hasText: name });

test('a reminder sent while the list is reloading stays marked as sent when the reload’s answer comes in', async ({ page }) => {
  await whatsApp(page);
  await phone(page);
  await signIn(page);
  await page.goto('/reminders');
  const chloe = reminderRow(page, 'Chloe Bennett');
  await expect(chloe).toContainText('Ready to send');
  // Back after six minutes: a second later the list sets off to reload. The clock is stopped, so its answer waits.
  await away(page);
  await page.clock.pauseAt(new Date(NOW.getTime() + 6 * 60e3));
  await back(page);
  await page.clock.runFor(1_000);
  await page.waitForTimeout(300); // the reload is on its way
  // Before it comes back, she taps Send reminder: WhatsApp opens.
  const popup = page.waitForEvent('popup');
  await chloe.getByRole('link', { name: 'Send reminder' }).click();
  await (await popup).close();
  await expect(chloe).toContainText('WhatsApp opened');
  // The reload's answer (from before her tap) comes in, then the save's.
  await page.clock.runFor(1_000);
  await page.waitForTimeout(300);
  await expect(chloe).toContainText('WhatsApp opened');
  await expect(chloe).not.toContainText('Ready to send');
  expect(booking(await demo(page), 'Chloe Bennett', '2026-11-05', '11:00').whatsapp_reminder_sent_at).not.toBeNull();

  // That reload didn't count, so coming back again a minute later reloads it: up to date, and still marked.
  await meanwhile(page, (db) => addBooking(db, 'Ruby Clarke', '2026-11-05', '15:30'));
  await page.clock.resume();
  await awayFor(page, '01:00');
  await expect(reminderRow(page, 'Ruby Clarke').filter({ hasText: '15:30' })).toBeVisible();
  await expect(chloe).toContainText('WhatsApp opened');
});

test('a reminder sent before the list reloads stays marked, and the reload still brings what’s new', async ({ page }) => {
  await whatsApp(page);
  await phone(page);
  await signIn(page);
  await page.goto('/reminders');
  const chloe = reminderRow(page, 'Chloe Bennett');
  await expect(chloe).toContainText('Ready to send');
  await meanwhile(page, (db) => addBooking(db, 'Ruby Clarke', '2026-11-05', '15:30'));
  // Six minutes on she taps Send reminder, sends it in WhatsApp and comes back: the list is reloaded.
  await page.clock.fastForward('06:00');
  const popup = page.waitForEvent('popup');
  await chloe.getByRole('link', { name: 'Send reminder' }).click();
  await away(page);
  await (await popup).close();
  await back(page);
  await expect(reminderRow(page, 'Ruby Clarke').filter({ hasText: '15:30' })).toBeVisible();
  await expect(chloe).toContainText('WhatsApp opened');
  await expect(chloe).not.toContainText('Ready to send');
});

test('an open appointment that can’t be brought up to date says so, and keeps what it had', async ({ page, context }) => {
  await phone(page);
  await signIn(page);
  const isla = booking(await demo(page), 'Isla Morgan', TODAY, '10:00');
  await page.goto(`/appointments/${isla.id}`);
  await expect(page.locator('.od-hero .chip')).toHaveText('Confirmed');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await signal(page, context, false);
  await awayFor(page, '06:00');
  // Both tries fail: it says so at the top.
  await expect(page.getByRole('alert')).toHaveText(NO_SIGNAL);
  await expect(page.locator('.od-hero .chip')).toHaveText('Confirmed');
  await shot(page, 'u05-appointment-no-signal');
  // Signal back: next time she comes back it's up to date, and the line has gone.
  await signal(page, context, true);
  await awayFor(page, '00:10');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a late cancellation’s Record payment received doesn’t vanish while the appointment reloads', async ({ page }) => {
  await phone(page);
  await signIn(page);
  // Isla cancelled tomorrow's gel toes late: the full price is owed.
  const late = (await demo(page)).appointments.find((a) => a.status === 'cancelled' && a.cancelled_late)!;
  await page.goto(`/appointments/${late.id}`);
  const record = page.getByRole('button', { name: 'Record payment received' });
  await expect(record).toBeVisible();
  // Back after six minutes: the appointment reloads. The clock is stopped, so its answers wait.
  await away(page);
  await page.clock.pauseAt(new Date(NOW.getTime() + 6 * 60e3));
  await back(page);
  await page.clock.runFor(1_000);
  await page.waitForTimeout(300);
  await expect(record).toBeVisible();
  await expect(page.getByRole('link', { name: 'WhatsApp Isla' })).toBeVisible();
  await page.clock.runFor(1_000);
  await expect(record).toBeVisible();
});

test('never reloads under an open sheet or unsaved notes: it waits until they’re done', async ({ page }) => {
  await phone(page);
  await signIn(page);
  await page.getByRole('link', { name: 'Diary', exact: true }).click();
  await page.getByRole('button', { name: 'Block time' }).click();
  const sheet = page.getByRole('dialog', { name: 'Block time' });
  await sheet.getByLabel('Note (only you see this)').fill('Dentist');
  await meanwhile(page, (db) => addBooking(db, 'Ruby Clarke', TODAY, '15:30'));
  await awayFor(page, '06:00');
  await page.waitForTimeout(1_500);
  await expect(sheet.getByLabel('Note (only you see this)')).toHaveValue('Dentist');
  await expect(page.locator('.dy-day')).not.toContainText('Ruby Clarke');
  // Closed: the reload it held back happens now.
  await sheet.getByRole('button', { name: 'Close' }).click();
  await expect(page.locator('.dy-day')).toContainText('Ruby Clarke');

  // Notes typed but not saved on an open appointment.
  const isla = booking(await demo(page), 'Isla Morgan', TODAY, '10:00');
  await page.goto(`/appointments/${isla.id}`);
  const notes = page.getByPlaceholder('Colour, shape, anything to remember…');
  await notes.fill('Almond shape, nude pink');
  await meanwhile(page, (db) => {
    Object.assign(booking(db, 'Isla Morgan', TODAY, '10:00'), { status: 'cancelled', cancelled_by: 'client', cancelled_at: new Date().toISOString() });
  });
  await awayFor(page, '06:00');
  await page.waitForTimeout(1_500);
  await expect(notes).toHaveValue('Almond shape, nude pink');
  await expect(page.locator('.od-hero .chip')).toHaveText('Confirmed');
  await page.getByRole('button', { name: 'Save notes' }).click();
  await expect(page.getByText('Cancelled by the client online')).toBeVisible();
  await expect(notes).toHaveValue('Almond shape, nude pink');
});

/** The phone loses (or finds) its signal, and the page knows before the test goes on. */
async function signal(page: Page, context: BrowserContext, on: boolean) {
  await context.setOffline(!on);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(on);
}

/** Back with the clock stopped, so each try can be stepped through: the first a second after she's back. */
async function backWithNoSignal(page: Page, context: BrowserContext) {
  await away(page);
  await page.clock.pauseAt(new Date(NOW.getTime() + 6 * 60e3)); // 09:06
  await signal(page, context, false);
  await back(page);
  await page.clock.runFor(1_000);
  await expect(updated(page)).toHaveText(/^Updating/);
}

test('coming back with no signal: it tries once more, then says so in plain words and keeps what it had', async ({ page, context }) => {
  await phone(page);
  await signIn(page);
  await backWithNoSignal(page, context);
  await expect(page.getByRole('alert')).toHaveCount(0); // not after the first try: it tries again
  await page.clock.runFor(1_500);
  await expect(page.getByRole('alert')).toHaveText(NO_SIGNAL);
  await expect(updated(page)).toHaveText(/^Updated 09:00/);
  await expect(todays(page)).toContainText('Isla Morgan');
  await shot(page, 'u02-today-no-signal');
  // The signal's back: tap to load again.
  await signal(page, context, true);
  await page.clock.resume();
  await updated(page).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(updated(page)).toHaveText(/^Updated 09:06/);
});

test('coming back as the signal returns: the second try works, and nothing is said', async ({ page, context }) => {
  await phone(page);
  await signIn(page);
  await backWithNoSignal(page, context);
  await signal(page, context, true);
  await page.clock.runFor(1_500);
  await page.clock.resume();
  await expect(updated(page)).toHaveText(/^Updated 09:06/);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('signing in with no signal says so in plain words', async ({ page, context }) => {
  await page.goto('/');
  await signal(page, context, false);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText(NO_SIGNAL);
});

test('Today or the Diary opened with no signal: Try again, never a free day made up from nothing', async ({ page, context }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Clients', exact: true }).click();
  await expect(page.getByRole('link', { name: /Isla Morgan/ })).toBeVisible();
  await signal(page, context, false);

  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(NO_SIGNAL);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  for (const madeUp of ['Free day', 'Nothing booked today.', 'Nothing booked tomorrow.', 'Booked today']) {
    await expect(page.getByText(madeUp)).toHaveCount(0);
  }
  await expect(page.locator('.td-tiles')).toHaveCount(0);
  await shot(page, 'u06-today-opened-no-signal');

  await page.getByRole('link', { name: 'Diary', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(NO_SIGNAL);
  await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
  await expect(page.getByText('Nothing booked.')).toHaveCount(0);
  await expect(page.locator('.dy-hours')).toHaveCount(0); // not "Closed" for want of her opening hours

  // Signal back: Try again loads it.
  await signal(page, context, true);
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.dy-day')).toContainText('Isla Morgan');
  await expect(page.locator('.dy-hours')).toHaveText('Open 09:30–17:30');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(updated(page)).toHaveText(/^Updated /);
  await expect(todays(page)).toContainText('Isla Morgan');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('opening the app with no signal: it’ll open once there’s signal, and never says to sign out', async ({ page }) => {
  await signIn(page);
  // The phone has no signal as the app opens again (the page itself is on the phone).
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'onLine', { configurable: true, get: () => false }));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Can’t open the diary' })).toBeVisible();
  await expect(page.getByText(NO_SIGNAL)).toBeVisible();
  await expect(page.getByText('It will open again once you have signal.')).toBeVisible();
  await expect(page.getByText(/sign out and sign in again/)).toHaveCount(0);
});

/** Book a Gel polish on the first free time (Thursday 5 November, 09:30) as a returning client, up to Confirm booking. */
async function upToConfirm(page: Page) {
  await page.clock.install({ time: NOW });
  await page.goto('/book');
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await expect(page.locator('.slot-day')).toHaveText('Thursday 5 November');
  await expect(page.locator('.slot').first()).toHaveText('09:30');
  await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Full name').fill('Poppy Tester');
  await page.getByLabel('Email').fill('poppy@example.com');
  await page.getByLabel('Mobile').fill('07700 900777');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await page.getByLabel(/16 or over/).check();
  await page.getByLabel(/agree to the cancellation policy/).check();
}
const poppys = async (page: Page) => (await demo(page)).appointments.filter((a) => a.booking_name === 'Poppy Tester');

test('the signal drops as a client confirms: check your email first; trying again finds the time is theirs', async ({ page, context }) => {
  await upToConfirm(page);
  // The booking reaches the server, then the signal goes before the answer gets back.
  await page.clock.pauseAt(new Date(NOW.getTime() + 60e3));
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await signal(page, context, false);
  await page.clock.runFor(100);
  await expect(page.getByRole('alert')).toHaveText('No signal: we couldn’t tell whether your booking went through. '
    + 'Check your email for a confirmation (it can take up to 10 minutes) before you try again.');
  await shot(page, 'u03-book-no-signal');
  // It was made, and its confirmation email is on its way.
  const made = await poppys(page);
  expect(made.map((a) => a.starts_at)).toEqual([iso('2026-11-05', '09:30')]);
  expect((await demo(page)).outbox.some((o) => o.appointment_id === made[0].id && o.kind === 'booking_received')).toBe(true);

  // Trying the same time again anyway: it's theirs now, so they're told to check their email, and no second booking is made.
  await signal(page, context, true);
  await page.clock.resume();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await expect(page.locator('.pub-time-gone')).toHaveText('That time is booked now. If it was you, a moment ago, check your email '
    + 'for your confirmation. Otherwise, please pick another time.');
  expect(await poppys(page)).toHaveLength(1);
});

test('the time has just been taken: back to the free times with their details kept; the confirmation can take 10 minutes', async ({ page }) => {
  await upToConfirm(page);
  // Someone else books 09:30 on another phone.
  await meanwhile(page, (db) => addBooking(db, 'Amelia Hart', '2026-11-05', '09:30', 60));
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await expect(page.locator('.pub-time-gone')).toHaveText('Sorry, that time has just been taken. Please pick another.');
  await shot(page, 'u04-book-time-taken');
  // 09:30 isn't offered any more; another time, and their details are still there.
  await expect(page.locator('.slot-day')).toHaveText('Thursday 5 November');
  await expect(page.locator('.slot', { hasText: '09:30' })).toHaveCount(0);
  await page.locator('.slot').first().click();
  await expect(page.locator('.pub-time-gone')).toHaveCount(0);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByLabel('Full name')).toHaveValue('Poppy Tester');
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();
  await expect(page.getByText('A confirmation is on its way to poppy@example.com. It can take up to 10 minutes: '
    + 'if it isn’t there by then, check your junk folder.')).toBeVisible();
});
