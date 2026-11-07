import { expect, test, type Locator, type Page } from '@playwright/test';
import { addDays, fmt, zonedToInstant } from '../../src/lib/time';

// The client's health information on the appointment, and who Today asks for a form.
// The clock is fixed at 17:00 on a Wednesday before the demo is seeded. In the demo:
// Grace Patel has allergies, a patch test (no reaction) and consent recorded from a paper
// form; Isla Morgan has a patch test but no form; Sophie Turner filled in the online form;
// Chloe, Ruby and Amelia have nothing on file.
const NOW = new Date('2026-11-04T17:00:00Z'); // Wednesday 4 November, 17:00 in London
const TODAY = '2026-11-04';
const short = (day: number) => fmt(zonedToInstant(addDays(TODAY, day), '12:00'), 'd MMM');
const ALLERGY = 'Sensitive to HEMA — use HEMA-free gel only.';
const KEY = 'salon-demo-v4';
const SHOTS = process.env.SHOTS_DIR;
async function shot(page: Page, name: string) {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

interface DemoAppt {
  id: string; booking_name: string; status: string; public_token: string; client_id: string;
  starts_at: string; ends_at: string; busy_until: string; reference: string;
}
interface DemoStore {
  appointments: DemoAppt[];
  clients: { id: string; full_name: string; email: string | null; health_consent_at: string | null; health_consent_note: string | null }[];
  patch_tests: { id: string; client_id: string; tested_on: string; product: string | null; result: string; notes: string | null }[];
  forms: { client_id: string; submitted_at: string }[];
}
const demo = (page: Page): Promise<DemoStore> => page.evaluate((key) => JSON.parse(localStorage.getItem(key)!), KEY);
/** Change the demo data; pages read it when they load, so navigate afterwards. */
async function editDemo(page: Page, edit: (db: DemoStore) => void) {
  const db = await demo(page);
  edit(db);
  await page.evaluate(([key, json]) => localStorage.setItem(key, json), [KEY, JSON.stringify(db)]);
}
async function bookingOf(page: Page, name: string, status = 'confirmed') {
  return (await demo(page)).appointments.find((a) => a.booking_name === name && a.status === status)!;
}

async function signIn(page: Page) {
  await page.clock.install({ time: NOW });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
}
const todays = (page: Page) => page.locator('.day-head:has-text("Today’s appointments") + .card');
const formCard = (page: Page) => page.locator('.card.attention', { hasText: 'No consultation form on file' });
const strip = (page: Page) => page.getByRole('region', { name: 'Health and allergies' });
/** A line of the strip: what follows "Patch test" or "Consultation form". */
const line = (s: Locator, label: string) => s.locator('dl > div', { has: s.page().locator('dt', { hasText: label }) }).locator('dd');

test('the appointment shows allergies, the latest patch test and the consultation form near the top', async ({ page }) => {
  await signIn(page);
  await todays(page).getByRole('link', { name: /Grace Patel/ }).click();
  await expect(page.getByRole('heading', { name: 'Grace Patel' })).toBeVisible();
  await expect(strip(page).locator('.od-hstrip-allergy')).toHaveText(`Allergies: ${ALLERGY}`);
  await expect(line(strip(page), 'Patch test')).toHaveText(`no reaction ${short(-40)}`);
  // Consent she recorded from a paper form counts as a form on file.
  await expect(line(strip(page), 'Consultation form')).toHaveText(`on file, ${short(-40)} (paper)`);
  await expect(page.getByRole('link', { name: 'Send form link' })).toHaveCount(0);
  // Straight under the date and price, before anything else.
  expect(await page.locator('.od-appt > .card').evaluateAll((cards) => cards.slice(0, 2).map((c) => c.className)))
    .toEqual([expect.stringContaining('od-hero'), expect.stringContaining('od-hstrip')]);
  await shot(page, 'h01-appointment-allergies');

  // Isla: a patch test, but no form or consent on file, so the form link is there to send.
  await page.goto('/');
  await todays(page).getByRole('link', { name: /Isla Morgan/ }).click();
  await expect(page.getByRole('heading', { name: 'Isla Morgan' })).toBeVisible();
  await expect(strip(page).locator('.od-hstrip-allergy')).toHaveCount(0);
  await expect(line(strip(page), 'Patch test')).toHaveText(`no reaction ${short(-50)}`);
  await expect(line(strip(page), 'Consultation form')).toHaveText('none on file');
  const isla = await bookingOf(page, 'Isla Morgan');
  const send = strip(page).getByRole('link', { name: 'Send form link' });
  expect(await send.getAttribute('href')).toMatch(/^https:\/\/wa\.me\/447700900104\?text=/);
  expect(decodeURIComponent((await send.getAttribute('href'))!.split('text=')[1])).toMatch(new RegExp(
    `^Hi Isla, before your appointment please fill in this quick consultation form \\(it takes 2 minutes\\): http://localhost:\\d+/form/${isla.public_token}\\nDemo Nail Studio$`));
  await expect(strip(page).getByRole('button', { name: 'Copy link' })).toBeVisible();
  // Only the one place to send it from.
  await expect(page.getByRole('link', { name: 'Send form link' })).toHaveCount(1);
  await shot(page, 'h02-appointment-no-form');

  // Sophie filled in the online form when she booked; no patch test yet.
  await page.goto(`/appointments/${(await bookingOf(page, 'Sophie Turner', 'pending_deposit')).id}`);
  await expect(line(strip(page), 'Patch test')).toHaveText('none on file');
  await expect(line(strip(page), 'Consultation form')).toHaveText(`on file, ${short(0)}`);
  await expect(page.getByText('form on file')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Send form link' })).toHaveCount(0);
});

test('Today lists anyone without a form or recorded consent, regulars too; recording consent takes them off', async ({ page }) => {
  await signIn(page);
  // Ruby and Amelia have had visits; Chloe is new to the app. Grace (paper consent) and Sophie (online form) aren't listed.
  // Nor is Isla: her visit this morning is over (it's under Not finished yet), and she has nothing else booked.
  await expect(formCard(page).locator('.td-attn-count')).toHaveText('3');
  await expect(formCard(page).locator('.appt-name')).toHaveText(['Chloe Bennett', 'Ruby Clarke', 'Amelia Hart']);
  await shot(page, 'h03-today-no-form');

  // She has Chloe's paper form: Record consent on her record.
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Chloe Bennett/ }).click();
  await page.getByRole('button', { name: 'Record consent' }).click();
  await page.getByRole('dialog', { name: 'Record consent' }).getByRole('button', { name: 'Record consent' }).click();
  await expect(page.getByText('Consent recorded')).toBeVisible();
  await page.locator('.section-title:has-text("Upcoming") + .card').getByRole('link').first().click();
  await expect(page.getByRole('heading', { name: 'Chloe Bennett' })).toBeVisible();
  await expect(line(strip(page), 'Consultation form')).toHaveText(`on file, ${short(0)} (paper)`);
  await expect(page.getByRole('link', { name: 'Send form link' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy link' })).toHaveCount(1); // only the change/cancel link's

  await page.getByRole('link', { name: 'Today', exact: true }).click();
  await expect(formCard(page).locator('.td-attn-count')).toHaveText('2');
  await expect(formCard(page).locator('.appt-name')).toHaveText(['Ruby Clarke', 'Amelia Hart']);
});

test('consent recorded from a WhatsApp message counts, but says it’s consent, not a form', async ({ page }) => {
  await signIn(page);
  // Jess, a new client, agreed by WhatsApp that her health information can be kept.
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Jess Collins/ }).click();
  await page.getByRole('button', { name: 'Record consent' }).click();
  const sheet = page.getByRole('dialog', { name: 'Record consent' });
  await sheet.getByLabel('How they gave it').selectOption('WhatsApp message');
  await sheet.getByRole('button', { name: 'Record consent' }).click();
  await expect(page.getByText('Consent recorded')).toBeVisible();
  await page.goto(`/appointments/${(await bookingOf(page, 'Jess Collins', 'pending_deposit')).id}`);
  await expect(page.getByRole('heading', { name: 'Jess Collins' })).toBeVisible();
  await expect(line(strip(page), 'Consultation form')).toHaveText(`consent recorded, ${short(0)} (by WhatsApp)`);
  await expect(line(page.locator('.od-hero'), 'Client')).toHaveText('New client · consent recorded');
  await expect(page.getByText('form on file')).toHaveCount(0);
  await shot(page, 'h06-consent-by-whatsapp');
});

test('a long list of clients without a form shows five, then the rest on request', async ({ page }) => {
  await signIn(page);
  // Three more regulars with nothing on file, booked in the next fortnight.
  await editDemo(page, (db) => {
    const ruby = db.appointments.find((a) => a.booking_name === 'Ruby Clarke' && a.status === 'confirmed')!;
    const template = db.clients.find((c) => c.full_name === 'Ruby Clarke')!;
    ['Poppy Lane', 'Mia Stone', 'Ella Wood'].forEach((name, i) => {
      const id = `extra-client-${i}`;
      db.clients.push({ ...template, id, full_name: name, email: null });
      const starts = zonedToInstant(addDays(TODAY, 9 + i), '10:00');
      const ends = new Date(starts.getTime() + 45 * 60e3).toISOString();
      db.appointments.push({ ...ruby, id: `extra-${i}`, client_id: id, booking_name: name, reference: `EXTRA${i}`,
        public_token: `00000000-0000-4000-8000-00000000001${i}`, starts_at: starts.toISOString(), ends_at: ends, busy_until: ends });
    });
  });
  await page.reload();
  await expect(formCard(page).locator('.td-attn-count')).toHaveText('6');
  await expect(formCard(page).locator('.appt-name')).toHaveCount(5);
  await formCard(page).getByRole('button', { name: 'Show 1 more' }).click();
  await expect(formCard(page).locator('.appt-name')).toHaveText(
    ['Chloe Bennett', 'Ruby Clarke', 'Amelia Hart', 'Poppy Lane', 'Mia Stone', 'Ella Wood']);
  await expect(formCard(page).getByRole('button', { name: /more/ })).toHaveCount(0);
});

test('patch tests as the app records them, and a form over a year old', async ({ page }) => {
  await signIn(page);
  const ruby = await bookingOf(page, 'Ruby Clarke');
  const rubyClient = (await demo(page)).clients.find((c) => c.full_name === 'Ruby Clarke')!;
  const patchTest = (tested_on: string, result: string) =>
    ({ id: `t-${tested_on}-${result}`, client_id: rubyClient.id, tested_on, product: 'Gel polish', result, notes: null });

  // Done yesterday, still waiting for the result.
  await editDemo(page, (db) => { db.patch_tests.push(patchTest(addDays(TODAY, -1), 'pending')); });
  await page.goto(`/appointments/${ruby.id}`);
  await expect(line(strip(page), 'Patch test')).toHaveText(`waiting since ${short(-1)}`);
  // Then a reaction, today.
  await editDemo(page, (db) => { db.patch_tests.push(patchTest(TODAY, 'reaction')); });
  await page.reload();
  await expect(line(strip(page), 'Patch test')).toHaveText(`reaction ${short(0)}`);
  await expect(line(strip(page), 'Patch test')).toHaveClass(/od-hs-danger/);

  // Sophie's form, as if it were from more than a year ago: worth a fresh one, from the same link.
  const sophie = await bookingOf(page, 'Sophie Turner', 'pending_deposit');
  const old = new Date(NOW.getTime() - 400 * 86400e3).toISOString();
  await editDemo(page, (db) => {
    const c = db.clients.find((x) => x.full_name === 'Sophie Turner')!;
    for (const f of db.forms) if (f.client_id === c.id) f.submitted_at = old;
    c.health_consent_at = old;
  });
  await page.goto(`/appointments/${sophie.id}`);
  await expect(line(strip(page), 'Consultation form')).toHaveText(`on file, ${fmt(old, 'd MMM yyyy')}`);
  await expect(strip(page)).toContainText('Form over a year old: send a fresh one.');
  expect(decodeURIComponent((await strip(page).getByRole('link', { name: 'Send form link' }).getAttribute('href'))!))
    .toContain(`/form/${sophie.public_token}`);
  await shot(page, 'h04-appointment-old-form');
});

test('Today and the diary show only a small Allergy tag, never the details', async ({ page }) => {
  await signIn(page);
  const grace = todays(page).getByRole('link', { name: /Grace Patel/ });
  await expect(grace.locator('.od-tag')).toHaveText('Allergy');
  await expect(todays(page).getByRole('link', { name: /Isla Morgan/ }).locator('.od-tag')).toHaveCount(0);
  await expect(page.getByText(/Sensitive to HEMA/)).toHaveCount(0);

  await page.getByRole('link', { name: 'Diary' }).click();
  await expect(page.locator('.dy-day').getByRole('link', { name: /Grace Patel/ }).locator('.od-tag')).toHaveText('Allergy');
  await expect(page.getByText(/Sensitive to HEMA/)).toHaveCount(0);
  await shot(page, 'h05-diary-allergy-tag');

  // Her client record shows them in full at the top, so her bookings there don't need the tag.
  await page.getByRole('link', { name: 'Clients' }).click();
  await page.getByRole('link', { name: /Grace Patel/ }).click();
  await expect(page.locator('.od-allergy-text')).toHaveText(ALLERGY);
  for (const tag of await page.locator('.appt-allergy').all()) await expect(tag).toBeHidden();
});
