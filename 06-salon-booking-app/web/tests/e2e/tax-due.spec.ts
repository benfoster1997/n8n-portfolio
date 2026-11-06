import { expect, test, type Page } from '@playwright/test';

// Tax on Today: from 1 December to 31 January the bill for the tax year before (2025–26, due
// Sunday 31 January 2027), and in July the 31 July payment on account. Money → Month says
// roughly what to put aside from the month's takings. The clock is fixed before the demo is
// seeded, so the demo's takings fall in the fortnight before it.
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoStore { tax_years: { start_year: number; extra_takings_pence: number; expenses_pence: number; updated_at: string | null }[] }
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/** Change the demo's saved data; it's read when a page loads, so reload afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}
const figures = (start_year: number, extraPounds: number, expensesPounds: number) =>
  ({ start_year, extra_takings_pence: extraPounds * 100, expenses_pence: expensesPounds * 100, updated_at: '2026-12-01T10:00:00.000Z' });

async function signIn(page: Page, now: Date) {
  await page.clock.install({ time: now });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
async function reloadToday(page: Page) {
  await page.reload();
  await expect(page.getByText('Today’s appointments')).toBeVisible();
}
const taxCard = (page: Page) => page.locator('a.td-tax');

test('from 1 December, Today shows the 31 January bill; tapping it opens that tax year to add her figures', async ({ page }) => {
  await signIn(page, new Date('2026-12-07T09:15:00Z')); // Monday 7 December 2026
  const card = taxCard(page);
  await expect(card).toContainText('Your 2025–26 tax return and bill are due Sunday 31 January. Pay by Friday 29 January to be safe.');
  // Nothing saved for 2025–26 and no takings in the app for it (she was on another app): no figure, just what to do.
  await expect(card).toContainText('Add your 2025–26 takings and expenses to see your bill.');
  await expect(card).not.toContainText('About £');
  await shot(page, 't01-today-tax-no-figures');

  await card.click();
  await expect(page.getByText('Tax year 2025–26')).toBeVisible();
  const money = page.getByRole('region', { name: 'Tax to put aside' });
  await expect(money.getByText('No takings for 2025–26 in the app')).toBeVisible();
  await money.getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your figures for 2025–26' });
  await sheet.getByLabel('Takings not recorded in this app').fill('28,500');
  await sheet.getByLabel('Business expenses').fill('2150');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  // £26,350 of profit: a £3,583 bill, and as it's £1,000 or more, £1,791 towards 2026–27 with it.
  const plan = money.locator('.od-taxcard-plan .od-taxcard-rows > div').first();
  await expect(plan).toContainText('By 31 January 2027');
  await expect(plan).toContainText('£5,374');

  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(card).toContainText('About £5,374 on your figures, including the first payment towards 2026–27: your £3,583 bill, plus £1,791.');
  await expect(card).toContainText('Less anything you’ve already paid towards 2025–26 (the HMRC app shows the exact amount).');
  await shot(page, 't02-today-tax-bill');
});

test('the tax card shows only before a due date: not in November or February; in July, the 31 July payment', async ({ page }) => {
  await signIn(page, new Date('2026-11-30T12:00:00Z'));
  await editDemo(page, (db) => { db.tax_years.push(figures(2025, 28_500, 2_150)); });
  await reloadToday(page);
  await expect(taxCard(page)).toHaveCount(0);

  await page.clock.setSystemTime(new Date('2026-12-01T08:00:00Z'));
  await reloadToday(page);
  await expect(taxCard(page)).toContainText('About £5,374 on your figures');

  await page.clock.setSystemTime(new Date('2027-02-01T08:00:00Z'));
  await reloadToday(page);
  await expect(taxCard(page)).toHaveCount(0);

  // July 2027: the second payment towards 2026–27, half the 2025–26 bill.
  await page.clock.setSystemTime(new Date('2027-07-05T08:00:00Z'));
  await reloadToday(page);
  const card = taxCard(page);
  await expect(card).toContainText('Half your 2025–26 bill again is due Saturday 31 July, towards 2026–27, if HMRC asked for payments on account. '
    + 'Pay by Friday 30 July to be safe.');
  await expect(card).toContainText('About £1,791 on your figures.');
  await expect(card).toHaveAttribute('href', '/money?taxyear=2025');
  await shot(page, 't03-today-tax-july');

  // A 2025–26 bill under £1,000: nothing is due on 31 July, so no card.
  await editDemo(page, (db) => { db.tax_years = [figures(2025, 16_000, 0)]; });
  await reloadToday(page);
  await expect(page.getByText('Tomorrow', { exact: true })).toBeVisible();
  await expect(taxCard(page)).toHaveCount(0);
});

test('Money → Month: what to put aside from the month’s takings, as her profit passes the tax-free allowance', async ({ page }) => {
  // Friday 20 November 2026: the demo's takings (£190) are all in November so far.
  await signIn(page, new Date('2026-11-20T12:00:00Z'));
  await page.getByRole('link', { name: 'Money', exact: true }).click();
  await expect(page.getByText('November 2026')).toBeVisible();
  const line = page.locator('.od-putaside');
  // Nothing saved for 2026–27 yet: on the app's takings alone it's all tax-free, and it says what's missing.
  await expect(line).toContainText('Nothing to put aside for tax from the £190 taken so far this month: on your figures, your profit for 2026–27 is still tax-free.');
  await expect(line).toContainText('Took money another way in 2026–27, such as through another app? Add it under Tax year → Edit, or this will be too low.');

  // £13,500 taken through another app before she switched: £12,500 of profit before November,
  // £12,690 after it, so £120 of November's takings is taxed (at 26%: £31.20).
  await page.getByRole('radio', { name: 'Tax year' }).click();
  const money = page.getByRole('region', { name: 'Tax to put aside' });
  await money.getByRole('button', { name: 'Edit' }).click();
  const sheet = page.getByRole('dialog', { name: 'Your figures for 2026–27' });
  await sheet.getByLabel('Takings not recorded in this app').fill('13500');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
  await page.getByRole('radio', { name: 'Month' }).click();
  await expect(line).toContainText('Put aside about £31 of the £190 taken so far this month, for tax.');
  await expect(line).toContainText('That’s how much this month adds to your rough tax estimate for 2026–27.');
  await expect(line).not.toContainText('Took money another way');
  await shot(page, 't04-money-month-put-aside');

  // A past month says the month's name. October has no takings in the demo, so no line.
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('October 2026')).toBeVisible();
  await expect(page.getByText('Nothing recorded for this period.')).toBeVisible();
  await expect(line).toHaveCount(0);

  // Deleting an entry changes it straight away: £150 left, £80 of it taxed (£20.80).
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(line).toContainText('£190');
  page.once('dialog', (d) => void d.accept());
  await page.locator('.od-pay', { hasText: 'Grace Patel' }).getByRole('button', { name: 'Delete entry' }).click();
  await expect(line).toContainText('Put aside about £21 of the £150 taken so far this month, for tax.');
});

test('a past month: “Put aside about £X of November’s £Y for tax”', async ({ page }) => {
  await signIn(page, new Date('2026-12-02T12:00:00Z'));
  // November's demo takings: £35 + £40 + £35 + £25 + £25 + £30 = £190, on top of £16,000 from before she switched
  // (£15,000 of profit after the trading allowance), so all of it at 26p in the £1: £49.40.
  await editDemo(page, (db) => { db.tax_years.push(figures(2026, 16_000, 0)); });
  await page.goto('/money');
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('November 2026')).toBeVisible();
  await expect(page.locator('.od-putaside')).toContainText('Put aside about £49 of November’s £190 for tax.');
  await expect(page.locator('.od-putaside')).toContainText('That’s how much November adds to your rough tax estimate for 2026–27.');
});
