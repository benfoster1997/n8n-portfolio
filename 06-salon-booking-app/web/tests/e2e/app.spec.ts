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
  // Everyone sees the cancellation policy before choosing anything.
  const policy = page.getByRole('note', { name: 'Cancellation policy' });
  await expect(policy).toContainText('at least 48 hours’ notice');
  await expect(policy).toContainText('the full price of your treatment is payable');
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
  await page.getByLabel(/My answers are true/).check();
  await page.getByLabel(/I explicitly consent/).check();
  await page.getByLabel('Type your full name to sign').fill('Poppy Tester');
  await page.getByLabel(/16 or over/).check();
  await shot(page, '03-book-details');
  // Can't book without agreeing to the cancellation policy.
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('alert')).toContainText('agree to the cancellation policy');
  await page.getByLabel(/agree to the cancellation policy/).check();
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
  await expect(page.getByText('Agreed to your cancellation policy when booking')).toBeVisible();
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
  await page.getByLabel(/16 or over/).check();
  await page.getByLabel(/agree to the cancellation policy/).check();
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
  // 72 hours ahead: Chloe and Sophie tomorrow, Ruby in three days.
  await page.getByRole('link', { name: 'Send 3 WhatsApp reminders' }).click();
  await expect(page.getByRole('heading', { name: 'WhatsApp reminders' })).toBeVisible();
  const remind = page.getByRole('link', { name: 'Send reminder' }).first();
  const href = await remind.getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/447700900105\?text=/);
  const text = decodeURIComponent(href!.split('text=')[1]);
  expect(text).toContain('Just a reminder of your Gel polish — hands appointment');
  // Chloe is tomorrow, already inside the 48-hour notice: her link, and that the policy now applies, not a time that has passed.
  expect(text).toMatch(/Need to change or cancel\? http:\/\/localhost:\d+\/manage\/[0-9a-f-]{36} \(it’s now less than 48 hours before, so the cancellation policy applies\)/);
  expect(text).not.toContain('Please do it by');
  // Ruby, in three days, still has time: her link and the time to do it by.
  const ruby = page.locator('li', { hasText: 'Ruby Clarke' }).getByRole('link', { name: 'Send reminder' });
  expect(decodeURIComponent((await ruby.getAttribute('href'))!.split('text=')[1]))
    .toMatch(/Please do it by \w+ \d+ \w+ at \d\d:\d\d: http:\/\/localhost:\d+\/manage\/[0-9a-f-]{36}/);
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

test('tax estimate: the month view links to the tax year, which shows what to put aside', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Money' }).click();
  await page.getByRole('button', { name: 'See roughly how much tax to put aside' }).click();
  await expect(page.getByText(/Tax year 20\d\d–\d\d/)).toBeVisible();
  const card = page.getByRole('region', { name: 'Tax to put aside' });
  await expect(card).toBeVisible();
  await expect(card.getByText(/of each £1/)).toBeVisible();
  await expect(card.getByText(/not tax advice/)).toBeVisible();
  await expect(card.getByText(/England, Wales and Northern Ireland/)).toBeVisible();
  // No bill yet, so just the return's date.
  await expect(card.getByText(/Send your 20\d\d–\d\d tax return online by 31 January 20\d\d\./)).toBeVisible();
  await card.getByText('How it’s paid').click();
  await expect(card.getByText(/When a bill is £1,000 or more, HMRC usually also asks for two payments towards the next tax year/)).toBeVisible();
  // Under this year's Making Tax Digital limit, the timetable is still there to check.
  await card.getByText('Making Tax Digital', { exact: true }).click();
  await expect(card.getByText(/^2025–26 over £30,000: (from|since) 6 April 2027$/)).toBeVisible();
});

/** "£1,234" or "−£1,000" → 1234 or -1000 */
const pounds = (text: string | null) => Number((text ?? '').replace(/[£,\s]/g, '').replace('−', '-'));

test('tax estimate: her own takings and expenses change it, and are kept for that tax year', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Money' }).click();
  await page.getByRole('radio', { name: 'Tax year' }).click();
  const card = page.getByRole('region', { name: 'Tax to put aside' });
  const total = card.locator('.od-taxcard-value');
  const row = (name: string) => card.locator('.od-taxcard-rows > div', { has: page.getByText(name, { exact: true }) }).locator('dd').first();
  // The demo's takings are well under the allowances: nothing to put aside yet, and no
  // more of the trading allowance comes off than the takings.
  await expect(total).toHaveText('£0');
  await expect(card.getByText(/^Takings of £[\d,]+ or less in a tax year are tax-free: that’s the trading allowance\.$/)).toBeVisible();
  expect(-pounds(await row('Trading allowance').textContent())).toBe(pounds(await row('Takings in the app').textContent()));

  // Takings from before the app, and expenses smaller than the trading allowance: the allowance is used instead.
  await card.getByRole('button', { name: 'Edit' }).click();
  let sheet = page.getByRole('dialog', { name: /Your figures for 20\d\d–\d\d/ });
  await sheet.getByLabel('Takings not recorded in this app').fill('20,500');
  await sheet.getByLabel('Business expenses').fill('nonsense');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Check the expenses');
  await sheet.getByLabel('Business expenses').fill('200');
  await shot(page, '10b-tax-edit');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect(page.getByText(/Saved your figures for 20\d\d–\d\d/)).toBeVisible();
  await expect(row('Other takings')).toHaveText('£20,500');
  await expect(card.getByText('Used instead of your £200 of expenses, as it’s bigger: it’s one or the other, not both.')).toBeVisible();
  const allowance = -pounds(await row('Trading allowance').textContent());
  expect([1_000, 3_000]).toContain(allowance);
  const before = pounds(await total.textContent());
  expect(before).toBeGreaterThan(1_000);
  await expect(card.getByText(/about \d+% of your takings/)).toBeVisible();
  await expect(card.getByText('From here, put aside about 26p of each £1 you take.')).toBeVisible();
  // A bill of £1,000 or more: January is the bill plus half of it again, and July the other half.
  const plan = card.locator('.od-taxcard-plan');
  await expect(plan).toContainText(/payments on account/);
  await expect(plan.locator('dt').first()).toHaveText(/^By 31 January 20\d\d$/);
  await expect(plan.locator('dt').nth(1)).toHaveText(/^By 31 July 20\d\d$/);
  const january = pounds(await plan.locator('dd').first().textContent());
  const july = pounds(await plan.locator('.od-taxcard-rows > div').nth(1).locator('dd').textContent());
  expect(january).toBe(before + july);
  expect(Math.abs(2 * july - before)).toBeLessThanOrEqual(1);
  await expect(plan.getByText(`This bill, plus £${july.toLocaleString('en-GB')} towards`)).toBeVisible();
  // Over £20,000 of takings: Making Tax Digital is coming, two years on at the latest.
  await expect(card.getByText(/Making Tax Digital\s+applies to you from 6 April 20\d\d at the latest/)).toBeVisible();
  await expect(card.getByText(/^Sooner if an earlier tax year’s takings were over its limit:$/)).toBeVisible();
  await shot(page, '10c-tax-card');

  // Bigger expenses replace the allowance, and the estimate drops by 26p for each £1 of profit they take off.
  await card.getByRole('button', { name: 'Edit' }).click();
  sheet = page.getByRole('dialog', { name: /Your figures for/ });
  await expect(sheet.getByLabel('Takings not recorded in this app')).toHaveValue('20500');
  await sheet.getByLabel('Business expenses').fill('4000');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect(row('Expenses')).toHaveText('−£4,000');
  await expect(card.getByText('Trading allowance')).toHaveCount(0);
  await expect.poll(async () => pounds(await total.textContent())).toBeLessThan(before);
  const after = pounds(await total.textContent());
  expect(Math.abs(before - after - (4_000 - allowance) * 0.26)).toBeLessThanOrEqual(1);

  // Kept after a reload, for that tax year only.
  await page.reload();
  await page.getByRole('radio', { name: 'Tax year' }).click();
  await expect(row('Other takings')).toHaveText('£20,500');
  await expect(row('Expenses')).toHaveText('−£4,000');
  await expect(total).toHaveText(`£${after.toLocaleString('en-GB')}`);
  // The year before has nothing in the demo: it asks for that year's figures instead of showing £0.
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(card.getByText(/^No takings for 20\d\d–\d\d in the app$/)).toBeVisible();
  await expect(total).toHaveCount(0);
  await card.getByRole('button', { name: 'Edit' }).click();
  sheet = page.getByRole('dialog', { name: /Your figures for/ });
  await expect(sheet.getByLabel('Takings not recorded in this app')).toHaveValue('');
  await sheet.getByLabel('Takings not recorded in this app').fill('9,000');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await expect(total).toHaveText('£0');
  // £9,000 of takings for a finished year: under the personal allowance, so nothing to pay.
  await expect(card.getByText('Nothing to pay: the first £12,570 of profit each tax year is tax-free.')).toBeVisible();
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
