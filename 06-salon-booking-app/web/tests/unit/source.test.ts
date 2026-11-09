import { describe, expect, it } from 'vitest';
import schema from '../../../supabase/schema.sql?raw';
import {
  cleanLinkSource, extrasToSend, foundYouLabel, HEARD_FROM, HEARD_FROM_LABEL, isHeardFrom, linkLabel, LINK_FROM, readSource,
  summariseNewClients, takesDetail, tidyExtras,
} from '../../src/lib/source';
import type { NewClientBooking } from '../../src/lib/types';

// Where clients come from: the link they booked through, their answer to "How did you hear
// about me?", and Money's New clients summary. The database's own rules are tested in
// tests/db/booking.test.mjs; tidyExtras() follows the same ones (for the demo).

describe('readSource: where a visit to the booking page came from', () => {
  const read = (search: string, referrer = '') => readSource({ search, referrer });

  it('takes ?from= first, tidied the way the database keeps it', () => {
    expect(read('?from=Instagram!!')).toBe('instagram');
    expect(read('?treatment=biab-infill&from=free-times')).toBe('free-times');
    expect(read('from=Card')).toBe('card');
    expect(read(`?from=${'x'.repeat(40)}`)).toBe('x'.repeat(30));
    expect(read('?from=Card&utm_source=ig', 'https://www.google.com/')).toBe('card');
  });

  it('then ?utm_source=, for Instagram and Facebook only', () => {
    for (const v of ['ig', 'IG', 'instagram', ' Instagram ']) expect(read(`?utm_source=${encodeURIComponent(v)}`)).toBe('instagram');
    for (const v of ['fb', 'facebook', 'Facebook']) expect(read(`?utm_source=${v}`)).toBe('facebook');
    expect(read('?utm_source=newsletter')).toBeNull();
    expect(read('?utm_source=constructor')).toBeNull();
    expect(read('?utm_source=fb', 'https://www.instagram.com/')).toBe('facebook');
    // A ?from= with nothing usable in it doesn't count.
    expect(read('?from=%F0%9F%92%85&utm_source=fb')).toBe('facebook');
    expect(read('?from=&utm_source=ig')).toBe('instagram');
  });

  it('then the site that sent them: Instagram, Facebook or Google', () => {
    for (const r of ['https://l.instagram.com/?u=https%3A%2F%2Fbook.example.com', 'https://www.instagram.com/', 'https://instagram.com/demo.nails']) {
      expect(read('', r)).toBe('instagram');
    }
    for (const r of ['https://facebook.com/', 'https://www.facebook.com/demonails', 'https://m.facebook.com/', 'https://l.facebook.com/l.php?u=x',
      'https://lm.facebook.com/l.php?u=x']) {
      expect(read('', r)).toBe('facebook');
    }
    for (const r of ['https://www.google.com/', 'https://google.co.uk/', 'https://www.google.de/search?q=nails']) expect(read('', r)).toBe('google');
  });

  it('anything else is no telling', () => {
    for (const r of ['', 'not a link', 'https://example.com/', 'https://book.example.com/manage/abc', 'https://notinstagram.com/',
      'https://instagram.com.example.com/', 'https://news.google.com/', 'https://googleusercontent.com/', 'https://business.facebook.com/',
      'android-app://com.google.android.gm/']) {
      expect(read('', r)).toBeNull();
    }
    expect(read('?treatment=biab-infill')).toBeNull();
  });

  it('cleanLinkSource keeps a–z, 0–9 and dashes, lower case, up to 30', () => {
    expect(cleanLinkSource('IG story 2')).toBe('igstory2');
    expect(cleanLinkSource('Summer-Fair_2026')).toBe('summer-fair2026');
    expect(cleanLinkSource('!!!')).toBeNull();
    expect(cleanLinkSource(42)).toBeNull();
    expect(cleanLinkSource(null)).toBeNull();
  });
});

describe('"How did you hear about me?"', () => {
  it('offers six answers, the ones the database keeps', () => {
    expect(HEARD_FROM.map((h) => [h.value, h.label])).toEqual([
      ['instagram', 'Instagram'], ['facebook', 'Facebook'], ['google', 'Google'], ['friend', 'A friend'],
      ['card', 'Saw a card or poster'], ['other', 'Other'],
    ]);
    const check = schema.match(/^\s+heard_from\s+text check \(heard_from in \(([^)]*)\)\),$/m);
    expect(check?.[1].split(',').map((v) => v.trim().replace(/'/g, ''))).toEqual(HEARD_FROM.map((h) => h.value));
    expect(HEARD_FROM_LABEL.card).toBe('Saw a card or poster');
  });

  it('only A friend and Other come with a few words', () => {
    expect(HEARD_FROM.filter((h) => takesDetail(h.value)).map((h) => h.value)).toEqual(['friend', 'other']);
    expect(takesDetail(null)).toBe(false);
  });

  it('knows its own answers, and nothing else', () => {
    expect(isHeardFrom('google')).toBe(true);
    for (const v of ['Google', 'tiktok', 'constructor', 'toString', '', null, 1]) expect(isHeardFrom(v)).toBe(false);
  });
});

describe('foundYouLabel: how the owner sees where a client came from', () => {
  it('gives their own answer first, with the friend’s name or the words for Other', () => {
    expect(foundYouLabel(null, 'friend', 'Sam')).toBe('A friend: Sam');
    expect(foundYouLabel(null, 'friend', '  Sam  ')).toBe('A friend: Sam');
    expect(foundYouLabel(null, 'friend', null)).toBe('A friend');
    expect(foundYouLabel(null, 'friend', '   ')).toBe('A friend');
    expect(foundYouLabel(null, 'instagram')).toBe('Instagram');
    expect(foundYouLabel(null, 'card', 'ignored')).toBe('Saw a card or poster');
    expect(foundYouLabel('card', 'other', 'Wedding fair')).toBe('Other: Wedding fair');
  });

  it('else the link they booked through, and a link she made up as she typed it', () => {
    expect(foundYouLabel('instagram', null)).toBe('your Instagram link');
    expect(foundYouLabel('card', null)).toBe('your printed card');
    expect(foundYouLabel('free-times', undefined)).toBe('a free-times post');
    expect(foundYouLabel('facebook', null)).toBe('your Facebook link');
    expect(foundYouLabel('google', null)).toBe('Google');
    expect(foundYouLabel('friend', null)).toBe('a client sharing your link');
    expect(foundYouLabel('summer-fair', null)).toBe('summer-fair');
    expect(linkLabel('constructor')).toBe('constructor');
  });

  it('nothing to go on is null', () => {
    expect(foundYouLabel(null, null)).toBeNull();
    expect(foundYouLabel('', null, 'Sam')).toBeNull();
  });

  it('her own links carry these', () => {
    expect(Object.values(LINK_FROM).map((v) => [v, linkLabel(v)])).toEqual([
      ['instagram', 'your Instagram link'], ['facebook', 'your Facebook link'], ['card', 'your printed card'],
      ['free-times', 'a free-times post'], ['friend', 'a client sharing your link'],
    ]);
    for (const v of Object.values(LINK_FROM)) expect(cleanLinkSource(v)).toBe(v);
  });
});

describe('tidyExtras: the answers as the database keeps them', () => {
  const none = { link_source: null, heard_from: null, heard_from_detail: null, first_visit: null, marketing_ok: false };

  it('keeps each one only in the shape it should have', () => {
    expect(tidyExtras({ link_source: 'Instagram!!', heard_from: 'friend', heard_from_detail: '  Sam \n\t from   work ', first_visit: false,
      marketing_ok: true })).toEqual({ link_source: 'instagram', heard_from: 'friend', heard_from_detail: 'Sam from work', first_visit: false,
      marketing_ok: true });
    expect(tidyExtras({ link_source: 42, heard_from: 'Instagram', first_visit: 'yes', marketing_ok: 'true' })).toEqual(none);
    expect(tidyExtras({ heard_from: 'tiktok', heard_from_detail: 'Sam' })).toEqual(none);
  });

  it('the words: one line of up to 60 characters, only with A friend or Other, never a link, an address or markup', () => {
    const detail = (heard_from: string, heard_from_detail: unknown) => tidyExtras({ heard_from, heard_from_detail }).heard_from_detail;
    expect(detail('other', 'A wedding fair')).toBe('A wedding fair');
    expect(detail('friend', 'S'.repeat(200))).toBe('S'.repeat(60));
    expect(detail('friend', `${'a'.repeat(59)} b`)).toBe('a'.repeat(59));
    // Characters, not bytes: an emoji is one, as in the database.
    expect(detail('friend', '💅'.repeat(70))).toBe('💅'.repeat(60));
    for (const bad of ['sam@example.com', 'Sam at www.example.com', 'WWW.EXAMPLE.COM', 'https://example.com', '<b>Sam</b>', 'a > b', ' \n ']) {
      expect(detail('friend', bad)).toBeNull();
    }
    expect(detail('instagram', 'Sam')).toBeNull();
    expect(detail('friend', 99)).toBeNull();
  });

  it('anything that isn’t an object is no answers at all', () => {
    for (const odd of [[1, 2], 'instagram', 42, true, null, undefined]) expect(tidyExtras(odd)).toEqual(none);
  });
});

describe('extrasToSend: only answers worth sending go with a booking', () => {
  it('nothing to send is null, so the booking goes without', () => {
    expect(extrasToSend(undefined)).toBeNull();
    expect(extrasToSend({})).toBeNull();
    expect(extrasToSend({ marketing_ok: false, link_source: '', heard_from: null, first_visit: null })).toBeNull();
    expect(extrasToSend({ heard_from_detail: 'Sam' })).toBeNull();
  });

  it('“No, I’ve been before” is an answer; the rest is tidied', () => {
    expect(extrasToSend({ first_visit: false })).toEqual({ first_visit: false });
    expect(extrasToSend({ link_source: 'Instagram!!', heard_from: 'friend', heard_from_detail: ' Sam ', first_visit: true, marketing_ok: true }))
      .toEqual({ link_source: 'instagram', heard_from: 'friend', heard_from_detail: 'Sam', first_visit: true, marketing_ok: true });
    expect(extrasToSend({ marketing_ok: true })).toEqual({ marketing_ok: true });
  });
});

describe('summariseNewClients: Money → New clients', () => {
  let n = 0;
  const row = (client_id: string, created_at: string, over: Partial<NewClientBooking> = {}): NewClientBooking => ({
    id: `a${++n}`, client_id, status: 'confirmed', created_at, link_source: null, heard_from: null, heard_from_detail: null,
    full_name: client_id, ...over,
  });

  it('counts each client once: who booked, who came, how they heard and which link, never twice', () => {
    const rows = [
      // Given out of order: the first answer and link each client gave are the ones that count.
      row('sam', '2026-11-20T10:00:00.000Z', { heard_from: 'instagram', link_source: 'card' }),
      row('sam', '2026-11-02T10:00:00.000Z', { heard_from: 'friend', heard_from_detail: 'Jess', status: 'completed' }),
      row('amy', '2026-11-03T10:00:00.000Z', { link_source: 'instagram' }),
      row('jess', '2026-11-04T10:00:00.000Z', { heard_from: 'google', link_source: 'free-times', status: 'completed' }),
      row('jess', '2026-11-05T10:00:00.000Z', { status: 'completed' }),
      row('kim', '2026-11-06T10:00:00.000Z', { heard_from: 'friend', heard_from_detail: ' Amy ', status: 'cancelled' }),
      row('lou', '2026-11-07T10:00:00.000Z', { status: 'no_show' }),
      row('mia', '2026-11-08T10:00:00.000Z', { heard_from: 'friend', link_source: 'instagram' }),
      row('zoe', '2026-11-09T10:00:00.000Z', { heard_from: 'card', heard_from_detail: 'not kept for a card' }),
    ];
    const s = summariseNewClients(rows);
    expect(s).toEqual({
      booked: 7,
      came: 2,
      byAnswer: [
        { label: 'A friend', count: 3, names: ['Jess', 'Amy'] },
        { label: 'Google', count: 1 },
        { label: 'Saw a card or poster', count: 1 },
      ],
      byLink: [
        { label: 'your Instagram link', count: 2 },
        { label: 'a free-times post', count: 1 },
        { label: 'your printed card', count: 1 },
      ],
      didntSay: 2,
    });
    // Every client is counted once among the answers or "didn't say".
    expect(s.byAnswer.reduce((t, a) => t + a.count, 0) + s.didntSay).toBe(s.booked);
  });

  it('a later answer counts when the first booking had none', () => {
    const s = summariseNewClients([row('amy', '2026-11-01T10:00:00.000Z'), row('amy', '2026-11-12T10:00:00.000Z', { heard_from: 'other', heard_from_detail: 'A wedding fair' })]);
    expect(s).toMatchObject({ booked: 1, byAnswer: [{ label: 'Other', count: 1, names: ['A wedding fair'] }], didntSay: 0 });
  });

  it('a month with nobody new', () => {
    expect(summariseNewClients([])).toEqual({ booked: 0, came: 0, byAnswer: [], byLink: [], didntSay: 0 });
  });
});
