import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { answerFromLink, bookingExtras, needsContact } from '../../src/pages/public/Book';
import { ContactButtons, contactLinks, friendLink, NoTimeSuits, ShareWithFriend } from '../../src/components/public/parts';
import { extrasToSend } from '../../src/lib/source';

// The public pages' side of where clients come from: what goes with a booking, the "Message me"
// links instead of dead ends, and Share with a friend. The pages themselves are tested in
// tests/e2e/where-from.spec.ts. vi.mock runs before the imports, so no API is set up.
vi.mock('../../src/api', () => ({ api: {} }));

const DEMO = { instagram: 'demo.nails', facebook: 'demonails', email: 'owner@example.com' };
const IG = 'https://ig.me/m/demo.nails';
const FB = 'https://m.me/demonails';
const MAIL = 'mailto:owner@example.com?subject=Booking%20enquiry';
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const text = (markup: string) => markup.replace(/<[^>]+>/g, '').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');

describe('answerFromLink: the answer picked to begin with', () => {
  it('A friend from a friend’s share, Saw a card or poster from her card', () => {
    expect(answerFromLink('friend')).toBe('friend');
    expect(answerFromLink('card')).toBe('card');
  });
  it('nothing for any other link, or none: the link itself is kept anyway', () => {
    for (const s of ['instagram', 'facebook', 'google', 'free-times', 'summer-fair', null]) expect(answerFromLink(s)).toBeNull();
  });
});

describe('bookingExtras: the optional answers sent with a booking', () => {
  const base = { source: null, firstVisit: true, heard: null, detail: '', offersOk: false } as const;

  it('a first-timer from her card, recommended by Sam, who ticked the box', () => {
    const extras = bookingExtras({ ...base, source: 'card', heard: 'friend', detail: '  Sam ', offersOk: true });
    expect(extras).toEqual({ link_source: 'card', heard_from: 'friend', heard_from_detail: 'Sam', first_visit: true, marketing_ok: true });
    expect(extrasToSend(extras)).toEqual(extras);
  });

  it('a returning client is never asked, so no answer goes, even one picked from the link', () => {
    const extras = bookingExtras({ ...base, source: 'friend', firstVisit: false, heard: 'friend', detail: 'Sam' });
    expect(extras).toMatchObject({ link_source: 'friend', heard_from: null, heard_from_detail: null, first_visit: false });
    // "I’ve been before" is an answer too; the unticked box isn't.
    expect(extrasToSend(extras)).toEqual({ link_source: 'friend', first_visit: false });
  });

  it('the few words go only with A friend or Other, and blank ones not at all', () => {
    expect(bookingExtras({ ...base, heard: 'instagram', detail: 'Sam' })).toMatchObject({ heard_from: 'instagram', heard_from_detail: null });
    expect(bookingExtras({ ...base, heard: 'other', detail: 'Wedding fair' })).toMatchObject({ heard_from: 'other', heard_from_detail: 'Wedding fair' });
    expect(bookingExtras({ ...base, heard: 'friend', detail: '   ' })).toMatchObject({ heard_from: 'friend', heard_from_detail: null });
    // Skipped: nothing about it goes.
    expect(extrasToSend(bookingExtras({ ...base, detail: 'Sam' }))).toEqual({ first_visit: true });
  });

  it('the short-notice box counts only when ticked', () => {
    expect(bookingExtras(base).marketing_ok).toBe(false);
    expect(extrasToSend(bookingExtras(base))).not.toHaveProperty('marketing_ok');
    expect(extrasToSend(bookingExtras({ ...base, firstVisit: false, offersOk: true }))).toEqual({ first_visit: false, marketing_ok: true });
  });
});

describe('needsContact: a booking that didn’t go through, best sorted out by getting in touch', () => {
  it('busy, failed, too many bookings, or booking paused since the page opened', () => {
    for (const code of ['busy_try_later', 'booking_failed', 'too_many_bookings', 'booking_disabled']) {
      expect(needsContact(new Error(code))).toBe(true);
      expect(needsContact({ message: code })).toBe(true);
    }
  });
  it('not when the page has its own next step (no signal, the time gone) or it’s theirs to fix', () => {
    for (const code of ['booking_no_reply', 'TypeError: Load failed', 'slot_taken', 'too_soon', 'invalid_email', 'policy_required',
      'consent_required', 'Please tell us whether this is your first visit.']) {
      expect(needsContact(new Error(code))).toBe(false);
    }
    expect(needsContact(null)).toBe(false);
    expect(needsContact(undefined)).toBe(false);
  });
});

describe('the “Message me” links', () => {
  it('Instagram, Facebook, then email, from her handles and address', () => {
    expect(contactLinks(DEMO)).toEqual([
      { kind: 'instagram', href: IG, label: 'Message me on Instagram' },
      { kind: 'facebook', href: FB, label: 'Message me on Facebook' },
      { kind: 'email', href: MAIL, label: 'Email' },
    ]);
  });

  it('leaves out what isn’t set, or isn’t valid, and never has a phone number', () => {
    expect(contactLinks({})).toEqual([]);
    expect(contactLinks({ instagram: ' ', facebook: null, email: '' })).toEqual([]);
    expect(contactLinks({ instagram: '@demo nails', email: 'owner@example.com' }).map((l) => l.kind)).toEqual(['email']);
    expect(JSON.stringify(contactLinks(DEMO))).not.toMatch(/tel:|wa\.me/);
  });

  it('ContactButtons: a button for each, opening in a new tab, or nothing at all', () => {
    const markup = html(createElement(ContactButtons, DEMO));
    const links = [...markup.matchAll(/<a ([^>]+)>/g)].map((m) => m[1]);
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noreferrer"');
    }
    expect(links.map((a) => /href="([^"]+)"/.exec(a)![1].replace(/&amp;/g, '&'))).toEqual([IG, FB, MAIL]);
    expect(text(markup)).toBe('Message me on InstagramMessage me on FacebookEmail');
    expect(html(createElement(ContactButtons, {}))).toBe('');
  });

  it('under the free times: the first way there is, in a sentence', () => {
    const line = (ways: Parameters<typeof NoTimeSuits>[0]) => html(createElement(NoTimeSuits, ways));
    expect(text(line(DEMO))).toBe('Can’t see a time that suits? Message me on Instagram');
    expect(line(DEMO)).toContain(`href="${IG}"`);
    expect(text(line({ facebook: 'demonails', email: 'owner@example.com' }))).toBe('Can’t see a time that suits? Message me on Facebook');
    expect(text(line({ email: 'owner@example.com' }))).toBe('Can’t see a time that suits? Email me');
    expect(line({})).toBe('');
  });
});

describe('Share with a friend', () => {
  it('shares her booking link with ?from=friend, so she can see who came that way', () => {
    expect(friendLink('https://book.example.com')).toBe('https://book.example.com/book?from=friend');
    expect(friendLink('https://book.example.com/')).toBe('https://book.example.com/book?from=friend');
  });

  it('is one button, with a place to say the link was copied', () => {
    const markup = html(createElement(ShareWithFriend, { business: 'Demo Nail Studio' }));
    expect(markup).toMatch(/<button type="button" class="btn block pub-share-btn">Share with a friend<svg/);
    expect(markup).toContain('<p class="pub-share-note" role="status"></p>');
  });
});

describe('where the visit came from', () => {
  // A fresh copy of the page for each, as if just opened (it keeps what it read until the page reloads).
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  /** A stand-in for the browser, recording anything kept on the phone. */
  function browser(search: string, referrer = '') {
    const kept: string[] = [];
    const storage = { getItem: () => null, setItem: (k: string) => { kept.push(`storage ${k}`); }, removeItem: () => {} };
    const location = { search };
    const doc = { referrer, get cookie() { return ''; }, set cookie(v: string) { kept.push(`cookie ${v}`); } };
    vi.stubGlobal('window', { location, localStorage: storage, sessionStorage: storage });
    vi.stubGlobal('document', doc);
    vi.stubGlobal('localStorage', storage);
    vi.stubGlobal('sessionStorage', storage);
    return { location, kept };
  }

  it('is read once, when the booking page first opens, and still known after the privacy notice', async () => {
    const b = browser('?from=card');
    const { sourceOfVisit } = await import('../../src/pages/public/Book');
    expect(sourceOfVisit()).toBe('card');
    // To the privacy notice and back, inside the app: the address no longer has ?from=.
    b.location.search = '';
    expect(sourceOfVisit()).toBe('card');
    // Nothing kept on the phone (PECR): no storage and no cookie.
    expect(b.kept).toEqual([]);
  });

  it('or from the site that sent them', async () => {
    browser('', 'https://l.instagram.com/?u=https%3A%2F%2Fbook.example.com%2Fbook');
    const { sourceOfVisit } = await import('../../src/pages/public/Book');
    expect(sourceOfVisit()).toBe('instagram');
  });

  it('and nothing when there’s no telling', async () => {
    browser('?treatment=biab-infill', 'https://example.com/');
    const { sourceOfVisit } = await import('../../src/pages/public/Book');
    expect(sourceOfVisit()).toBeNull();
  });
});
