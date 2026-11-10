import { expect, test, type Page } from '@playwright/test';

// The public pages' side of where clients come from: the link they came through and "How did you
// hear about me?" sent with the booking, the short-notice box, the email typo hint, "Message me"
// wherever the page can't book them in, and Share with a friend. Each test gets a fresh browser,
// so the demo starts from its seeded data, with owner@example.com and no social handles (any that
// looked real could be a stranger's): the tests that need handles give her demo.nails (Instagram)
// and demonails (Facebook) with withHandles(), and never open them. The owner's screens are tested elsewhere.
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoAppt {
  id: string; client_id: string; booking_name: string; status: string; public_token: string; created_at: string;
  link_source: string | null; heard_from: string | null; heard_from_detail: string | null; first_visit_said: boolean | null;
}
interface DemoStore {
  appointments: DemoAppt[];
  clients: { id: string; full_name: string; marketing_ok_at: string | null; marketing_ok_note: string | null }[];
  settings: { booking_enabled: boolean; instagram_handle: string | null; facebook_handle: string | null; owner_email: string | null };
  time_off: { id: string; starts_at: string; ends_at: string; note: string | null }[];
}
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/** Change the demo data; pages read it when they open, so reload or navigate afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}
/** The same, as if from another phone while this page is open: it picks the change up straight away. */
async function meanwhile(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => {
    localStorage.setItem(key, json);
    window.dispatchEvent(new StorageEvent('storage', { key }));
  }, [KEY, JSON.stringify(db)]);
}
/** Any page seeds the demo. */
async function seed(page: Page) {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
}
const origin = (page: Page) => new URL(page.url()).origin;

/** From the treatments to the details step, for the first free Gel polish. */
async function pickTime(page: Page) {
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Your details' })).toBeVisible();
}
async function toDetails(page: Page, url = '/book') {
  await page.goto(url);
  await pickTime(page);
}
async function yourDetails(page: Page, name: string, email: string, mobile: string) {
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mobile').fill(mobile);
}
/** The health questions, both consent ticks and the signature, as a first-timer. */
async function healthCheck(page: Page, name: string) {
  for (const group of await page.locator('.card .seg').all()) await group.getByRole('radio', { name: 'No' }).click();
  await page.getByLabel(/My answers are true/).check();
  await page.getByLabel(/I explicitly consent/).check();
  await page.getByLabel('Type your full name to sign').fill(name);
}
async function confirm(page: Page) {
  await page.getByLabel(/16 or over/).check();
  await page.getByLabel(/agree to the cancellation policy/).check();
  await page.getByRole('button', { name: 'Confirm booking' }).click();
}
/** Ruby, a regular, books the first free Gel polish, up to Booking received. */
async function bookAsRuby(page: Page) {
  await toDetails(page);
  await yourDetails(page, 'Ruby Clarke', 'ruby@example.com', '07700 900106');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();
}
/** Their newest booking in the demo, and their client record. */
async function newest(page: Page, name: string) {
  const db = await demo(page);
  const appt = db.appointments.filter((a) => a.booking_name === name).sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return { appt, client: db.clients.find((c) => c.id === appt.client_id)! };
}
const heardGroup = (page: Page) => page.getByRole('group', { name: 'How did you hear about me? (optional)' });
const offers = (page: Page) => page.getByLabel(/WhatsApp me about short-notice spaces and offers/);
const shareButton = (page: Page) => page.getByRole('button', { name: 'Share with a friend' });

/** A phone with a share sheet: keep what it's given. */
const withShareSheet = (page: Page) => page.addInitScript(() => {
  const w = window as unknown as { shared: unknown[] };
  w.shared = [];
  Object.defineProperty(navigator, 'share', { value: async (data: unknown) => { w.shared.push(data); }, configurable: true });
});
const shared = (page: Page) => page.evaluate(() => (window as unknown as { shared: unknown[] }).shared);

const IG = 'https://ig.me/m/demo.nails';
const FB = 'https://m.me/demonails';
const MAIL = 'mailto:owner@example.com?subject=Booking%20enquiry';
const HANDLES = { instagram_handle: 'demo.nails', facebook_handle: 'demonails' };
/** Her Instagram and Facebook handles, for the tests of the Message me buttons (the demo has none). */
async function withHandles(page: Page) {
  await seed(page);
  await editDemo(page, (db) => { Object.assign(db.settings, HANDLES); });
}

test('from her printed card, a first-timer says a friend sent them and asks about short-notice spaces', async ({ page }) => {
  await toDetails(page, '/book?from=card');
  await yourDetails(page, 'Amy Example', 'amy@example.com', '07700 900555');
  // Only asked once they say it's their first visit.
  await expect(heardGroup(page)).toHaveCount(0);
  await page.getByRole('radio', { name: 'Yes, first time' }).click();
  const group = heardGroup(page);
  await expect(group.getByRole('button')).toHaveText(['Instagram', 'Facebook', 'Google', 'A friend', 'Saw a card or poster', 'Other']);
  // Toggle buttons, one pressed at most: radios would never clear, and this answer can be taken away.
  await expect(group.getByRole('radio')).toHaveCount(0);
  // Her card's link picks its answer to begin with.
  await expect(group.getByRole('button', { pressed: true })).toHaveText(['Saw a card or poster']);

  // A friend, and who; tapping it again clears it, and the name is still there if they pick it again.
  const friend = group.getByRole('button', { name: 'A friend' });
  await friend.click();
  await expect(group.getByRole('button', { pressed: true })).toHaveText(['A friend']);
  const who = group.getByLabel('Who recommended you? (optional, first name is fine)');
  await expect(who).toHaveAttribute('maxlength', '60');
  await expect(who).toHaveAttribute('autocomplete', 'off');
  await who.fill('Sam');
  await friend.click();
  await expect(group.getByRole('button', { pressed: true })).toHaveCount(0);
  await expect(who).toHaveCount(0);
  await friend.click();
  await expect(who).toHaveValue('Sam');
  // Other asks where, instead.
  await group.getByRole('button', { name: 'Other' }).click();
  await expect(group.getByLabel('Where? (optional)')).toBeVisible();
  await expect(who).toHaveCount(0);
  await friend.click();
  await expect(who).toHaveValue('Sam');

  // The short-notice box: marked optional, in their words, saying how the messages come and how to stop them.
  // It starts unticked; they tick it.
  await expect(page.locator('.pub-offers')).toHaveText(
    'Optional: WhatsApp me about short-notice spaces and offers. I can reply STOP any time.');
  await expect(offers(page)).not.toBeChecked();
  await offers(page).check();
  await healthCheck(page, 'Amy Example');
  await shot(page, 'wf01-first-timer');
  await confirm(page);
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();

  // What the demo kept, as the database would.
  const { appt, client } = await newest(page, 'Amy Example');
  expect(appt).toMatchObject({ link_source: 'card', heard_from: 'friend', heard_from_detail: 'Sam', first_visit_said: true });
  expect(client.marketing_ok_at).toBeTruthy();
  expect(client.marketing_ok_note).toBe('Ticked on the booking page');
});

test('a returning client is never asked how they found me, and the box stays unticked unless they tick it', async ({ page }) => {
  await toDetails(page, '/book?from=friend');
  await yourDetails(page, 'Amelia Hart', 'amelia@example.com', '07700 900101');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await expect(heardGroup(page)).toHaveCount(0);
  await expect(page.getByText('How did you hear about me?')).toHaveCount(0);
  // A change of mind and back: from a friend's share, A friend is picked to begin with, then it's gone again.
  await page.getByRole('radio', { name: 'Yes, first time' }).click();
  await expect(heardGroup(page).getByRole('button', { pressed: true })).toHaveText(['A friend']);
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await expect(heardGroup(page)).toHaveCount(0);
  await expect(offers(page)).not.toBeChecked();
  await confirm(page);
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();

  const { appt, client } = await newest(page, 'Amelia Hart');
  expect(appt).toMatchObject({ link_source: 'friend', heard_from: null, heard_from_detail: null, first_visit_said: false });
  expect(client.marketing_ok_at).toBeNull();
});

test('where they came from is kept after a look at the privacy notice, and nothing about it is stored on their phone', async ({ page }) => {
  await page.goto('/book?from=instagram');
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  await page.locator('.slot').first().click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // To the privacy notice and back, inside the app: the address has no ?from= any more.
  await page.getByRole('link', { name: 'privacy notice' }).click();
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to booking' }).click();
  await expect(page).toHaveURL(/\/book$/);
  await pickTime(page);
  await yourDetails(page, 'Ruby Clarke', 'ruby@example.com', '07700 900106');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();
  expect((await newest(page, 'Ruby Clarke')).appt.link_source).toBe('instagram');
  // No cookies and no storage of its own (PECR): only the demo's invented data is in this browser.
  expect(await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage), document.cookie]))
    .toEqual([[KEY], [], '']);
});

test('the site that sent them counts when the link has no ?from=', async ({ page }) => {
  // Instagram's link wrapper sends the visit on; its address is all that comes with it.
  await page.goto('/book', { referer: 'http://l.instagram.com/' });
  expect(await page.evaluate(() => document.referrer)).toMatch(/^http:\/\/l\.instagram\.com\//);
  await pickTime(page);
  await yourDetails(page, 'Ruby Clarke', 'ruby@example.com', '07700 900106');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await confirm(page);
  await expect(page.getByRole('heading', { name: /Booking received/ })).toBeVisible();
  expect((await newest(page, 'Ruby Clarke')).appt.link_source).toBe('instagram');
});

test('an email address that looks mistyped gets a suggestion, and only Use this changes it', async ({ page }) => {
  await toDetails(page);
  const email = page.getByLabel('Email');
  const hint = page.locator('.pub-email-hint');
  await email.fill('sam@gmial.com');
  // Nothing while they type: it's worked out when they leave the field.
  await expect(hint).toHaveCount(0);
  await page.getByLabel('Mobile').click();
  await expect(hint.locator('span')).toHaveText('Did you mean sam@gmail.com?');
  await expect(hint.locator('b')).toHaveText('sam@gmail.com');
  await expect(email).toHaveValue('sam@gmial.com');
  await shot(page, 'wf02-email-hint');
  await hint.getByRole('button', { name: 'Use this' }).click();
  await expect(email).toHaveValue('sam@gmail.com');
  await expect(hint).toHaveCount(0);

  // A right address gets nothing.
  await email.click();
  await page.getByLabel('Mobile').click();
  await expect(hint).toHaveCount(0);
  // Typing again takes the suggestion away until they leave the field, and it's never applied by itself.
  await email.fill('jess@hotmial.co.uk');
  await page.getByLabel('Full name').click();
  await expect(hint.locator('span')).toHaveText('Did you mean jess@hotmail.co.uk?');
  await email.fill('jess@hotmial.co.u');
  await expect(hint).toHaveCount(0);
  await expect(email).toHaveValue('jess@hotmial.co.u');
});

test('booking paused: Message me on Instagram or Facebook, or Email, from her own handles', async ({ page }) => {
  await withHandles(page);
  await editDemo(page, (db) => { db.settings.booking_enabled = false; });
  await page.goto('/book');
  await expect(page.getByText('Online booking is paused')).toBeVisible();
  const ig = page.getByRole('link', { name: 'Message me on Instagram' });
  const fb = page.getByRole('link', { name: 'Message me on Facebook' });
  const mail = page.getByRole('link', { name: 'Email', exact: true });
  await expect(ig).toHaveAttribute('href', IG);
  await expect(fb).toHaveAttribute('href', FB);
  await expect(mail).toHaveAttribute('href', MAIL);
  for (const link of [ig, fb, mail]) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noreferrer');
  }
  // Never a phone number on the booking page.
  await expect(page.locator('a[href^="tel:"], a[href*="wa.me"]')).toHaveCount(0);
  await shot(page, 'wf03-paused');

  // With no handles and no email, no buttons: the page still says to get in touch.
  await editDemo(page, (db) => { Object.assign(db.settings, { instagram_handle: null, facebook_handle: null, owner_email: null }); });
  await page.reload();
  await expect(page.getByText('Online booking is paused')).toBeVisible();
  await expect(page.locator('.pub-contact')).toHaveCount(0);
});

test('under the free times, a line says how to ask for another; with none free, the notice has the buttons', async ({ page }) => {
  await withHandles(page);
  await page.goto('/book');
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  const line = page.locator('.pub-suits');
  await expect(line).toHaveText('Can’t see a time that suits? Message me on Instagram');
  await expect(line.getByRole('link')).toHaveAttribute('href', IG);
  await expect(line.getByRole('link')).toHaveAttribute('target', '_blank');

  // Only an email address set: the line offers that.
  await editDemo(page, (db) => { Object.assign(db.settings, { instagram_handle: null, facebook_handle: null }); });
  await page.reload();
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  await expect(line).toHaveText('Can’t see a time that suits? Email me');
  await expect(line.getByRole('link')).toHaveAttribute('href', MAIL);

  // Nothing free in the next 60 days: the notice has the buttons, and there's no line.
  await editDemo(page, (db) => {
    Object.assign(db.settings, HANDLES);
    db.time_off.push({ id: 'away', starts_at: new Date(Date.now() - 86400e3).toISOString(),
      ends_at: new Date(Date.now() + 70 * 86400e3).toISOString(), note: 'Away' });
  });
  await page.reload();
  await page.getByRole('button', { name: /Gel polish — hands/ }).click();
  const notice = page.locator('.notice', { hasText: 'there are no free times' });
  await expect(notice).toContainText('Sorry — there are no free times in the next 60 days. Please get in touch directly.');
  await expect(notice.getByRole('link')).toHaveText(['Message me on Instagram', 'Message me on Facebook', 'Email']);
  expect(await notice.getByRole('link').evaluateAll((links) => links.map((a) => a.getAttribute('href')))).toEqual([IG, FB, MAIL]);
  await expect(line).toHaveCount(0);
  await shot(page, 'wf04-no-free-times');
});

test('a booking that can’t go through offers the Message me buttons; with no signal it says to check first instead', async ({ page, context }) => {
  await withHandles(page);
  await toDetails(page);
  await yourDetails(page, 'Ruby Clarke', 'ruby@example.com', '07700 900106');
  await page.getByRole('radio', { name: 'I’ve been before' }).click();
  await page.getByLabel(/16 or over/).check();
  await page.getByLabel(/agree to the cancellation policy/).check();
  const confirmButton = page.getByRole('button', { name: 'Confirm booking' });
  const buttons = page.locator('.pub-contact');

  // No signal as they confirm: it may have gone through, so no buttons, just check your email first.
  await context.setOffline(true);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);
  await confirmButton.click();
  await expect(page.getByRole('alert')).toContainText('No signal: we couldn’t tell whether your booking went through.');
  await expect(buttons).toHaveCount(0);
  await context.setOffline(false);
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(true);

  // She paused online booking while they were filling it in.
  await meanwhile(page, (db) => { db.settings.booking_enabled = false; });
  await confirmButton.click();
  await expect(page.getByRole('alert')).toHaveText('Online booking is paused at the moment. Please get in touch directly.');
  await expect(buttons.getByRole('link')).toHaveText(['Message me on Instagram', 'Message me on Facebook', 'Email']);
  await shot(page, 'wf05-cant-book');

  // A booking the page itself refuses (what a bot filling the hidden field gets): the same.
  await meanwhile(page, (db) => { db.settings.booking_enabled = true; });
  await page.locator('.visually-hidden input').fill('https://spam.example.com', { force: true });
  await confirmButton.click();
  await expect(page.getByRole('alert')).toContainText('Sorry, that booking couldn’t be made.');
  await expect(buttons.getByRole('link')).toHaveCount(3);
  expect((await demo(page)).appointments.filter((a) => a.booking_name === 'Ruby Clarke' && a.status !== 'completed')).toHaveLength(1);
});

test('Share with a friend opens the share sheet with just her name and booking link', async ({ page }) => {
  await withShareSheet(page);
  await bookAsRuby(page);
  // Under the next steps, above Book another appointment.
  await expect(page.locator('.pub-next + .pub-share')).toHaveCount(1);
  await expect(page.locator('.pub-share + .btn')).toHaveText('Book another appointment');
  await shareButton(page).click();
  // No words written for them: just the title and the link.
  await expect.poll(() => shared(page)).toEqual([{ title: 'Demo Nail Studio', url: `${origin(page)}/book?from=friend` }]);
  await expect(page.getByText('Link copied')).toHaveCount(0);
});

test('without a share sheet, Share with a friend copies the link and says so', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { copied: string[] };
    w.copied = [];
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (t: string) => { w.copied.push(t); } }, configurable: true });
  });
  await bookAsRuby(page);
  await shareButton(page).click();
  await expect(page.getByRole('status').filter({ hasText: 'Link copied' })).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { copied: string[] }).copied)).toEqual([`${origin(page)}/book?from=friend`]);
  await shot(page, 'wf06-link-copied');
});

test('with no share sheet and copying refused, as in some apps’ own browsers, the link is shown to copy, with Send on WhatsApp', async ({ page }) => {
  // Instagram's browser, say: no share sheet, the clipboard refuses, and a pop-up box would never show.
  await page.addInitScript(() => {
    const w = window as unknown as { prompted: number };
    w.prompted = 0;
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => { throw new DOMException('Write permission denied.', 'NotAllowedError'); } }, configurable: true,
    });
    window.prompt = () => { w.prompted += 1; return null; };
  });
  await bookAsRuby(page);
  await shareButton(page).click();
  const link = `${origin(page)}/book?from=friend`;
  const box = page.getByLabel('Press and hold the link to copy it');
  await expect(box).toHaveValue(link);
  await expect(box).toHaveAttribute('readonly', '');
  // Picked out, ready to copy.
  await expect(box).toBeFocused();
  expect(await box.evaluate((el: HTMLInputElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, link.length]);
  const wa = page.getByRole('link', { name: 'Send on WhatsApp' });
  await expect(wa).toHaveAttribute('href', `https://wa.me/?text=${encodeURIComponent(link)}`);
  await expect(wa).toHaveAttribute('target', '_blank');
  await expect(page.getByText('Link copied')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { prompted: number }).prompted)).toBe(0);
  // Nothing sideways to scroll, however long the address.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await shot(page, 'wf06b-share-by-hand');
});

test('a client’s own booking page offers Share with a friend under the ticket, unless it was cancelled', async ({ page }) => {
  await withShareSheet(page);
  await seed(page);
  const ruby = (await demo(page)).appointments.find((a) => a.booking_name === 'Ruby Clarke' && a.status === 'confirmed')!;
  await page.goto(`/manage/${ruby.public_token}`);
  await expect(page.getByText('Hi Ruby, here’s your booking')).toBeVisible();
  await expect(page.locator('.appt-card + .pub-share')).toHaveCount(1);
  await shareButton(page).click();
  await expect.poll(() => shared(page)).toEqual([{ title: 'Demo Nail Studio', url: `${origin(page)}/book?from=friend` }]);
  await shot(page, 'wf07-manage-share');

  // Been: still offered, while the page is there to see.
  await editDemo(page, (db) => { db.appointments.find((a) => a.id === ruby.id)!.status = 'completed'; });
  await page.reload();
  await expect(page.locator('.chip', { hasText: 'Completed' })).toBeVisible();
  await expect(shareButton(page)).toBeVisible();

  // Cancelled: not offered.
  const isla = (await demo(page)).appointments.find((a) => a.booking_name === 'Isla Morgan' && a.status === 'cancelled')!;
  await page.goto(`/manage/${isla.public_token}`);
  await expect(page.getByText('This appointment has been cancelled.')).toBeVisible();
  await expect(shareButton(page)).toHaveCount(0);
});

test('the privacy notice says how finding me, short-notice messages and review requests work', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.locator('.privacy-for')).toHaveText('Demo Nail Studio');
  const what = page.getByRole('region', { name: 'What is kept, why, and on what basis' });
  const item = (title: string) => what.locator('li', { has: page.locator('b', { hasText: title }) });
  await expect(item('How you found Demo Nail Studio')).toContainText('if you choose to tell me when you book');
  // Only the answer is optional: the link or site they came from is kept with every online booking.
  await expect(item('How you found Demo Nail Studio')).toContainText('Telling me is optional. Which of my links or which website '
    + 'brought you to the booking page is noted automatically.');
  await expect(item('How you found Demo Nail Studio')).toContainText('Basis: legitimate interests.');
  await expect(item('Short-notice spaces and offers')).toContainText('only if you tick the box when you book, or tell me you’d like them');
  // The way they're sent, as the box says.
  await expect(item('Short-notice spaces and offers')).toContainText('I may WhatsApp you about short-notice spaces or offers.');
  await expect(item('Short-notice spaces and offers')).toContainText('Reply STOP, or tell me, any time and I’ll stop.');
  await expect(item('Short-notice spaces and offers')).toContainText('Basis: consent.');
  // No promise of "one": she can ask again at a later visit.
  await expect(item('A review request')).toContainText('I may send you a message with a link to leave a Google review.');
  await expect(item('A review request')).not.toContainText('one WhatsApp');
  await expect(item('A review request')).toContainText('Nothing is offered for a review, and you’re free to ignore it.');
  // The promise stands: nothing used for marketing without asking first.
  await expect(page.getByText('Your information is never sold, or used for marketing without asking you first.')).toBeVisible();
});
