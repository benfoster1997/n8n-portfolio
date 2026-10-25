import { expect, test, type Page } from '@playwright/test';

// Each test gets a fresh browser, so the demo starts from its seeded data.
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}

test('a new client books online, fills in the form, and the owner confirms the deposit', async ({ page }) => {
  await page.goto('/book');
  await expect(page.getByRole('heading', { name: 'Demo Nail Studio' })).toBeVisible();
  await shot(page, '01-book-services');
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();

  await expect(page.getByRole('heading', { name: 'Pick a day and time' })).toBeVisible();
  await page.locator('.slot').first().click();
  await shot(page, '02-book-time');
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Full name').fill('Poppy Tester');
  await page.getByLabel('Email').fill('poppy@example.com');
  await page.getByLabel('Mobile').fill('07700 900777');
  await page.getByRole('radio', { name: 'Yes, first time' }).click();

  // Trying to book without answering the health questions is stopped.
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('alert')).toContainText('Please answer');

  for (const group of await page.locator('.card .seg').all()) await group.getByRole('radio', { name: 'No' }).click();
  await page.getByLabel(/I confirm this information is correct/).check();
  await page.getByLabel('Type your full name to sign').fill('Poppy Tester');
  await shot(page, '03-book-details');
  await page.getByRole('button', { name: 'Confirm booking' }).click();

  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();
  const reference = (await page.locator('.mono').first().textContent())!.trim();
  expect(reference).toMatch(/^[A-HJ-NP-Z2-9]{6}$/);
  await shot(page, '04-book-done');

  // The owner sees it waiting for a deposit.
  await signIn(page);
  const card = page.locator('.card.attention', { hasText: 'Deposits waiting' });
  await expect(card).toContainText('Poppy Tester');
  await shot(page, '05-today');
  await card.getByRole('link', { name: /Poppy Tester/ }).click();
  await expect(page.getByText(`Waiting for the £10 deposit`)).toBeVisible();
  await expect(page.getByText('form on file')).toBeVisible();
  await shot(page, '06-appointment-deposit');

  await page.getByRole('button', { name: 'Deposit received' }).click();
  await page.getByRole('button', { name: 'Confirm deposit received' }).click();
  await expect(page.locator('.chip.ok', { hasText: 'Confirmed' })).toBeVisible();
  await expect(page.getByText('Deposit received', { exact: false }).first()).toBeVisible();

  // …and the deposit is in the takings.
  await page.getByRole('link', { name: 'Money' }).click();
  await expect(page.getByText('Poppy Tester')).toBeVisible();
});

test('a returning client is not asked for a deposit', async ({ page }) => {
  await page.goto('/book');
  await page.getByRole('button', { name: /BIAB infill/ }).click();
  await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Full name').fill('Amelia Hart');
  await page.getByLabel('Email').fill('AMELIA@example.com');
  await page.getByLabel('Mobile').fill('07700 900101');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();

  await signIn(page);
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Amelia Hart/ }).click();
  const upcoming = page.locator('.card', { has: page.locator('.chip', { hasText: 'Confirmed' }) }).first();
  await expect(upcoming).toBeVisible();
  await expect(page.locator('.chip.warn', { hasText: 'Deposit due' })).toHaveCount(0);
});

test('WhatsApp reminders open WhatsApp with the message written', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: /WhatsApp reminder/ }).click();
  await expect(page.getByRole('heading', { name: 'WhatsApp reminders' })).toBeVisible();
  const remind = page.getByRole('link', { name: 'Send reminder' }).first();
  const href = await remind.getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/447700900105\?text=/);
  expect(decodeURIComponent(href!.split('text=')[1])).toContain('Just a reminder of your Gel polish — hands appointment');
  const deposit = page.getByRole('link', { name: 'Ask for deposit' }).first();
  expect(decodeURIComponent((await deposit.getAttribute('href'))!)).toContain('Sort code: 00-00-00');
  await shot(page, '07-reminders');
});

test('the owner adds an appointment, finishes it and takes cash', async ({ page }) => {
  await signIn(page);
  await page.goto('/appointments/new');
  await page.getByLabel('Search by name or number').fill('Ruby');
  await page.getByRole('button', { name: /Ruby Clarke/ }).click();
  await page.getByLabel('Treatment').selectOption({ label: 'Removal only · 30 min · £10' });
  // Yesterday at a fixed time, so it can be finished straight away.
  const y = new Date(Date.now() - 86400e3).toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  await page.getByLabel('Date').fill(y);
  await page.getByRole('button', { name: /pick any time/ }).click();
  await page.getByLabel('Start time').fill('07:00');
  await shot(page, '08-new-appointment');
  await page.getByRole('button', { name: 'Add to diary' }).click();

  await expect(page.getByRole('heading', { name: 'Ruby Clarke' })).toBeVisible();
  await page.getByRole('button', { name: 'Finish & take payment' }).click();
  await expect(page.getByLabel('Amount paid today (£)')).toHaveValue('10.00');
  await page.getByRole('radio', { name: 'Cash' }).click();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  await expect(page.locator('.chip', { hasText: 'Done' })).toBeVisible();
});

test('the diary refuses a double booking', async ({ page }) => {
  await signIn(page);
  await page.goto('/appointments/new');
  await page.getByLabel('Search by name or number').fill('Chloe');
  await page.getByRole('button', { name: /Chloe Bennett/ }).click();
  // Isla is booked today at 10:00 for an hour in the demo.
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/London' });
  await page.getByLabel('Date').fill(today);
  await page.getByRole('button', { name: /pick any time/ }).click();
  await page.getByLabel('Start time').fill('10:30');
  await page.getByRole('button', { name: 'Add to diary' }).click();
  await expect(page.getByRole('alert')).toContainText('clashes with another appointment');
});

test('client record: allergy flag, patch test and consultation form', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Grace Patel/ }).click();
  await expect(page.getByText('Sensitive to HEMA')).toBeVisible();
  await page.getByRole('button', { name: 'Add test' }).click();
  await page.getByLabel('Product(s)').fill('Gel polish');
  await page.getByRole('button', { name: 'Save patch test' }).click();
  await expect(page.getByText('Gel polish').first()).toBeVisible();
  await shot(page, '09-client');

  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Sophie Turner/ }).click();
  await page.getByRole('button', { name: /Form ·/ }).click();
  await expect(page.getByText('Nails are quite thin at the moment.')).toBeVisible();
});

test('takings: totals, tax year and a spreadsheet download', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Money' }).click();
  await page.getByRole('radio', { name: 'Tax year' }).click();
  await expect(page.getByText(/Tax year 20\d\d–\d\d/)).toBeVisible();
  await expect(page.locator('.stat .value').first()).not.toHaveText('£0');
  await shot(page, '10-money');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download spreadsheet (CSV)' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^takings-tax-year-\d{4}-\d{2}\.csv$/);
});

test('settings changes show on the booking page; pausing booking closes it', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await shot(page, '11-settings');
  await page.getByRole('link', { name: /Business details/ }).click();
  await page.getByLabel('Business name').fill('Nails by Test');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.goto('/book');
  await expect(page.getByRole('heading', { name: 'Nails by Test' })).toBeVisible();

  await page.goto('/settings/business');
  await page.getByLabel(/Online booking is open/).uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.goto('/book');
  await expect(page.getByText('Online booking is paused')).toBeVisible();
});

test('the diary shows the week, time off and lets the owner block time', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Diary' }).click();
  await expect(page.locator('.date-pill')).toHaveCount(7);
  await shot(page, '12-diary');
  await page.getByRole('button', { name: 'Block time' }).click();
  await page.getByLabel('Note (only you see this)').fill('Dentist');
  await page.getByRole('button', { name: 'Block this time' }).click();
  await expect(page.getByText('Dentist')).toBeVisible();
});

test('the app works offline-ready: manifest, icons and home-screen tags are served', async ({ page, request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect((await request.get('/icons/apple-touch-icon.png')).ok()).toBe(true);
  expect((await request.get('/sw.js')).ok()).toBe(true);
  await page.goto('/book');
  expect(await page.locator('meta[name="apple-mobile-web-app-capable"]').getAttribute('content')).toBe('yes');
});
