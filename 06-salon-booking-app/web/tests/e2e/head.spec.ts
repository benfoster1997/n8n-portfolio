import { expect, test } from '@playwright/test';
import sharp from 'sharp';

// What Google and link previews (WhatsApp, Instagram, Facebook, iMessage) read: the page as it comes
// from the server, before any script runs. The tests build the demo with VITE_SITE_URL set to the
// test server (playwright.config.ts), so the head has its canonical link and picture, and the
// generic words: the demo never asks a database.

test('the booking page’s own HTML has one title, a canonical link and the preview picture', async ({ request, baseURL }) => {
  const res = await request.get('/book');
  expect(res.ok()).toBe(true);
  const html = await res.text();
  // A shared link with ?from= on the end gets the same page.
  expect(await (await request.get('/book?from=card')).text()).toBe(html);
  expect(html.match(/<title[\s>]/g)).toHaveLength(1);
  expect(html).toContain('<title>Book an appointment</title>');
  expect(html).toContain('<meta name="description" content="See free times and book your appointment online." />');
  expect(html.match(/<link rel="canonical"/g)).toHaveLength(1);
  expect(html).toContain(`<link rel="canonical" href="${baseURL}/book" />`);
  expect(html).toContain(`<meta property="og:url" content="${baseURL}/book" />`);
  expect(html).not.toContain('%VITE_');
  expect(html).not.toContain('booking-head');
  // The home-screen tags are still there.
  expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Bookings" />');

  const image = /<meta property="og:image" content="([^"]+)" \/>/.exec(html)?.[1];
  expect(image).toMatch(/\/og\/booking-card\.jpg$/);
  const picture = await request.get(image!);
  expect(picture.status()).toBe(200);
  expect(picture.headers()['content-type']).toBe('image/jpeg');
  const bytes = await picture.body();
  expect(bytes.length).toBeLessThan(300 * 1024);
  const { format, width, height } = await sharp(bytes).metadata();
  expect({ format, width, height }).toEqual({ format: 'jpeg', width: 1200, height: 630 });
});

test('once the booking page has loaded, its tab says the same, and never the default business name', async ({ page }) => {
  await page.goto('/book');
  await expect(page.getByRole('button', { name: /Gel polish — hands/ })).toBeVisible();
  await expect(page).toHaveTitle('Demo Nail Studio · Book online');
  // A new install's name counts as unset here too, as it does in the built-in head.
  await page.evaluate((key) => {
    const db = JSON.parse(localStorage.getItem(key)!);
    db.settings.business_name = 'My Nail Studio';
    localStorage.setItem(key, JSON.stringify(db));
  }, 'salon-demo-v4');
  await page.reload();
  await expect(page.getByRole('button', { name: /Gel polish — hands/ })).toBeVisible();
  await expect(page).toHaveTitle('Book an appointment');
});

test('the privacy notice and the consultation form have tab titles of their own', async ({ page }) => {
  await page.goto('/privacy');
  await expect(page.getByRole('heading', { name: 'Privacy notice' })).toBeVisible();
  await expect(page).toHaveTitle('Privacy notice · Demo Nail Studio');
  const token = await page.evaluate((key) => (JSON.parse(localStorage.getItem(key)!).appointments as { status: string; public_token: string }[])
    .find((a) => a.status === 'confirmed')!.public_token, 'salon-demo-v4');
  await page.goto(`/form/${token}`);
  await expect(page.getByText('Consultation form').first()).toBeVisible();
  await expect(page).toHaveTitle('Consultation form · Demo Nail Studio');
  // A broken link still says what it was for.
  await page.goto('/form/not-a-link');
  await expect(page.getByRole('heading', { name: 'Consultation form' })).toBeVisible();
  await expect(page).toHaveTitle('Consultation form');
});

test('robots.txt lets Google load the booking page’s scripts and picture, and keeps the rest out', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(res.ok()).toBe(true);
  const robots = await res.text();
  for (const rule of ['Allow: /book', 'Allow: /assets/', 'Allow: /icons/', 'Allow: /og/', 'Disallow: /']) expect(robots).toContain(rule);
});

test('the owner’s own app is called Bookings, not the booking page’s title', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  await expect(page).toHaveTitle('Bookings');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Today', exact: true })).toBeVisible();
  await expect(page).toHaveTitle('Bookings');
  await page.getByRole('link', { name: 'Clients' }).click();
  await expect(page).toHaveTitle('Bookings');
});
