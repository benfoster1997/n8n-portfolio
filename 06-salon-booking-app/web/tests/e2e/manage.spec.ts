import { expect, test, type Page } from '@playwright/test';

// A client changing or cancelling their own booking from the link in their
// emails (/manage/<token>). Each test gets a fresh browser, so the demo starts
// from its seeded data: Chloe tomorrow at 11:00 (inside the 48-hour notice),
// Sophie tomorrow waiting for a deposit, Ruby in 3 days and Amelia in 8.
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300); // let a sheet finish sliding up
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoAppt {
  id: string; booking_name: string; status: string; starts_at: string; public_token: string; reference: string;
  service_name: string; price_pence: number; client_change_count: number; cancelled_by: string | null;
  cancelled_late: boolean; cancel_reason: string | null;
}
interface DemoStore {
  appointments: DemoAppt[];
  client_changes: { appointment_id: string; action: string; late: boolean; note: string | null }[];
  outbox: { appointment_id: string; kind: string }[];
  forms: unknown[];
  settings: { client_self_service: boolean };
}

/** The owner's demo data, straight from this browser's storage. */
async function demo(page: Page): Promise<DemoStore> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
}

/** Change the demo data; pages read it when they load, so reload or navigate afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}

async function booking(page: Page, name: string, status = 'confirmed'): Promise<DemoAppt> {
  if (!page.url().startsWith('http')) await page.goto('/privacy'); // any page seeds the demo
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  const a = (await demo(page)).appointments.find((x) => x.booking_name === name && x.status === status);
  expect(a, `${name}'s ${status} booking in the demo`).toBeTruthy();
  return a!;
}

async function openManage(page: Page, name: string, status = 'confirmed'): Promise<DemoAppt> {
  const a = await booking(page, name, status);
  await page.goto(`/manage/${a.public_token}`);
  await expect(page.getByText(`Hi ${name.split(' ')[0]}, here’s your booking`)).toBeVisible();
  return a;
}

const londonTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit' });

test('a client moves their booking to another time', async ({ page }) => {
  const ruby = await openManage(page, 'Ruby Clarke');
  await expect(page.getByRole('heading', { name: 'Demo Nail Studio' })).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'Confirmed' })).toBeVisible();
  await expect(page.getByRole('note', { name: 'Cancellation policy' })).toContainText('You can change or cancel free of charge until');
  await shot(page, 'm01-manage');

  await page.getByRole('button', { name: 'Change time or treatment' }).click();
  const current = page.getByRole('button', { name: /Your current treatment/ });
  await expect(current).toContainText('Gel polish — hands');
  await shot(page, 'm02-treatment');
  await current.click();

  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await page.getByRole('option').last().click(); // a day well away from the current one
  await page.locator('.slot').first().click();
  const time = (await page.locator('.slot.on').textContent())!.trim();
  const day = (await page.locator('.date-strip + .sub').textContent())!.trim();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByRole('heading', { name: 'Check your new booking' })).toBeVisible();
  await expect(page.locator('.compare .was')).toContainText(londonTime(ruby.starts_at));
  await expect(page.locator('.compare .to')).toContainText(`${day} at ${time}`);
  await expect(page.getByText(/moving it falls under the cancellation policy/)).toHaveCount(0);
  await shot(page, 'm03-confirm');
  await page.getByRole('button', { name: 'Confirm change' }).click();

  await expect(page.getByRole('heading', { name: 'Your booking has been changed' })).toBeVisible();
  await expect(page.getByText('We’ve emailed you the new details.')).toBeVisible();
  await expect(page.locator('.card', { hasText: 'Reference' })).toContainText(`${day} at ${time}`);
  await shot(page, 'm04-changed');

  // The owner's diary has the new time, a record of the change, and emails queued for both of them.
  const db = await demo(page);
  const after = db.appointments.find((x) => x.id === ruby.id)!;
  expect(londonTime(after.starts_at)).toBe(time);
  expect(after.starts_at).not.toBe(ruby.starts_at);
  expect(after.client_change_count).toBe(1);
  expect(db.client_changes.filter((c) => c.appointment_id === ruby.id)).toEqual([
    expect.objectContaining({ action: 'moved', late: false }),
  ]);
  expect(db.outbox.filter((o) => o.appointment_id === ruby.id).map((o) => o.kind).sort()).toEqual(['changed', 'owner_changed']);

  await page.getByRole('button', { name: 'Back to my booking' }).click();
  await expect(page.locator('.kv')).toContainText(`${day} at ${time}`);
});

test('a client switches treatment and the price updates', async ({ page }) => {
  const ruby = await openManage(page, 'Ruby Clarke');
  await expect(page.locator('.kv')).toContainText('£25');
  await page.getByRole('button', { name: 'Change time or treatment' }).click();
  await page.getByRole('button', { name: /BIAB new set/ }).click();

  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await expect(page.locator('.slot').first()).toBeVisible();
  // The current time stays picked if it's still free for the longer treatment.
  if ((await page.locator('.slot.on').count()) === 0) await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.locator('.compare .was')).toContainText('Gel polish — hands');
  await expect(page.locator('.compare .was')).toContainText('£25');
  await expect(page.locator('.compare .to')).toContainText('BIAB new set');
  await expect(page.locator('.compare .to')).toContainText('£35');
  await page.getByRole('button', { name: 'Confirm change' }).click();

  await expect(page.getByRole('heading', { name: 'Your booking has been changed' })).toBeVisible();
  await expect(page.getByText('BIAB new set · £35')).toBeVisible();
  await page.getByRole('button', { name: 'Back to my booking' }).click();
  await expect(page.getByRole('heading', { name: 'BIAB new set' })).toBeVisible();
  await expect(page.locator('.kv')).toContainText('£35');
  await expect(page.locator('.kv')).toContainText('1 hr 15 min');

  const after = (await demo(page)).appointments.find((x) => x.id === ruby.id)!;
  expect(after).toMatchObject({ service_name: 'BIAB new set', price_pence: 3500, client_change_count: 1 });
});

test('cancelling well ahead: no late warning, and the booking is cancelled', async ({ page }) => {
  const amelia = await openManage(page, 'Amelia Hart');
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  const sheet = page.getByRole('dialog', { name: 'Cancel your appointment?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('note')).toHaveCount(0);
  await expect(sheet).not.toContainText('full price');
  await sheet.getByLabel('Reason (optional)').fill('Going on holiday');
  await shot(page, 'm05-cancel-sheet');
  await sheet.getByRole('button', { name: 'Yes, cancel my appointment' }).click();

  await expect(sheet).toHaveCount(0);
  await expect(page.getByText('This appointment has been cancelled.')).toBeVisible();
  await expect(page.locator('.chip', { hasText: 'Cancelled' })).toBeVisible();
  await expect(page.getByText(/full price/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change time or treatment' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Book another appointment' })).toHaveAttribute('href', '/book');

  const db = await demo(page);
  expect(db.appointments.find((x) => x.id === amelia.id)).toMatchObject({
    status: 'cancelled', cancelled_by: 'client', cancelled_late: false, cancel_reason: 'Going on holiday',
  });
  expect(db.outbox.some((o) => o.appointment_id === amelia.id && o.kind === 'owner_cancelled')).toBe(true);
});

test('cancelling inside 48 hours: warned first, and the cancelled page restates the policy', async ({ page }) => {
  const chloe = await openManage(page, 'Chloe Bennett');
  const policy = page.getByRole('note', { name: 'Cancellation policy' });
  await expect(policy).toContainText('It’s now less than 48 hours before your appointment');
  await expect(policy).toContainText('the full price (£25) is payable if you cancel');
  await shot(page, 'm06-late');

  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  const sheet = page.getByRole('dialog', { name: 'Cancel your appointment?' });
  await expect(sheet.getByRole('note')).toContainText('the full price (£25) is payable if you cancel');
  await shot(page, 'm07-late-cancel-sheet');
  await sheet.getByRole('button', { name: 'Yes, cancel my appointment' }).click();

  await expect(page.getByText('This appointment has been cancelled.')).toBeVisible();
  await expect(page.getByText(/under the cancellation policy the full price \(£25\) may be payable/)).toBeVisible();
  await expect(page.getByText(/Demo Nail Studio will be in touch/)).toBeVisible();
  await shot(page, 'm08-late-cancelled');
  expect((await demo(page)).appointments.find((x) => x.id === chloe.id)).toMatchObject({ status: 'cancelled', cancelled_late: true });

  // It's the stored booking that says so, not just this screen.
  await page.reload();
  await expect(page.getByText(/may be payable/)).toBeVisible();
});

test('a booking the client already cancelled late shows as cancelled', async ({ page }) => {
  const isla = await booking(page, 'Isla Morgan', 'cancelled');
  await page.goto(`/manage/${isla.public_token}`);
  await expect(page.getByText('This appointment has been cancelled.')).toBeVisible();
  await expect(page.getByText(/may be payable/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);
});

test('moving a booking inside 48 hours shows the policy before confirming', async ({ page }) => {
  const chloe = await openManage(page, 'Chloe Bennett');
  await page.getByRole('button', { name: 'Change time or treatment' }).click();
  await page.getByRole('button', { name: /Your current treatment/ }).click();
  await page.getByRole('option').last().click();
  await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const warning = page.getByRole('note', { name: 'Moving inside the notice period' });
  await expect(warning).toContainText('As this is less than 48 hours before your appointment, moving it falls under the cancellation policy');
  await expect(warning).toContainText('the full price of your treatment is payable');
  await shot(page, 'm09-late-move');
  await page.getByRole('button', { name: 'Confirm change' }).click();
  await expect(page.getByRole('heading', { name: 'Your booking has been changed' })).toBeVisible();

  const changes = (await demo(page)).client_changes.filter((c) => c.appointment_id === chloe.id);
  expect(changes).toEqual([expect.objectContaining({ action: 'moved', late: true })]);
});

test('a booking waiting for a deposit shows the bank details and reference', async ({ page }) => {
  const sophie = await openManage(page, 'Sophie Turner', 'pending_deposit');
  await expect(page.locator('.chip', { hasText: 'Waiting for your deposit' })).toBeVisible();
  const deposit = page.locator('.card', { has: page.getByRole('heading', { name: 'Your deposit' }) });
  await expect(deposit).toContainText('£10 deposit by bank transfer by');
  await expect(deposit).toContainText('Demo Studio');
  await expect(deposit).toContainText('00-00-00');
  await expect(deposit).toContainText('12345678');
  await expect(deposit).toContainText(`use reference ${sophie.reference}`);
  // She filled in the health form when she booked, so it isn't asked for again.
  await expect(page.getByRole('link', { name: 'Fill in the health form' })).toHaveCount(0);
  await shot(page, 'm10-deposit');

  // Without a form on file, the page links to it, and the form links back.
  await editDemo(page, (db) => { db.forms = []; });
  await page.reload();
  await page.getByRole('link', { name: 'Fill in the health form' }).click();
  await expect(page).toHaveURL(new RegExp(`/form/${sophie.public_token}$`));
  await page.getByRole('link', { name: 'Manage your booking' }).click();
  await expect(page.getByText('Hi Sophie, here’s your booking')).toBeVisible();
});

test('an unknown or mistyped link says so kindly', async ({ page }) => {
  await page.goto('/manage/not-a-real-link');
  await expect(page.getByText('This link has expired or isn’t valid.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Book an appointment' })).toHaveAttribute('href', '/book');
  await page.goto('/manage/00000000-0000-4000-8000-000000000000');
  await expect(page.getByText('This link has expired or isn’t valid.')).toBeVisible();
});

test('“Keep my appointment” closes the cancel sheet and changes nothing', async ({ page }) => {
  const ruby = await openManage(page, 'Ruby Clarke');
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  const sheet = page.getByRole('dialog', { name: 'Cancel your appointment?' });
  await sheet.getByLabel('Reason (optional)').fill('Not sure yet');
  await sheet.getByRole('button', { name: 'Keep my appointment' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.locator('.chip', { hasText: 'Confirmed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toBeVisible();

  const db = await demo(page);
  expect(db.appointments.find((x) => x.id === ruby.id)).toMatchObject({ status: 'confirmed', cancel_reason: null });
  expect(db.client_changes.filter((c) => c.appointment_id === ruby.id)).toHaveLength(0);
});

test('no online changes left: cancelling is still offered, changing means getting in touch', async ({ page }) => {
  const amelia = await booking(page, 'Amelia Hart');
  await editDemo(page, (db) => { db.appointments.find((a) => a.id === amelia.id)!.client_change_count = 6; });
  await page.goto(`/manage/${amelia.public_token}`);
  await expect(page.getByText(/already been changed online a few times/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change time or treatment' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toBeVisible();
  expect(await page.getByRole('link', { name: 'WhatsApp' }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/447700900000\?text=/);
  await expect(page.getByRole('link', { name: 'Call' })).toHaveAttribute('href', 'tel:+447700900000');
  await expect(page.getByRole('link', { name: 'Email' })).toHaveAttribute('href', /^mailto:owner@example\.com\?/);
  await shot(page, 'm11-get-in-touch');

  // With self-service switched off by the owner, it's get in touch for everything.
  await editDemo(page, (db) => { db.settings.client_self_service = false; });
  await page.reload();
  await expect(page.getByText('To change or cancel this appointment, please get in touch.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Cancel appointment' })).toHaveCount(0);
});

test('client pages use the booking page’s own home-screen app, not the owner’s', async ({ page, request }) => {
  const manifest = await (await request.get('/book.webmanifest')).json();
  expect(manifest).toMatchObject({ start_url: '/book', short_name: 'Book', display: 'standalone' });

  await page.goto('/book');
  await expect(page.getByRole('heading', { name: 'Demo Nail Studio' })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', /book\.webmanifest$/);
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Book');

  // The owner's app keeps its own.
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest');
  await expect(page.locator('meta[name="apple-mobile-web-app-title"]')).toHaveAttribute('content', 'Bookings');
});
