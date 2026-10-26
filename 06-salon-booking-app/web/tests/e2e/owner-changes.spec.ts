import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays, fmtDayLong, fmtDayTime, todayInZone, zonedToInstant } from '../../src/lib/time';

// The owner's side of clients changing their own bookings, and 72-hour reminders.
// The demo seed has Amelia's infill moved online (day 7 15:00 → day 8 12:00),
// Isla's gel toes (tomorrow 15:30) cancelled late online, and Ruby booked in three days.
const today = todayInZone();
const at = (day: number, hhmm: string) => fmtDayTime(zonedToInstant(addDays(today, day), hhmm));
const dayName = (day: number) => fmtDayLong(zonedToInstant(addDays(today, day), '12:00'));

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
const section = (page: Page, title: string) => page.locator(`.section-title:has-text("${title}") + .card`);
const waText = async (link: Locator) => decodeURIComponent((await link.getAttribute('href'))!.split('text=')[1]);

test('Today lists what clients changed, and late cancellations need attention', async ({ page }) => {
  await signIn(page);
  const changes = section(page, 'Changed by clients');
  const moved = changes.getByRole('link', { name: /^Amelia Hart moved/ });
  await expect(moved).toContainText(`Amelia Hart moved BIAB infill to ${at(8, '12:00')} (was ${at(7, '15:00')})`);
  await expect(moved).toContainText('3 hr ago');
  await expect(moved.locator('.chip')).toHaveCount(0);
  const cancelled = changes.getByRole('link', { name: /^Isla Morgan cancelled/ });
  await expect(cancelled).toContainText(`Isla Morgan cancelled Gel polish — toes on ${at(1, '15:30')}`);
  await expect(cancelled).toContainText('“Sorry — something came up at work.”');
  await expect(cancelled.locator('.chip.danger')).toHaveText('Late');
  // Newest first.
  await expect(changes.getByRole('link').first()).toContainText('Amelia Hart');

  const attention = page.locator('.card.attention', { hasText: 'Late cancellations' });
  await expect(attention).toContainText('Isla Morgan');
  await expect(attention).toContainText('Full £25 payable under your policy');
  await expect(attention.locator('.chip.danger')).toHaveText('Late cancel');

  // The cancelled booking is flagged in the diary too.
  await page.goto(`/diary?d=${addDays(today, 1)}`);
  await expect(section(page, 'Cancelled').getByRole('link', { name: /Isla Morgan/ }).locator('.chip.danger', { hasText: 'Late cancel' })).toBeVisible();
});

test('a late cancellation: who cancelled, the charge, a WhatsApp and recording the money', async ({ page }) => {
  await signIn(page);
  await page.locator('.card.attention', { hasText: 'Late cancellations' }).getByRole('link', { name: /Isla Morgan/ }).click();
  await expect(page.getByRole('heading', { name: 'Isla Morgan' })).toBeVisible();
  await expect(page.getByText('Cancelled by the client online')).toBeVisible();
  await expect(page.getByText('Their reason: “Sorry — something came up at work.”')).toBeVisible();

  const card = page.locator('.card.attention', { hasText: 'Late cancellation' });
  await expect(card).toContainText('Cancelled with less than 48 hours’ notice. Under your cancellation policy the full £25 is payable — you arrange this with the client yourself.');

  const wa = card.getByRole('link', { name: 'WhatsApp Isla' });
  expect(await wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/447700900104\?text=/);
  const text = await waText(wa);
  expect(text).toContain(`Hi Isla, sorry you couldn’t make your Gel polish — toes appointment on ${dayName(1)} at 15:30.`);
  expect(text).toContain('As it was cancelled with less than 48 hours’ notice, the full £25 is payable under my cancellation policy.');
  expect(text).toContain('Sort code: 00-00-00');
  expect(text).toMatch(/Reference: [A-HJ-NP-Z2-9]{6}/);

  const history = section(page, 'Changes made by the client');
  await expect(history).toContainText('Cancelled');
  await expect(history).toContainText(`Gel polish — toes · ${at(1, '15:30')}`);
  await expect(history.locator('.chip.danger')).toHaveText('Late');

  await card.getByRole('button', { name: 'Record payment received' }).click();
  await expect(page.getByLabel('Amount received (£)')).toHaveValue('25.00');
  await page.getByRole('radio', { name: 'Bank transfer' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card).toContainText('Payment recorded: £25 by bank transfer');
  await expect(card.getByRole('button', { name: 'Record payment received' })).toHaveCount(0);

  // It's in the takings, for the tax return…
  await page.getByRole('link', { name: 'Money' }).click();
  await expect(page.getByText('Late cancellation · Gel polish — toes · Other income · Bank transfer')).toBeVisible();
  // …and no longer needs attention on Today.
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(section(page, 'Changed by clients')).toBeVisible();
  await expect(page.locator('.card.attention', { hasText: 'Late cancellations' })).toHaveCount(0);
});

test('WhatsApp reminders cover the next 3 days, and sent ones drop off', async ({ page }) => {
  await page.context().route('https://wa.me/**', (r) => r.fulfill({ body: 'WhatsApp' }));
  await signIn(page);
  await page.getByRole('link', { name: 'Send 3 WhatsApp reminders' }).click();
  await expect(page.getByText('Reminders for the next 3 days')).toBeVisible();
  await expect(page.locator('.day-head h2')).toHaveText(['Tomorrow', dayName(2), dayName(3), 'Today']);

  const day3 = page.locator(`.day-head:has-text("${dayName(3)}") + .card`);
  await expect(day3).toContainText('10:30 · Ruby Clarke');
  const remind = day3.getByRole('link', { name: 'Send reminder' });
  expect(await waText(remind)).toContain('Just a reminder of your Gel polish — hands appointment');
  // Amelia is 8 days away: outside the window. Isla's cancelled booking isn't offered.
  await expect(page.getByText('Amelia Hart')).toHaveCount(0);
  await expect(page.getByText('Gel polish — toes')).toHaveCount(0);

  const popup = page.waitForEvent('popup');
  await remind.click();
  await (await popup).close();
  await expect(day3).toContainText('✓ WhatsApp opened');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Send 2 WhatsApp reminders' })).toBeVisible();
});

test('moving a booking emails the client, and the change/cancel link can be shared', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  await section(page, 'Changed by clients').getByRole('link', { name: /^Amelia Hart moved/ }).click();
  await expect(page.getByRole('heading', { name: 'Amelia Hart' })).toBeVisible();
  const history = section(page, 'Changes made by the client');
  await expect(history).toContainText('Moved');
  await expect(history).toContainText(`${at(7, '15:00')} → ${at(8, '12:00')}`);

  // The client's own link.
  const linkCard = page.locator('.card', { hasText: 'Lets Amelia change or cancel this booking themselves.' });
  const share = linkCard.getByRole('link', { name: 'Send on WhatsApp' });
  const text = await waText(share);
  expect(text).toMatch(/your BIAB infill appointment on .+ at 12:00: http:\/\/localhost:\d+\/manage\/[0-9a-f-]{36}/);
  expect(text).toContain('Please make any changes by');
  await linkCard.getByRole('button', { name: 'Copy link' }).click();
  await expect(page.getByText('Link copied')).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/manage\/[0-9a-f-]{36}$/);

  // Move it and tell her by email.
  await page.getByRole('button', { name: 'Change time' }).click();
  const tell = page.getByLabel('Email Amelia their new time');
  await expect(tell).toBeChecked();
  await page.getByLabel('Start time').fill('16:00');
  await page.getByRole('button', { name: 'Save new time' }).click();
  await expect(page.getByText('Time changed — Amelia will be emailed')).toBeVisible();
  await expect(page.getByText(`${dayName(8)} · 16:00–17:00`)).toBeVisible();
  await expect(section(page, 'Emails').locator('li', { hasText: 'Booking changed' })).toContainText('Waiting to send');

  // Chloe has no email address: a hint to WhatsApp her instead.
  await page.goto('/');
  await page.getByRole('link', { name: /Chloe Bennett/ }).first().click();
  await page.getByRole('button', { name: 'Change time' }).click();
  await expect(page.getByText('There’s no email address for Chloe')).toBeVisible();
  await expect(page.getByLabel(/Email Chloe/)).toHaveCount(0);
});

test('cancellation settings and the reminder window save', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Settings' }).click();
  await page.getByRole('link', { name: /Deposits & cancellations/ }).click();
  await expect(page.getByRole('heading', { name: 'Deposits & cancellations' })).toBeVisible();
  const notice = page.getByLabel('Notice needed to cancel (hours)');
  await expect(notice).toHaveValue('48');
  await notice.fill('24');
  await expect(page.getByText('Your policy wording says 48 hours, but the notice here is 24 hours.')).toBeVisible();
  const online = page.getByLabel(/Clients can change or cancel their booking online/);
  await expect(online).toBeChecked();
  await online.uncheck();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Notice needed to cancel (hours)')).toHaveValue('24');
  await expect(page.getByLabel(/Clients can change or cancel their booking online/)).not.toBeChecked();

  await page.goto('/settings/rules');
  const hours = page.getByLabel('Reminders (hours before)');
  await expect(hours).toHaveValue('72');
  await hours.fill('24');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();

  // 24 hours: tomorrow only, so Ruby (in three days) isn't listed.
  await page.goto('/reminders');
  await expect(page.getByText('Reminders for tomorrow')).toBeVisible();
  await expect(page.locator('.day-head h2')).toHaveText(['Tomorrow', 'Today']);
  await expect(page.getByText('Ruby Clarke')).toHaveCount(0);

  // With online changes switched off, there's no change/cancel link to share.
  await page.goto('/');
  await page.getByRole('link', { name: /Chloe Bennett/ }).first().click();
  await expect(page.getByRole('button', { name: 'Change time' })).toBeVisible();
  await expect(page.getByText('Change or cancel link')).toHaveCount(0);
});
