import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays, fmtDayLong, fmtDayTime, fmtTime, todayInZone, zonedToInstant } from '../../src/lib/time';

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
const lateCard = (page: Page) => page.locator('.card.attention', { hasText: 'Late cancellations' });

// The demo's data, straight from this browser's storage.
const KEY = 'salon-demo-v4';
interface DemoAppt {
  id: string; booking_name: string; status: string; starts_at: string; ends_at: string; busy_until: string; duration_min: number;
  public_token: string; service_name: string; price_pence: number; late_fee_pence: number | null; cancelled_at: string | null;
  deposit_required_pence: number; deposit_paid_at: string | null; booking_phone: string | null; moved_at: string | null;
  details_sent_at: string | null; client_id: string;
}
interface DemoStore {
  appointments: DemoAppt[];
  clients: { id: string; full_name: string; phone: string | null; phone_e164: string | null }[];
  outbox: { appointment_id: string; kind: string }[];
  settings: { reminder_hours_before: number; slot_interval_min: number };
}
async function demo(page: Page): Promise<DemoStore> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
}
/** Change the demo data; pages read it when they load, so navigate afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}
async function appt(page: Page, name: string, status = 'confirmed'): Promise<DemoAppt> {
  const a = (await demo(page)).appointments.find((x) => x.booking_name === name && x.status === status);
  expect(a, `${name}'s ${status} booking in the demo`).toBeTruthy();
  return a!;
}

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
  expect(text).toContain('Hi Amelia, here’s your own link for your BIAB infill appointment on');
  // Eight days away: the time to change by, 48 hours before, is still ahead.
  const by = new Date(zonedToInstant(addDays(today, 8), '12:00').getTime() - 48 * 3600e3);
  expect(text).toContain(`Please do it by ${fmtDayLong(by)} at ${fmtTime(by)}: http://localhost:`);
  expect(text).toMatch(/\/manage\/[0-9a-f-]{36}\nDemo Nail Studio$/);
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

  // Chloe is tomorrow, already inside the notice: no time to change by that has passed, just that the policy applies.
  await page.goto('/');
  await page.getByRole('link', { name: /Chloe Bennett/ }).first().click();
  const chloeLink = await waText(page.locator('.card', { hasText: 'Lets Chloe change or cancel' }).getByRole('link', { name: 'Send on WhatsApp' }));
  expect(chloeLink).not.toContain('Please do it by');
  expect(chloeLink).toMatch(/\/manage\/[0-9a-f-]{36} \(it’s now less than 48 hours before, so the cancellation policy applies\)/);

  // Chloe has no email address: a hint to WhatsApp her instead.
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
  // Online changes are off, so the reminder asks them to get in touch rather than sending a link that can't be used.
  const reminder = await waText(page.locator('li', { hasText: 'Chloe Bennett' }).getByRole('link', { name: 'Send reminder' }));
  expect(reminder).toContain('Need to change or cancel? Just get in touch.');
  expect(reminder).not.toContain('/manage/');

  // With online changes switched off, there's no change/cancel link to share.
  await page.goto('/');
  await page.getByRole('link', { name: /Chloe Bennett/ }).first().click();
  await expect(page.getByRole('button', { name: 'Change time' })).toBeVisible();
  await expect(page.getByText('Change or cancel link')).toHaveCount(0);
});

test('a client who cancels late by WhatsApp: the owner cancels it and marks it late', async ({ page }) => {
  await signIn(page);
  // Chloe is booked for tomorrow at 11:00, inside the 48-hour notice period.
  await page.getByRole('link', { name: /Chloe Bennett/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Chloe Bennett' })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel('Reason (optional)').fill('Messaged me this morning');
  await page.getByLabel(/Chloe cancelled with less than 48 hours’ notice/).check();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();

  await expect(page.getByText('Cancelled by you')).toBeVisible();
  await expect(page.locator('.card.attention', { hasText: 'Late cancellation' })).toContainText('the full £25 is payable');
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page.locator('.card.attention', { hasText: 'Late cancellations' })).toContainText('Chloe Bennett');
});

test('a late cancellation she marked herself stays on Today after its day has gone, until it’s paid', async ({ page }) => {
  await signIn(page);
  const chloe = await appt(page, 'Chloe Bennett');
  await page.goto(`/appointments/${chloe.id}`);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.getByLabel(/Chloe cancelled with less than 48 hours’ notice/).check();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  await expect(page.getByText('Cancelled by you')).toBeVisible();

  // Five days on: the appointment was four days ago, and the money still hasn't come in.
  await editDemo(page, (db) => {
    const a = db.appointments.find((x) => x.id === chloe.id)!;
    const starts = zonedToInstant(addDays(today, -4), '11:00');
    a.starts_at = starts.toISOString();
    a.ends_at = new Date(starts.getTime() + a.duration_min * 60e3).toISOString();
    a.busy_until = a.ends_at;
    a.cancelled_at = zonedToInstant(addDays(today, -5), '09:00').toISOString();
  });
  await page.goto('/');
  const row = lateCard(page).getByRole('link', { name: /Chloe Bennett/ });
  await expect(row).toContainText(`Gel polish — hands · ${at(-4, '11:00')}`);
  await expect(row).toContainText('Full £25 payable under your policy');
  await expect(lateCard(page)).toContainText('Late cancellations · 2');

  await row.click();
  await page.getByRole('button', { name: 'Record payment received' }).click();
  await expect(page.getByLabel('Amount received (£)')).toHaveValue('25.00');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Payment recorded: £25 by bank transfer')).toBeVisible();
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(lateCard(page)).toContainText('Late cancellations · 1');
  await expect(lateCard(page).getByRole('link', { name: /Chloe Bennett/ })).toHaveCount(0);
});

test('a late cancellation with a deposit and a part payment: Today and the appointment agree on the balance', async ({ page }) => {
  await signIn(page);
  // A deposit that covers the whole charge leaves nothing to chase.
  const paidAt = new Date(Date.now() - 2 * 86400e3).toISOString();
  await editDemo(page, (db) => {
    Object.assign(db.appointments.find((a) => a.booking_name === 'Isla Morgan' && a.status === 'cancelled')!,
      { deposit_required_pence: 2500, deposit_paid_at: paidAt });
  });
  await page.goto('/');
  await expect(section(page, 'Changed by clients')).toBeVisible();
  await expect(lateCard(page)).toHaveCount(0);

  // A £10 deposit, and she'd switched to a £10 removal inside the notice before cancelling: the £25 still applies.
  await editDemo(page, (db) => {
    Object.assign(db.appointments.find((a) => a.booking_name === 'Isla Morgan' && a.status === 'cancelled')!,
      { service_name: 'Removal only', price_pence: 1000, late_fee_pence: 2500, deposit_required_pence: 1000 });
  });
  await page.goto('/');
  await expect(lateCard(page)).toContainText('Balance £15 of the full £25 payable under your policy');

  await lateCard(page).getByRole('link', { name: /Isla Morgan/ }).click();
  const card = page.locator('.card.attention', { hasText: 'Late cancellation' });
  await expect(card).toContainText('Under your cancellation policy the full £25 is payable');
  await expect(card).toContainText('it’s £10 now');
  await expect(card).toContainText('They’ve already paid a £10 deposit, so the balance is £15.');
  expect(await waText(card.getByRole('link', { name: 'WhatsApp Isla' })))
    .toContain('the full £25 is payable under my cancellation policy — that’s £15 after the £10 deposit you’ve already paid.');

  // She pays £5 for now.
  await card.getByRole('button', { name: 'Record payment received' }).click();
  await expect(page.getByLabel('Amount received (£)')).toHaveValue('15.00');
  await page.getByLabel('Amount received (£)').fill('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card).toContainText('Payment recorded: £5 by bank transfer');
  await expect(card).toContainText('Still owed: £10.');
  expect(await waText(card.getByRole('link', { name: 'WhatsApp Isla' }))).toContain('— that’s £10 after the £15 you’ve already paid.');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(lateCard(page)).toContainText('Balance £10 of the full £25 payable under your policy');

  // Then the rest: nothing more to chase.
  await lateCard(page).getByRole('link', { name: /Isla Morgan/ }).click();
  await card.getByRole('button', { name: 'Record payment received' }).click();
  await expect(page.getByLabel('Amount received (£)')).toHaveValue('10.00');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(card.getByRole('button', { name: 'Record payment received' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(section(page, 'Changed by clients')).toBeVisible();
  await expect(lateCard(page)).toHaveCount(0);
});

test('a returning client who types a different mobile: the owner checks it before WhatsApping', async ({ page }) => {
  await page.goto('/book');
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Full name').fill('Ruby Clarke');
  await page.getByLabel('Email').fill('ruby@example.com');
  await page.getByLabel('Mobile').fill('07700 900999');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await page.getByLabel(/16 or over/).check();
  await page.getByLabel(/agree to the cancellation policy/).check();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();

  // Flagged on the reminders list…
  await signIn(page);
  await page.goto('/reminders');
  const check = page.getByRole('link', { name: 'Check mobile' });
  await expect(check).toHaveCount(1);
  await expect(page.locator('li', { has: check })).toContainText('Ruby Clarke');
  await check.click();

  // …and on the appointment, with nothing carrying her private link sent by WhatsApp until it's checked.
  const note = page.getByRole('note', { name: 'Check their mobile' });
  await expect(note).toContainText('The mobile given with this booking (07700 900999) is different from 07700 900106 on their client record. Check which is right before you WhatsApp them.');
  const linkCard = page.locator('.card', { hasText: 'Lets Ruby change or cancel this booking themselves.' });
  await expect(linkCard).toContainText('Check their mobile above before you send this link.');
  await expect(linkCard.getByRole('link', { name: 'Send on WhatsApp' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Send form link' })).toHaveCount(0);
  expect(await waText(page.getByRole('link', { name: 'WhatsApp', exact: true }))).toBe('Hi Ruby, ');

  await note.getByRole('button', { name: 'Use 07700 900999 for this client' }).click();
  await expect(page.getByText('Client record updated to 07700 900999')).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(await linkCard.getByRole('link', { name: 'Send on WhatsApp' }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/447700900999\?text=/);
  const db = await demo(page);
  expect(db.clients.find((c) => c.full_name === 'Ruby Clarke')!.phone_e164).toBe('447700900999');
  expect(db.appointments.filter((a) => a.booking_phone)).toEqual([]);
  await page.goto('/reminders');
  await expect(page.getByText('Ruby Clarke').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Check mobile' })).toHaveCount(0);
});

test('keeping the number on the client record clears the warning', async ({ page }) => {
  await signIn(page);
  const chloe = await appt(page, 'Chloe Bennett');
  await editDemo(page, (db) => { db.appointments.find((a) => a.id === chloe.id)!.booking_phone = '07700 900555'; });
  await page.goto(`/appointments/${chloe.id}`);
  const note = page.getByRole('note', { name: 'Check their mobile' });
  await expect(note).toContainText('(07700 900555) is different from 07700 900105 on their client record');
  await note.getByRole('button', { name: 'Keep the record’s number' }).click();
  await expect(page.getByText('Kept the number on their record')).toBeVisible();
  await expect(note).toHaveCount(0);
  expect(await page.getByRole('link', { name: 'WhatsApp', exact: true }).getAttribute('href')).toMatch(/^https:\/\/wa\.me\/447700900105\?text=/);
  const db = await demo(page);
  expect(db.clients.find((c) => c.id === chloe.client_id)!.phone_e164).toBe('447700900105');
  expect(db.appointments.find((a) => a.id === chloe.id)!.booking_phone).toBeNull();
});

test('a new change/cancel link stops the old one working', async ({ page }) => {
  await signIn(page);
  const amelia = await appt(page, 'Amelia Hart');
  await page.goto(`/appointments/${amelia.id}`);
  const linkCard = page.locator('.card', { hasText: 'Lets Amelia change or cancel this booking themselves.' });
  await expect(linkCard).toContainText(`/manage/${amelia.public_token}`);

  // It asks first; saying no keeps the link.
  let asked = '';
  page.once('dialog', (d) => { asked = d.message(); void d.dismiss(); });
  await linkCard.getByRole('button', { name: 'Make a new link' }).click();
  expect(asked).toBe('The old link will stop working. Use this if the link reached the wrong person.');
  expect((await appt(page, 'Amelia Hart')).public_token).toBe(amelia.public_token);

  page.once('dialog', (d) => void d.accept());
  await linkCard.getByRole('button', { name: 'Make a new link' }).click();
  await expect(page.getByText('New link made — the old one no longer works')).toBeVisible();
  const token = (await appt(page, 'Amelia Hart')).public_token;
  expect(token).not.toBe(amelia.public_token);
  await expect(linkCard).toContainText(`/manage/${token}`);
  expect(await waText(linkCard.getByRole('link', { name: 'Send on WhatsApp' }))).toContain(`/manage/${token}`);

  await page.goto(`/manage/${amelia.public_token}`);
  await expect(page.getByText(/expired or isn’t valid/)).toBeVisible();
  await page.goto(`/manage/${token}`);
  await expect(page.getByText('Hi Amelia, here’s your booking')).toBeVisible();
});

test('saving the same time changes nothing and sends no email', async ({ page }) => {
  await signIn(page);
  const ruby = await appt(page, 'Ruby Clarke');
  await page.goto(`/appointments/${ruby.id}`);
  await page.getByRole('button', { name: 'Change time' }).click();
  await expect(page.getByLabel('Email Ruby their new time')).toBeChecked();
  await page.getByRole('button', { name: 'Save new time' }).click();
  await expect(page.getByText('Nothing changed')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const db = await demo(page);
  const after = db.appointments.find((a) => a.id === ruby.id)!;
  expect([after.starts_at, after.duration_min, after.moved_at, after.details_sent_at]).toEqual([ruby.starts_at, ruby.duration_min, null, null]);
  expect(db.outbox.filter((o) => o.appointment_id === ruby.id)).toEqual([]);
  await expect(section(page, 'Emails')).toContainText('No emails yet.');

  // A new length on its own is a change.
  await page.getByRole('button', { name: 'Change time' }).click();
  await page.getByRole('spinbutton', { name: 'Minutes' }).fill('60');
  await page.getByRole('button', { name: 'Save new time' }).click();
  await expect(page.getByText('Time changed — Ruby will be emailed')).toBeVisible();
  await expect(page.getByText(`${dayName(3)} · 10:30–11:30`)).toBeVisible();
});

test('booking rules are checked before they’re saved', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/rules');
  const save = page.getByRole('button', { name: 'Save', exact: true });
  const hours = page.getByLabel('Reminders (hours before)');
  for (const bad of ['500', '1', '2.5', '']) {
    await hours.fill(bad);
    await save.click();
    await expect(page.getByRole('alert')).toHaveText('Reminders must be a whole number of hours from 2 to 168.');
  }
  await hours.fill('48');
  const every = page.getByLabel('Start times every (minutes)');
  await every.fill('3');
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('Start times must be a whole number of minutes apart, from 5 to 120.');
  await every.fill('15');
  await page.getByLabel('Gap after each appointment (minutes)').fill('-5');
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('The gap after each appointment must be a whole number of minutes from 0 to 120.');
  expect((await demo(page)).settings.reminder_hours_before).toBe(72);

  await page.getByLabel('Gap after each appointment (minutes)').fill('10');
  await save.click();
  await expect(page.getByText('Saved')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await demo(page)).settings.reminder_hours_before).toBe(48);
});

test('a deposit chased on WhatsApp still gets its reminder once the deposit is in', async ({ page }) => {
  await page.context().route('https://wa.me/**', (r) => r.fulfill({ body: 'WhatsApp' }));
  await signIn(page);
  await page.getByRole('link', { name: 'Send 3 WhatsApp reminders' }).click();
  const sophie = page.locator('li', { hasText: 'Sophie Turner' });
  const popup = page.waitForEvent('popup');
  await sophie.getByRole('link', { name: 'Ask for deposit' }).click();
  await (await popup).close();
  await expect(sophie).toContainText('✓ WhatsApp opened');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Send 2 WhatsApp reminders' })).toBeVisible();

  // The money arrives: the chase wasn't the reminder, so she's offered one.
  await page.goto(`/appointments/${(await appt(page, 'Sophie Turner', 'pending_deposit')).id}`);
  await page.getByRole('button', { name: 'Deposit received' }).click();
  await page.getByRole('button', { name: 'Confirm deposit received' }).click();
  await expect(page.locator('.chip.ok', { hasText: 'Confirmed' })).toBeVisible();
  await page.goto('/reminders');
  await expect(sophie.getByRole('link', { name: 'Send reminder' })).toBeVisible();
  await expect(sophie).not.toContainText('✓ WhatsApp opened');
  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Send 3 WhatsApp reminders' })).toBeVisible();
});
