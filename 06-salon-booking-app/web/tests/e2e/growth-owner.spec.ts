import { expect, test, type Locator, type Page } from '@playwright/test';
import { zonedToInstant } from '../../src/lib/time';
import { STOP_LINE } from '../../src/lib/text';

// The owner's side of where clients come from, Google reviews and short-notice spaces. The clock is
// fixed at 17:00 on Wednesday 4 November 2026 before the demo is seeded. In the demo, Sophie Turner
// booked tomorrow's BIAB online at 03:00 today, through the Instagram link, and ticked the short-notice
// box; she was also booked in by the owner as a new client on 21 October (and didn't come). Jess Collins
// booked online on 28 October, recommended by Sam. Amelia Hart, a regular, came from Google. Today's
// infills (Isla Morgan at 10:00, Grace Patel at 13:00) are over but not yet marked as done.
const NOW = new Date('2026-11-04T17:00:00Z');
const TODAY = '2026-11-04';
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string, target?: Locator) {
  if (!SHOTS) return;
  await page.waitForTimeout(300); // let a sheet finish sliding up
  if (!target) {
    await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
    return;
  }
  // In the middle of the screen, clear of the floating tab bar, once a card has finished settling in.
  await target.evaluate((el) => el.scrollIntoView({ block: 'center' }));
  await page.waitForTimeout(600);
  await target.screenshot({ path: `${SHOTS}/${name}.png` });
}

interface DemoAppt {
  id: string; client_id: string; status: string; starts_at: string; source: string;
  link_source: string | null; heard_from: string | null; heard_from_detail: string | null;
}
interface DemoClient {
  id: string; full_name: string; phone_e164: string | null;
  marketing_ok_at: string | null; marketing_ok_note: string | null; review_asked_at: string | null;
}
interface DemoStore {
  appointments: DemoAppt[];
  clients: DemoClient[];
  settings: { business_name: string; public_site_url: string | null; review_link: string | null };
}
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/** Change the demo's saved data; it's read when a page loads, so go to a page afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}
const iso = (day: string, hhmm: string) => zonedToInstant(day, hhmm).toISOString();
const client = async (page: Page, name: string) => (await demo(page)).clients.find((c) => c.full_name === name)!;
/** A client's booking that starts at this time. */
async function booking(page: Page, name: string, day: string, hhmm: string): Promise<DemoAppt> {
  const db = await demo(page);
  const c = db.clients.find((x) => x.full_name === name)!;
  const a = db.appointments.find((x) => x.client_id === c.id && x.starts_at === iso(day, hhmm));
  expect(a, `${name}'s booking at ${day} ${hhmm}`).toBeTruthy();
  return a!;
}
const waText = async (link: Locator) => decodeURIComponent((await link.getAttribute('href'))!.split('text=')[1]);

async function signIn(page: Page) {
  await page.clock.install({ time: NOW });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
const foundRow = (page: Page) => page.locator('.od-hero .od-receipt > div', { hasText: 'Found you' });
const origin = (page: Page) => new URL(page.url()).origin;
/** Open an appointment from today and mark it as done with what the sheet suggests. */
async function finish(page: Page, a: DemoAppt, name: string) {
  await page.goto(`/appointments/${a.id}`);
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: 'Finish & take payment' }).click();
  await page.getByRole('button', { name: 'Mark as done' }).click();
  const sheet = page.getByRole('dialog', { name: 'Next visit' });
  await expect(sheet.locator('.od-next-done')).toBeVisible();
  return sheet;
}
const REVIEW_LINK = 'https://g.page/r/DemoStudio123/review';

test('an appointment says how the client found her, and Edit sets it or puts it right', async ({ page }) => {
  await signIn(page);
  // Booked through her Instagram link.
  const sophie = await booking(page, 'Sophie Turner', '2026-11-05', '14:00');
  await page.goto(`/appointments/${sophie.id}`);
  await expect(foundRow(page).locator('dt')).toHaveText('Found you');
  await expect(foundRow(page).locator('dd')).toContainText('Your Instagram link');
  await expect(page.getByRole('button', { name: 'Add how they found you' })).toHaveCount(0);
  await shot(page, 'g01-found-you-row', page.locator('.od-hero'));

  // She told her it was a friend, Grace: her answer counts before the link.
  await foundRow(page).getByRole('button', { name: 'Edit how they found you' }).click();
  const sheet = page.getByRole('dialog', { name: 'How they found you' });
  await expect(sheet.getByText('They booked through your Instagram link.')).toBeVisible();
  await expect(sheet.getByLabel('How did Sophie find you?')).toHaveValue('');
  await expect(sheet.getByLabel('How did Sophie find you?').locator('option')).toHaveText(
    ['Not known', 'Instagram', 'Facebook', 'Google', 'A friend', 'Saw a card or poster', 'Other']);
  await sheet.getByLabel('How did Sophie find you?').selectOption({ label: 'A friend' });
  await sheet.getByLabel('Who recommended them? (optional)').fill('  Grace  ');
  await shot(page, 'g02-found-you-sheet');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(foundRow(page).locator('dd')).toContainText('A friend: Grace');
  expect((await demo(page)).appointments.find((a) => a.id === sophie.id)).toMatchObject(
    { heard_from: 'friend', heard_from_detail: 'Grace', link_source: 'instagram' });

  // The friend's name opens Clients, looking for her.
  await foundRow(page).getByRole('link', { name: 'Grace' }).click();
  await expect(page.getByRole('heading', { name: 'Clients' })).toBeVisible();
  await expect(page.getByLabel('Search clients')).toHaveValue('Grace');
  await expect(page.locator('.od-client-row')).toHaveText([/Grace Patel/]);

  // Back to Not known: the link is all there is to go on again.
  await page.goto(`/appointments/${sophie.id}`);
  await foundRow(page).getByRole('button', { name: 'Edit how they found you' }).click();
  await sheet.getByLabel('How did Sophie find you?').selectOption({ label: 'Not known' });
  await expect(sheet.getByLabel('Who recommended them? (optional)')).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(foundRow(page).locator('dd')).toContainText('Your Instagram link');
  expect((await demo(page)).appointments.find((a) => a.id === sophie.id)).toMatchObject({ heard_from: null, heard_from_detail: null });

  // Nothing recorded: a small link instead of the row.
  const isla = await booking(page, 'Isla Morgan', TODAY, '10:00');
  await page.goto(`/appointments/${isla.id}`);
  await expect(foundRow(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Add how they found you' }).click();
  await sheet.getByLabel('How did Isla find you?').selectOption({ label: 'Other' });
  await sheet.getByLabel('A few words (optional)').fill('A wedding fair');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(foundRow(page).locator('dd')).toContainText('Other: A wedding fair');
  await expect(page.getByRole('button', { name: 'Add how they found you' })).toHaveCount(0);
});

test('the client record says how they found her: their first answer, else the first link', async ({ page }) => {
  await signIn(page);
  // Jess: "A friend: Sam" on her online booking; Sam opens Clients, looking for her (nobody yet).
  await page.goto(`/clients/${(await client(page, 'Jess Collins')).id}`);
  const facts = page.locator('.od-facts');
  await expect(facts).toHaveText('Found you through a friend: Sam');
  await shot(page, 'g03-client-found-you', page.locator('.od-profile'));
  await facts.getByRole('link', { name: 'Sam' }).click();
  await expect(page.getByLabel('Search clients')).toHaveValue('Sam');
  await expect(page.getByText('No matches.')).toBeVisible();

  // Sophie: only the link.
  await page.goto(`/clients/${(await client(page, 'Sophie Turner')).id}`);
  await expect(facts).toHaveText('Found you through your Instagram link');
  // Amelia: a regular, from Google.
  await page.goto(`/clients/${(await client(page, 'Amelia Hart')).id}`);
  await expect(facts).toHaveText('Found you through Google');
  // Ruby: nothing recorded, so nothing said.
  await page.goto(`/clients/${(await client(page, 'Ruby Clarke')).id}`);
  await expect(page.getByRole('heading', { name: 'Ruby Clarke' })).toBeVisible();
  await expect(facts).toHaveCount(0);
});

test('New appointment asks how a new client found her, and only a new client', async ({ page }) => {
  await signIn(page);
  await page.goto('/appointments/new');
  await page.getByRole('button', { name: 'New client' }).click();
  await page.getByLabel('Full name').fill('Amy Walsh');
  await page.getByLabel('Mobile').fill('07700 900200');
  const asked = page.getByLabel('How did they find you?');
  await expect(asked).toHaveValue('');
  await asked.selectOption({ label: 'Saw a card or poster' });
  await expect(page.getByLabel('Who recommended them? (optional)')).toHaveCount(0);
  await page.getByLabel('Date').fill('2026-11-05');
  await page.getByRole('button', { name: '09:30' }).click();
  await shot(page, 'g04-new-appointment-found-you', page.locator('.od-step').last());
  await page.getByRole('button', { name: 'Add to diary' }).click();
  await expect(page.getByRole('heading', { name: 'Amy Walsh' })).toBeVisible();
  await expect(foundRow(page).locator('dd')).toContainText('Saw a card or poster');

  // A client who has been before isn't asked.
  await page.goto(`/appointments/new?client=${(await client(page, 'Amelia Hart')).id}`);
  await expect(page.locator('.od-picked-visits')).toHaveText(/visits/);
  await expect(page.getByLabel('How did they find you?')).toHaveCount(0);
});

test('Money → Month counts the month’s new clients, how they found her and the links they used', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: 'Money' }).click();
  const card = page.getByRole('region', { name: 'New clients' });
  // November so far: Sophie, from the Instagram link, with no answer. October: Sophie (booked in by the
  // owner) and Jess (recommended by Sam).
  await expect(card.locator('p')).toHaveText([
    'November: 1 new client booked · 0 came.',
    'They didn’t say how they found you.',
    'Links used: Instagram 1.',
    'October: 2 new clients booked.',
  ]);
  await shot(page, 'g05-money-new-clients', card);

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.locator('.od-period-label strong')).toHaveText('October 2026');
  await expect(card.locator('p')).toHaveText([
    'October: 2 new clients booked · 0 came.',
    'A friend 1 (Sam) · Didn’t say 1.',
    'September: no new clients booked.',
  ]);

  // Jess's visit marked as done, and a link of her own on Sophie's: they count too.
  await editDemo(page, (db) => {
    const jess = db.clients.find((c) => c.full_name === 'Jess Collins')!;
    db.appointments.find((a) => a.client_id === jess.id && a.source === 'online')!.status = 'completed';
    const sophie = db.clients.find((c) => c.full_name === 'Sophie Turner')!;
    db.appointments.find((a) => a.client_id === sophie.id && a.status === 'no_show')!.link_source = 'summer-fair';
  });
  await page.reload();
  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(card.locator('p')).toHaveText([
    'October: 2 new clients booked · 1 came.',
    'A friend 1 (Sam) · Didn’t say 1.',
    'Links used: summer-fair 1.',
    'September: no new clients booked.',
  ]);

  // The tax year view has no New clients card.
  await page.getByRole('radio', { name: 'Tax year' }).click();
  await expect(card).toHaveCount(0);
});

test('Your links: one for each place, each copied with its own ?from=', async ({ page }) => {
  // The clipboard, kept for the test.
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { w.copied.push(t); } }, configurable: true });
  });
  await signIn(page);
  await page.goto('/settings/booking-page');
  const card = page.locator('.od-set-card', { has: page.getByRole('heading', { name: 'Your links' }) });
  await expect(card.getByText('Use a different link in each place, and Money shows which ones bring new clients.')).toBeVisible();
  const host = new URL(origin(page)).host;
  await expect(card.locator('.od-link-place')).toHaveText(
    ['Instagram bio', 'Facebook', 'Google Business Profile', 'WhatsApp Business', 'Printed cards and posters']);
  await expect(card.locator('.od-link-url')).toHaveText(
    ['instagram', 'facebook', 'google', 'whatsapp', 'card'].map((from) => `${host}/book?from=${from}`));
  await shot(page, 'g06-your-links', card);

  await card.getByRole('button', { name: 'Copy your Instagram bio link' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Link copied' })).toBeVisible();
  await card.getByRole('button', { name: 'Copy your Printed cards and posters link' }).click();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied))
    .toEqual([`${origin(page)}/book?from=instagram`, `${origin(page)}/book?from=card`]);

  // Her own address, once it's saved in Business details.
  await editDemo(page, (db) => { db.settings.public_site_url = 'https://book.example.com'; });
  await page.reload();
  await card.getByRole('button', { name: 'Copy your WhatsApp Business link' }).click();
  expect((await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).pop()).toBe('https://book.example.com/book?from=whatsapp');
});

test('with her review link saved, finishing today’s visit offers the review ask, and the record says when she asked', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/booking-page');
  const field = page.getByLabel('Your Google review link');
  await expect(page.getByText('In Google Maps, open your Business Profile, tap Ask for reviews (or Get more reviews), then copy the link. It usually starts https://g.page/r/')).toBeVisible();
  const save = page.getByRole('button', { name: 'Save', exact: true });
  // Not https: not saved.
  await field.fill('http://g.page/r/DemoStudio123/review');
  await save.click();
  await expect(page.getByRole('alert')).toHaveText('Check your Google review link: it should start with https:// and have no spaces.');
  // Not one of Google's: a soft warning, and it still saves.
  await field.fill('https://example.com/review');
  await expect(page.getByText('That isn’t a Google address. Check it’s the link from your Business Profile: it still saves.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Test it' })).toHaveAttribute('href', 'https://example.com/review');
  // Hers.
  await field.fill(`  ${REVIEW_LINK} `);
  await expect(page.getByText('That isn’t a Google address.')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Test it' })).toHaveAttribute('href', REVIEW_LINK);
  await shot(page, 'g07-review-link', page.locator('.od-set-card', { has: page.getByRole('heading', { name: 'Google reviews' }) }));
  await save.click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect((await demo(page)).settings.review_link).toBe(REVIEW_LINK);

  // Grace's visit at 13:00 today: after Mark as done, under the next visit.
  const grace = await booking(page, 'Grace Patel', TODAY, '13:00');
  const sheet = await finish(page, grace, 'Grace Patel');
  const ask = sheet.getByRole('region', { name: 'Ask Grace for a Google review' });
  await expect(ask).toContainText('Ask if it’s OK to send your link, then tap.');
  const send = ask.getByRole('link', { name: 'Send on WhatsApp' });
  const href = (await send.getAttribute('href'))!;
  expect(href).toMatch(/^https:\/\/wa\.me\/447700900102\?text=/);
  expect(href).toContain(encodeURIComponent(REVIEW_LINK));
  expect(await waText(send)).toBe(
    `Hi Grace, thank you so much for coming in! 💅\n\nIf you have a minute, a quick Google review would really help me:\n${REVIEW_LINK}\n\nDemo Nail Studio`);
  await shot(page, 'g08-next-visit-review-ask');
  const popup = page.waitForEvent('popup');
  await send.click();
  await (await popup).close();
  await expect(sheet.locator('.od-review-asked')).toContainText('Asked for a review on 4 Nov');
  await shot(page, 'g09-review-asked', sheet.locator('.od-review-asked'));
  const asked = (await client(page, 'Grace Patel')).review_asked_at;
  expect(asked && Math.abs(new Date(asked).getTime() - NOW.getTime())).toBeLessThan(60e3);

  // Behind the sheet, on the finished appointment, it says the same.
  await sheet.getByRole('button', { name: 'Not now' }).click();
  await expect(page.locator('.od-review-card')).toContainText('Asked for a review on 4 Nov');
  await shot(page, 'g09b-review-card-asked', page.locator('.od-review-card'));
  // Ask again brings the button back.
  await page.locator('.od-review-card').getByRole('button', { name: 'Ask again' }).click();
  await expect(page.getByRole('region', { name: 'Ask Grace for a Google review' }).getByRole('link', { name: 'Send on WhatsApp' })).toBeVisible();

  // Her client record says so too.
  await page.goto(`/clients/${grace.client_id}`);
  await expect(page.locator('.od-facts')).toContainText('Asked for a review on 4 Nov');
});

test('with no review link saved, it says where to add one; with no mobile, Copy message', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await signIn(page);
  const isla = await booking(page, 'Isla Morgan', TODAY, '10:00');
  const sheet = await finish(page, isla, 'Isla Morgan');
  const hint = sheet.locator('.od-review-none');
  await expect(hint).toHaveText('To ask clients for a Google review here, add your review link in Settings → Booking page.');
  await expect(sheet.getByRole('region', { name: /Google review/ })).toHaveCount(0);
  await shot(page, 'g10-next-visit-no-review-link');
  await hint.getByRole('link', { name: 'Settings → Booking page' }).click();
  await expect(page.getByRole('heading', { name: 'Booking page' })).toBeVisible();

  // A finished visit for a client with no mobile saved, once there's a link.
  await editDemo(page, (db) => {
    db.settings.review_link = REVIEW_LINK;
    db.clients.find((c) => c.full_name === 'Isla Morgan')!.phone_e164 = null;
  });
  await page.goto(`/appointments/${isla.id}`);
  const ask = page.getByRole('region', { name: 'Ask Isla for a Google review' });
  await expect(ask.getByRole('link', { name: 'Send on WhatsApp' })).toHaveCount(0);
  await shot(page, 'g10b-review-card-copy', ask);
  await ask.getByRole('button', { name: 'Copy message' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Message copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`review would really help me:\n${REVIEW_LINK}\n`);
  await expect(page.locator('.od-review-card')).toContainText('Asked for a review on 4 Nov');
});

test('a finished visit from another day has nothing to send: it says when she asked, or to ask at their next visit', async ({ page }) => {
  await signIn(page);
  await editDemo(page, (db) => { db.settings.review_link = REVIEW_LINK; });
  // Amelia's infill two days ago, marked as done then: she isn't there to ask if it's OK.
  const amelia = await booking(page, 'Amelia Hart', '2026-11-02', '12:00');
  await page.goto(`/appointments/${amelia.id}`);
  await expect(page.getByRole('heading', { name: 'Amelia Hart' })).toBeVisible();
  const card = page.locator('.od-review-card');
  await expect(card).toHaveText('Not asked for a Google review yet: you can ask at their next visit');
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Send on WhatsApp' })).toHaveCount(0);
  await shot(page, 'g10c-review-card-another-day', card);
  // Asked on the day: when, and no Ask again.
  await editDemo(page, (db) => { db.clients.find((c) => c.full_name === 'Amelia Hart')!.review_asked_at = iso('2026-11-02', '13:00'); });
  await page.reload();
  await expect(card).toHaveText('Asked for a review on 2 Nov');
  await expect(card.getByRole('button')).toHaveCount(0);
  // With no review link saved, nothing about reviews there at all.
  await editDemo(page, (db) => { db.settings.review_link = null; });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Amelia Hart' })).toBeVisible();
  await expect(page.locator('.od-review-card, .od-review-none')).toHaveCount(0);
});

test('the short-notice list: who said yes, one WhatsApp each ending with how to stop them', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Share free times' }).click();
  const sheet = page.getByRole('dialog', { name: 'Share free times' });
  const message = (await sheet.locator('.od-share-msg').textContent())!;
  expect(message).toContain(`Book here: ${origin(page)}/book?treatment=biab-infill&from=free-times`);
  const list = sheet.getByRole('region', { name: 'Your short-notice list (1)' });
  await expect(list.locator('.od-sn-row')).toHaveText([/^Sophie TurnerSince 4 Nov · Ticked on the booking page/]);
  const wa = list.getByRole('link', { name: 'WhatsApp Sophie Turner' });
  expect(await wa.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/447700900103\?text=/);
  const text = await waText(wa);
  expect(text).toBe(`${message}\n\nDemo Nail Studio\n${STOP_LINE}`);
  expect(text.endsWith(STOP_LINE)).toBe(true);
  await shot(page, 'g11-short-notice-list', list);
  const popup = page.waitForEvent('popup');
  await wa.click();
  await (await popup).close();
  await expect(list.locator('.od-sn-row')).toContainText('WhatsApp opened');
  // One at a time: never a button for everyone.
  await expect(sheet.getByRole('button', { name: /all/i })).toHaveCount(0);

  // On her record: yes, from the booking page. She replied STOP, so it's switched off.
  const sophie = await client(page, 'Sophie Turner');
  await page.goto(`/clients/${sophie.id}`);
  const offers = page.getByRole('checkbox', { name: /Short-notice spaces and offers/ });
  await expect(offers).toBeChecked();
  await expect(page.locator('.od-offers')).toContainText('Yes, since 4 Nov (ticked on the booking page)');
  await expect(page.locator('.od-offers')).toContainText('If they reply STOP, switch this off.');
  await shot(page, 'g12-client-short-notice', page.locator('.od-offers'));
  await offers.uncheck();
  await expect(page.getByRole('status').filter({ hasText: 'Taken off your short-notice list' })).toBeVisible();
  // Her yes isn't wiped: the record says when she stopped, and the yes it replaces.
  const stopped = 'Stopped 4 Nov 2026 (yes from 4 Nov 2026, ticked on the booking page)';
  await expect(page.locator('.od-offers')).toContainText(stopped);
  await expect(page.locator('.od-offers')).toContainText('Tick this if they say yes in person.');
  await expect(offers).not.toBeChecked();
  expect(await client(page, 'Sophie Turner')).toMatchObject({ marketing_ok_at: null, marketing_ok_note: stopped });
  await shot(page, 'g12b-client-stopped', page.locator('.od-offers'));

  // Nobody on the list now.
  await page.goto('/');
  await page.getByRole('button', { name: 'Share free times' }).click();
  const empty = sheet.getByRole('region', { name: 'Your short-notice list (0)' });
  await expect(empty).toContainText('Nobody yet. Clients can tick the box when they book, or you can record a yes on their client record.');
  await expect(empty.getByRole('link')).toHaveCount(0);

  // Grace said yes in person.
  await page.goto(`/clients/${(await client(page, 'Grace Patel')).id}`);
  await page.getByRole('checkbox', { name: /Short-notice spaces and offers/ }).check();
  await expect(page.getByRole('status').filter({ hasText: 'Added to your short-notice list' })).toBeVisible();
  await expect(page.locator('.od-offers')).toContainText('Yes, since 4 Nov (said yes in person)');
  await page.goto('/');
  await page.getByRole('button', { name: 'Share free times' }).click();
  await expect(sheet.getByRole('region', { name: 'Your short-notice list (1)' }).locator('.od-sn-row'))
    .toHaveText([/^Grace PatelSince 4 Nov · Said yes in person/]);

  // Ruby, with no mobile saved, says yes: noted, but she's only on the list once her mobile is added.
  await editDemo(page, (db) => {
    const ruby = db.clients.find((c) => c.full_name === 'Ruby Clarke')! as DemoClient & { phone: string | null };
    ruby.phone = null;
    ruby.phone_e164 = null;
  });
  await page.goto(`/clients/${(await client(page, 'Ruby Clarke')).id}`);
  await page.getByRole('checkbox', { name: /Short-notice spaces and offers/ }).check();
  await expect(page.getByRole('status').filter({ hasText: 'Saved. They’ll be on your short-notice list once you add their mobile' }))
    .toBeVisible();
  await expect(page.locator('.od-offers')).toContainText('Yes, since 4 Nov (said yes in person)');
  await expect(page.locator('.od-offers')).toContainText('Add their mobile (Edit) to put them on your short-notice list.');
  await page.goto('/');
  await page.getByRole('button', { name: 'Share free times' }).click();
  await expect(sheet.getByRole('region', { name: 'Your short-notice list (1)' }).locator('.od-sn-row')).toHaveText([/^Grace Patel/]);
});

test('while the business name is still the default, Today and Business details say so; any other name, nothing', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText(/Add your business name/)).toHaveCount(0);
  await page.goto('/settings/business');
  await expect(page.locator('.od-name-note')).toHaveCount(0);

  // A new install's name, and no booking link saved: both go to Business details.
  await editDemo(page, (db) => { db.settings.business_name = 'My Nail Studio'; db.settings.public_site_url = null; });
  await page.goto('/');
  const setup = page.locator('.td-setup .list-row');
  await expect(setup).toHaveText(['Add your business name: your booking page still says My Nail Studio', 'Save your booking link']);
  await shot(page, 'g13-today-default-name', page.locator('.td-setup'));
  await setup.first().click();
  await expect(page.getByRole('heading', { name: 'Business details' })).toBeVisible();
  const note = page.locator('.od-name-note');
  await expect(note).toHaveText('Your booking page still says My Nail Studio. Put your own business name here.');
  await shot(page, 'g14-business-default-name', page.locator('.od-set-card').first());
  // Any capitals or spacing of it count too, as they do for the page head.
  await page.getByLabel('Business name').fill('my nail  studio');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(note).toBeVisible();
  await page.getByLabel('Business name').fill('Nails by Jess');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(note).toHaveCount(0);
  // Google and link previews only change once the app is next built: she's told who to ask.
  await expect(page.locator('.od-renamed-note')).toHaveText('Your booking page shows the new name now. Google and link previews show it '
    + 'after the next app update: ask whoever set up the app to redeploy it.');
  await shot(page, 'g14b-business-renamed', page.locator('.od-set-card').first());
  await page.goto('/');
  await expect(setup).toHaveText(['Save your booking link']);
  // Saving again without changing the name says nothing more.
  await page.goto('/settings/business');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  await expect(page.locator('.od-renamed-note')).toHaveCount(0);
});

test('the review request is her own wording when she changes it, and back to the default when she resets it', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/messages');
  const box = page.getByLabel('Review request');
  await expect(box).toHaveValue(/a quick Google review would really help me:\n\{review_link\}/);
  await expect(page.getByText('Ask every client the same way, and only send it once they’ve agreed to get the link. Never offer anything '
    + 'for a review, and don’t only ask the clients you think loved it: Google’s rules forbid both.')).toBeVisible();
  await shot(page, 'g15-review-request-wording', page.locator('.od-template').last());
  // Without the link in it: a warning.
  await box.fill('Hi {first_name}, thank you! {business}');
  await expect(page.getByText('This wording has no {review_link} in it, so it won’t send your link.')).toBeVisible();
  await box.fill('Hi {first_name}, thanks for coming in! A review would mean a lot: {review_link}\n{business}');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect((await demo(page)).settings).toMatchObject({ wa_template_review: 'Hi {first_name}, thanks for coming in! A review would mean a lot: {review_link}\n{business}' });

  // Used for the ask.
  await editDemo(page, (db) => { db.settings.review_link = REVIEW_LINK; });
  const grace = await booking(page, 'Grace Patel', TODAY, '13:00');
  const sheet = await finish(page, grace, 'Grace Patel');
  expect(await waText(sheet.getByRole('link', { name: 'Send on WhatsApp' })))
    .toBe(`Hi Grace, thanks for coming in! A review would mean a lot: ${REVIEW_LINK}\nDemo Nail Studio`);

  // Reset to the default: saved as none, so a better default reaches her later.
  await page.goto('/settings/messages');
  await page.locator('.od-template').last().getByRole('button', { name: 'Reset to default' }).click();
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
  expect((await demo(page)).settings).toMatchObject({ wa_template_review: null });
});
