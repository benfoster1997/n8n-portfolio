import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';
import schema from '../../../supabase/schema.sql?raw';
import {
  clientSearchLink, firstFoundYou, foundYouPatch, foundYouThrough, friendName, isDefaultBusinessName, lastMonthText, linkWord,
  newClientsText, OWN_LINKS, ownLink, reviewAskedText, SAID_YES_IN_PERSON, shortDate, shortNoticeLine, siteBase, stoppedNote, upperFirst,
  type FoundYou,
} from '../../src/lib/growth';
import { cleanLinkSource, LINK_FROM, linkLabel, summariseNewClients } from '../../src/lib/source';
import { bookingTitle, FALLBACK_TITLE } from '../../src/lib/head';
import { treatmentLink } from '../../src/lib/freeTimes';
import { NeedsUpdateError } from '../../src/api/api';
import { FoundYouFields, ReviewAsk } from '../../src/components/appts';
import { NewClientsView } from '../../src/pages/admin/Money';
import { saveSettings } from '../../src/pages/admin/Settings';
import type { Appointment, NewClientBooking, Settings } from '../../src/lib/types';

// The owner's side of where clients come from, Google reviews and short-notice spaces: the pure
// helpers in lib/growth, and the pieces of her screens that can be drawn without the live or demo
// API behind them (vi.mock runs before the imports).
vi.mock('../../src/api', async () => {
  const real = await import('../../src/api/api');
  return { api: {}, supabaseUrl: '', supabaseKey: '', NeedsUpdateError: real.NeedsUpdateError, isNeedsUpdate: real.isNeedsUpdate };
});

const TZ = 'Europe/London';
const NOW = new Date('2026-11-09T12:00:00Z');
/** Text with the non-breaking spaces (that keep a line from starting with "·") as plain ones. */
const plain = (t: string | null) => t?.replace(/ /g, ' ') ?? null;
/** Markup's text, with one space between blocks (a link inside a sentence stays part of it). */
const textOf = (html: string) => html.replace(/<\/(p|div|li|h2|h3|button|section)>/g, ' ').replace(/<[^>]+>/g, '')
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const draw = (el: ReactElement) => renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, el));

describe('her links: one for each place she puts it', () => {
  it('Instagram bio, Facebook, Google Business Profile, WhatsApp Business and printed cards, each with its own ?from=', () => {
    expect(OWN_LINKS.map((l) => [l.place, l.from])).toEqual([
      ['Instagram bio', 'instagram'], ['Facebook', 'facebook'], ['Google Business Profile', 'google'],
      ['WhatsApp Business', 'whatsapp'], ['Printed cards and posters', 'card'],
    ]);
    // Kept by the booking page just as they are, and each worded for her in words, not as typed.
    for (const { from } of OWN_LINKS) {
      expect(cleanLinkSource(from)).toBe(from);
      expect(linkLabel(from)).not.toBe(from);
    }
    expect(linkLabel('whatsapp')).toBe('your WhatsApp link');
  });

  it('start from the address saved in Business details, else the one the app is open on', () => {
    expect(siteBase('https://book.example.com/', 'http://localhost:4173')).toBe('https://book.example.com');
    expect(siteBase(null, 'http://localhost:4173')).toBe('http://localhost:4173');
    expect(siteBase('   ', 'http://localhost:4173')).toBe('http://localhost:4173');
    expect(ownLink('https://book.example.com/', 'card')).toBe('https://book.example.com/book?from=card');
    expect(ownLink(siteBase(null, 'http://localhost:4173'), LINK_FROM.instagram)).toBe('http://localhost:4173/book?from=instagram');
  });

  it('Share free times links say they came from a free-times post', () => {
    const services = [{ id: 'id-infill', name: 'BIAB infill' }, { id: 'id-gel', name: 'Gel polish — hands' }];
    expect(treatmentLink('https://book.example.com/book', services[0], services, LINK_FROM.freeTimes))
      .toBe('https://book.example.com/book?treatment=biab-infill&from=free-times');
    expect(treatmentLink('https://book.example.com/book', services[1], services)).toBe('https://book.example.com/book?treatment=gel-polish-hands');
  });
});

describe('noting how a client found her, on an appointment', () => {
  it('keeps the words only with A friend or Other, on one line', () => {
    expect(foundYouPatch({ heard_from: 'friend', detail: '  Sam \n  Jones ' })).toEqual({ heard_from: 'friend', heard_from_detail: 'Sam Jones' });
    expect(foundYouPatch({ heard_from: 'other', detail: 'A wedding fair' })).toEqual({ heard_from: 'other', heard_from_detail: 'A wedding fair' });
    expect(foundYouPatch({ heard_from: 'instagram', detail: 'Sam' })).toEqual({ heard_from: 'instagram', heard_from_detail: null });
    expect(foundYouPatch({ heard_from: 'friend', detail: '   ' })).toEqual({ heard_from: 'friend', heard_from_detail: null });
  });

  it('Not known clears it, and nothing but the six answers is kept', () => {
    expect(foundYouPatch({ heard_from: null, detail: 'Sam' })).toEqual({ heard_from: null, heard_from_detail: null });
    expect(foundYouPatch({ heard_from: 'tiktok' as never, detail: '' })).toEqual({ heard_from: null, heard_from_detail: null });
  });

  it('up to 60 characters, as the database allows, counting an emoji as one', () => {
    expect(foundYouPatch({ heard_from: 'other', detail: 'x'.repeat(80) }).heard_from_detail).toBe('x'.repeat(60));
    expect(foundYouPatch({ heard_from: 'other', detail: '💅'.repeat(70) }).heard_from_detail).toBe('💅'.repeat(60));
    expect(schema).toMatch(/heard_from_detail\s+text check \(length\(heard_from_detail\) <= 60\)/);
  });
});

describe('how a client found her, on their record', () => {
  let n = 0;
  const appt = (created_at: string, over: Partial<FoundYou> = {}) =>
    ({ id: `a${++n}`, created_at, heard_from: null, heard_from_detail: null, link_source: null, ...over });

  it('their first answer counts, even when an earlier booking only had a link', () => {
    expect(firstFoundYou([
      appt('2026-11-20T10:00:00.000Z', { heard_from: 'instagram' }),
      appt('2026-11-02T10:00:00.000Z', { link_source: 'card' }),
      appt('2026-11-05T10:00:00.000Z', { heard_from: 'friend', heard_from_detail: ' Sam ', link_source: 'friend' }),
    ])).toEqual({ heard_from: 'friend', heard_from_detail: 'Sam', link_source: null });
  });

  it('with no answer, the first link; with neither, nothing', () => {
    expect(firstFoundYou([appt('2026-11-03T10:00:00.000Z', { link_source: 'google' }), appt('2026-11-01T10:00:00.000Z', { link_source: 'card' })]))
      .toEqual({ heard_from: null, heard_from_detail: null, link_source: 'card' });
    expect(firstFoundYou([appt('2026-11-01T10:00:00.000Z')])).toBeNull();
    expect(firstFoundYou([])).toBeNull();
    // Words kept with another answer by mistake don't come along.
    expect(firstFoundYou([appt('2026-11-01T10:00:00.000Z', { heard_from: 'card', heard_from_detail: 'x' })]))
      .toEqual({ heard_from: 'card', heard_from_detail: null, link_source: null });
  });

  it('reads as the end of “Found you …”', () => {
    const f = (over: Partial<FoundYou>) => foundYouThrough({ heard_from: null, heard_from_detail: null, link_source: null, ...over });
    expect(f({ heard_from: 'instagram' })).toBe('through Instagram');
    expect(f({ heard_from: 'facebook' })).toBe('through Facebook');
    expect(f({ heard_from: 'google' })).toBe('through Google');
    expect(f({ heard_from: 'friend' })).toBe('through a friend');
    expect(f({ heard_from: 'friend', heard_from_detail: 'Sam' })).toBe('through a friend: Sam');
    expect(f({ heard_from: 'card', heard_from_detail: 'ignored' })).toBe('through a card or poster');
    expect(f({ heard_from: 'other' })).toBe('another way');
    expect(f({ heard_from: 'other', heard_from_detail: 'a wedding fair' })).toBe('through a wedding fair');
    // Her answer before the link.
    expect(f({ heard_from: 'google', link_source: 'card' })).toBe('through Google');
    expect(f({ link_source: 'instagram' })).toBe('through your Instagram link');
    expect(f({ link_source: 'card' })).toBe('through your printed card');
    expect(f({ link_source: 'whatsapp' })).toBe('through your WhatsApp link');
    expect(f({ link_source: 'summer-fair' })).toBe('through summer-fair');
    expect(f({})).toBeNull();
  });

  it('a friend’s name opens Clients, searching for it', () => {
    expect(friendName({ heard_from: 'friend', heard_from_detail: ' Sam ' })).toBe('Sam');
    expect(friendName({ heard_from: 'friend', heard_from_detail: null })).toBeNull();
    expect(friendName({ heard_from: 'other', heard_from_detail: 'Sam' })).toBeNull();
    expect(clientSearchLink(' Sam Jones ')).toBe('/clients?q=Sam%20Jones');
    expect(upperFirst('your Instagram link')).toBe('Your Instagram link');
    expect(upperFirst('')).toBe('');
  });
});

describe('Money → New clients, in words', () => {
  let n = 0;
  const row = (client_id: string, over: Partial<NewClientBooking> = {}): NewClientBooking => ({
    id: `b${++n}`, client_id, status: 'confirmed', created_at: `2026-11-0${(n % 9) + 1}T10:00:00.000Z`, link_source: null,
    heard_from: null, heard_from_detail: null, full_name: client_id, ...over,
  });

  it('who booked and came, their answers with friends’ names, and the links they used: plain numbers, most first', () => {
    const s = summariseNewClients([
      row('kim', { heard_from: 'instagram', link_source: 'card', status: 'completed' }),
      row('lou', { heard_from: 'instagram', link_source: 'free-times', status: 'completed' }),
      row('mia', { heard_from: 'friend', heard_from_detail: 'Sam', link_source: 'free-times', status: 'completed' }),
      row('zoe', { heard_from: 'friend', heard_from_detail: 'Amy' }),
      row('eve', { heard_from: 'google' }),
    ]);
    const t = newClientsText(s, 'November', true);
    expect(plain(t.headline)).toBe('November: 5 new clients booked · 3 came.');
    expect(plain(t.answers)).toBe('Instagram 2 · A friend 2 (Sam, Amy) · Google 1.');
    expect(plain(t.links)).toBe('Links used: free times 2, card 1.');
    // A line breaks only after a "·", and a number stays with its name.
    expect(t.headline).toBe('November: 5 new clients booked · 3 came.');
    expect(t.answers).toContain('Instagram 2 · A friend 2 (Sam, Amy)');
  });

  it('those who didn’t say are counted, so the answers add up to the number booked', () => {
    const t = newClientsText(summariseNewClients([row('kim', { heard_from: 'instagram' }), row('lou', { link_source: 'instagram' })]), 'November');
    expect(plain(t.headline)).toBe('November: 2 new clients booked · 0 came.');
    expect(plain(t.answers)).toBe('Instagram 1 · Didn’t say 1.');
    expect(plain(t.links)).toBe('Links used: Instagram 1.');
  });

  it('when nobody said, it says so in words', () => {
    expect(newClientsText(summariseNewClients([row('kim')]), 'November')).toEqual(
      { headline: 'November: 1 new client booked · 0 came.', answers: 'They didn’t say how they found you.', links: null });
    expect(newClientsText(summariseNewClients([row('kim'), row('lou')]), 'November').answers).toBe('None of them said how they found you.');
  });

  it('a month with nobody new, and the month before to compare', () => {
    expect(newClientsText(summariseNewClients([]), 'November', true)).toEqual({ headline: 'November: no new clients booked yet.', answers: null, links: null });
    expect(newClientsText(summariseNewClients([]), 'October').headline).toBe('October: no new clients booked.');
    expect(lastMonthText({ booked: 4 }, 'October')).toBe('October: 4 new clients booked.');
    expect(lastMonthText({ booked: 1 }, 'October')).toBe('October: 1 new client booked.');
    expect(lastMonthText({ booked: 0 }, 'October')).toBe('October: no new clients booked.');
  });

  it('each link by a short name; one she made up as she typed it', () => {
    const words = ['instagram', 'facebook', 'google', 'whatsapp', 'card', 'free-times', 'friend', 'summer-fair'].map((slug) => linkWord(linkLabel(slug)));
    expect(words).toEqual(['Instagram', 'Facebook', 'Google', 'WhatsApp', 'card', 'free times', 'shared by clients', 'summer-fair']);
  });
});

describe('the short lines on her screens', () => {
  it('dates: "3 Nov", with the year when it isn’t this one, in her time zone', () => {
    expect(shortDate('2026-11-03T10:00:00.000Z', TZ, NOW)).toBe('3 Nov');
    expect(shortDate('2025-11-03T10:00:00.000Z', TZ, NOW)).toBe('3 Nov 2025');
    // 23:30 on 3 July in UTC is already the 4th in British Summer Time.
    expect(shortDate('2026-07-03T23:30:00.000Z', TZ, NOW)).toBe('4 Jul');
    expect(reviewAskedText('2026-11-03T10:00:00.000Z', TZ, NOW)).toBe('Asked for a review on 3 Nov');
  });

  it('short-notice spaces and offers: since when, and how they said yes', () => {
    const at = '2026-11-04T03:00:00.000Z';
    expect(shortNoticeLine({ marketing_ok_at: at, marketing_ok_note: 'Ticked on the booking page' }, TZ, NOW))
      .toBe('Yes, since 4 Nov (ticked on the booking page)');
    expect(shortNoticeLine({ marketing_ok_at: at, marketing_ok_note: SAID_YES_IN_PERSON }, TZ, NOW)).toBe('Yes, since 4 Nov (said yes in person)');
    expect(shortNoticeLine({ marketing_ok_at: at, marketing_ok_note: null }, TZ, NOW)).toBe('Yes, since 4 Nov');
    // No yes recorded: just No (everyone booking online sees the box, so "not asked" wouldn't be right).
    expect(shortNoticeLine({ marketing_ok_at: null, marketing_ok_note: null }, TZ, NOW)).toBe('No');
    // Her note fits the database's.
    const max = Number(schema.match(/marketing_ok_note\s+text check \(length\(marketing_ok_note\) <= (\d+)\)/)![1]);
    expect(SAID_YES_IN_PERSON.length).toBeLessThanOrEqual(max);
  });

  it('taken off the list: a note of when, and of the yes it replaces, with the years, that the line then shows', () => {
    const max = Number(schema.match(/marketing_ok_note\s+text check \(length\(marketing_ok_note\) <= (\d+)\)/)![1]);
    const yes = { marketing_ok_at: '2026-11-04T03:00:00.000Z', marketing_ok_note: 'Ticked on the booking page' };
    const note = stoppedNote(yes, TZ, NOW);
    expect(note).toBe('Stopped 9 Nov 2026 (yes from 4 Nov 2026, ticked on the booking page)');
    expect(shortNoticeLine({ marketing_ok_at: null, marketing_ok_note: note }, TZ, NOW)).toBe(note);
    expect(stoppedNote({ marketing_ok_at: '2025-12-31T23:30:00.000Z', marketing_ok_note: SAID_YES_IN_PERSON }, TZ, NOW))
      .toBe('Stopped 9 Nov 2026 (yes from 31 Dec 2025, said yes in person)');
    expect(stoppedNote({ marketing_ok_at: yes.marketing_ok_at, marketing_ok_note: null }, TZ, NOW)).toBe('Stopped 9 Nov 2026 (yes from 4 Nov 2026)');
    // A long note of her own is left out rather than make it too long for the database; the dates always fit.
    const long = stoppedNote({ marketing_ok_at: yes.marketing_ok_at, marketing_ok_note: 'x'.repeat(max) }, TZ, NOW);
    expect(long).toBe('Stopped 9 Nov 2026 (yes from 4 Nov 2026)');
    for (const n of [note, long]) expect(n.length).toBeLessThanOrEqual(max);
    // Any other note with no yes isn't shown as if it were one.
    expect(shortNoticeLine({ marketing_ok_at: null, marketing_ok_note: 'Ticked on the booking page' }, TZ, NOW)).toBe('No');
  });

  it('the business name a new install starts with, in any capitals or spacing, as the page head reads it', () => {
    for (const name of ['My Nail Studio', ' My Nail Studio ', 'my nail studio', 'MY NAIL STUDIO', 'My  Nail\nStudio']) {
      expect(isDefaultBusinessName(name)).toBe(true);
      // The same rule as the page head: whenever there's a reminder, Google and previews say "Book an appointment", and back.
      expect(bookingTitle(name)).toBe(FALLBACK_TITLE);
    }
    for (const name of ['Demo Nail Studio', 'My Nail Studio by Sam', 'Nails by Jess']) {
      expect(isDefaultBusinessName(name)).toBe(false);
      expect(bookingTitle(name)).not.toBe(FALLBACK_TITLE);
    }
    // Blank isn't "still says My Nail Studio" (and can't be saved).
    for (const name of ['', '   ', null, undefined]) expect(isDefaultBusinessName(name)).toBe(false);
  });
});

describe('saving settings before the database update has been run', () => {
  const current = { business_name: 'Demo Nail Studio', tagline: null, review_link: null, wa_template_review: null } as unknown as Settings;
  /** The live API before 2026-11-growth.sql: saving one of its new settings fails. */
  const beforeUpdate = (sent: Partial<Settings>[]) => async (patch: Partial<Settings>) => {
    sent.push(patch);
    if ('review_link' in patch || 'wa_template_review' in patch) throw new NeedsUpdateError();
    return { ...current, ...patch } as Settings;
  };

  it('saves everything else, and says which new setting wasn’t saved', async () => {
    const sent: Partial<Settings>[] = [];
    const r = await saveSettings(beforeUpdate(sent), { tagline: 'Happy hands', review_link: 'https://g.page/r/demo/review' }, current);
    expect(sent).toEqual([{ tagline: 'Happy hands', review_link: 'https://g.page/r/demo/review' }, { tagline: 'Happy hands' }]);
    expect(r).toEqual({ saved: { ...current, tagline: 'Happy hands' }, left: ['review_link'] });
  });

  it('a new setting that hasn’t changed isn’t sent at all, so the page saves as it always did', async () => {
    const sent: Partial<Settings>[] = [];
    const r = await saveSettings(beforeUpdate(sent), { tagline: 'Happy hands', review_link: null, wa_template_review: null }, current);
    expect(sent).toEqual([{ tagline: 'Happy hands' }]);
    expect(r.left).toEqual([]);
  });

  it('only a new setting changed: nothing else to save', async () => {
    const sent: Partial<Settings>[] = [];
    const r = await saveSettings(beforeUpdate(sent), { wa_template_review: 'Thanks {first_name}! {review_link}' }, current);
    expect(sent).toHaveLength(1);
    expect(r).toEqual({ saved: current, left: ['wa_template_review'] });
  });

  it('once it has been run, everything saves in one go; any other problem is as before', async () => {
    const sent: Partial<Settings>[] = [];
    const after = async (patch: Partial<Settings>) => { sent.push(patch); return { ...current, ...patch } as Settings; };
    const r = await saveSettings(after, { tagline: 'x', review_link: 'https://g.page/r/demo/review' }, current);
    expect(sent).toEqual([{ tagline: 'x', review_link: 'https://g.page/r/demo/review' }]);
    expect(r.left).toEqual([]);
    const offline = async () => { throw new Error('TypeError: Load failed'); };
    await expect(saveSettings(offline, { tagline: 'x', review_link: 'https://g.page/r/demo/review' }, current)).rejects.toThrow('Load failed');
  });
});

describe('Money → Month: the New clients card', () => {
  const view = (data: Parameters<typeof NewClientsView>[0]['data'], error: unknown = null, month = '2026-11') =>
    renderToStaticMarkup(createElement(NewClientsView, { month, today: '2026-11-09', tz: TZ, data, error }));

  it('this month in words, with last month’s total', () => {
    const html = view({
      month: '2026-11',
      now: summariseNewClients([{ client_id: 'kim', status: 'completed', created_at: '2026-11-02T10:00:00.000Z',
        link_source: 'card', heard_from: 'friend', heard_from_detail: 'Sam' }]),
      before: summariseNewClients([]),
    });
    expect(textOf(html)).toBe('New clients November: 1 new client booked · 1 came. A friend 1 (Sam). Links used: card 1. October: no new clients booked.');
    expect(html).not.toContain('role="alert"');
  });

  it('before the database update: one line saying who to ask, not an error', () => {
    const html = view(null, new NeedsUpdateError());
    expect(textOf(html)).toBe('New clients New clients will show here once the app’s database update has been run: '
      + 'ask whoever set up the app (see SETUP.md).');
    expect(html).not.toContain('role="alert"');
  });

  it('any other problem shows as one, and nothing shows while it loads', () => {
    expect(textOf(view(null, new Error('TypeError: Failed to fetch')))).toBe('New clients No signal: check your connection and try again.');
    expect(view(null, new Error('TypeError: Failed to fetch'))).toContain('role="alert"');
    expect(view(null)).toBe('');
  });
});

describe('asking for a Google review', () => {
  const settings = (over: Partial<Settings> = {}) => ({
    business_name: 'Demo Nail Studio', timezone: TZ, cancel_notice_hours: 48, client_self_service: true,
    public_site_url: 'https://book.example.com', deposit_amount_pence: 1000, wa_template_review: null,
    review_link: 'https://g.page/r/demo-studio/review', ...over,
  } as unknown as Settings);
  const appt = (phone: string | null = '447700900111') => ({
    client: { id: 'c1', full_name: 'Amy Example', email: null, phone: phone && '07700 900111', phone_e164: phone },
    booking_name: 'Amy Example', service_name: 'Gel polish', starts_at: '2026-11-09T10:00:00.000Z', price_pence: 2500,
    deposit_required_pence: 0, reference: 'K3Q7XP', public_token: 'tok', late_fee_pence: null, status: 'completed',
  } as unknown as Appointment);
  const ask = (s: Settings, askedAt: string | null | undefined, a = appt(), today = true) =>
    draw(createElement(ReviewAsk, { a, s, review: { askedAt, onAsk: () => {} }, today }));

  it('offers her review message on WhatsApp, with her link in it', () => {
    const html = ask(settings(), null);
    expect(textOf(html)).toBe('Ask Amy for a Google review Ask if it’s OK to send your link, then tap. Send on WhatsApp');
    const href = html.match(/href="([^"]+)"/)![1].replace(/&amp;/g, '&');
    expect(href.startsWith('https://wa.me/447700900111?text=')).toBe(true);
    expect(href).toContain(encodeURIComponent('https://g.page/r/demo-studio/review'));
    expect(decodeURIComponent(href.split('text=')[1])).toMatch(/^Hi Amy, thank you so much for coming in!/);
  });

  it('with no mobile saved, Copy message instead', () => {
    const html = ask(settings(), null, appt(null));
    expect(textOf(html)).toContain('Copy message');
    expect(html).not.toContain('wa.me');
  });

  it('once asked, when, with Ask again; nothing while that’s still loading', () => {
    expect(textOf(ask(settings(), '2026-11-03T12:00:00.000Z'))).toMatch(/^Asked for a review on 3 Nov( 20\d\d)? ?Ask again$/);
    expect(ask(settings(), undefined)).toBe('');
  });

  it('with no review link saved, one line saying where to add it', () => {
    const html = ask(settings({ review_link: null }), null);
    expect(textOf(html)).toBe('To ask clients for a Google review here, add your review link in Settings → Booking page.');
    expect(html).toContain('href="/settings/booking-page"');
  });

  it('for a visit from another day, nothing to send: when she asked, or to ask at their next visit', () => {
    const past = ask(settings(), null, appt(), false);
    expect(textOf(past)).toBe('Not asked for a Google review yet: you can ask at their next visit');
    expect(past).not.toMatch(/wa\.me|<button/);
    const asked = ask(settings(), '2026-11-03T12:00:00.000Z', appt(), false);
    expect(textOf(asked)).toMatch(/^Asked for a review on 3 Nov( 20\d\d)?$/);
    expect(asked).not.toContain('Ask again');
    // No link saved: nothing to say there.
    expect(ask(settings({ review_link: null }), null, appt(), false)).toBe('');
    expect(ask(settings(), undefined, appt(), false)).toBe('');
  });
});

describe('“How did they find you?”', () => {
  const fields = (heard_from: Parameters<typeof FoundYouFields>[0]['value']['heard_from']) =>
    draw(createElement(FoundYouFields, { value: { heard_from, detail: '' }, onChange: () => {} }));

  it('the six answers, or Not known', () => {
    const options = [...fields(null).matchAll(/<option value="([^"]*)"[^>]*>([^<]+)<\/option>/g)].map((m) => [m[1], m[2]]);
    expect(options).toEqual([['', 'Not known'], ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['google', 'Google'],
      ['friend', 'A friend'], ['card', 'Saw a card or poster'], ['other', 'Other']]);
  });

  it('asks who recommended them with A friend, a few words with Other, and nothing more with the rest', () => {
    expect(fields('friend')).toContain('Who recommended them? (optional)');
    expect(fields('other')).toContain('A few words (optional)');
    expect(fields('instagram')).not.toContain('<input');
    expect(fields('friend')).toContain('maxLength="60"');
  });
});
