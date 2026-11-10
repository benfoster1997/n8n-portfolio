import { describe, expect, it } from 'vitest';
import schema from '../../../supabase/schema.sql?raw';
import {
  DEFAULT_BUSINESS_NAME, DEFAULT_TEMPLATES, dmLinks, fillTemplate, friendlyError, isReviewLink, shortNoticeMessage, STOP_LINE,
  suggestEmail, TEMPLATE_PLACEHOLDERS, templateFor,
} from '../../src/lib/text';
import { isNeedsUpdate, NeedsUpdateError } from '../../src/api/api';
import type { Appointment, Settings } from '../../src/lib/types';

// The words around asking for a Google review, messaging her, the short-notice list and
// email addresses that look mistyped.

const settings = (over: Partial<Settings> = {}) => ({
  business_name: 'Demo Nail Studio', timezone: 'Europe/London', cancel_notice_hours: 48, client_self_service: true,
  public_site_url: 'https://book.example.com', deposit_amount_pence: 1000, wa_template_reminder: null, wa_template_deposit: null,
  wa_template_confirmed: null, wa_template_review: null, review_link: 'https://g.page/r/demo-studio/review', ...over,
} as unknown as Settings);
const appt = {
  client: { id: 'c1', full_name: 'Amy Example', email: null, phone: '07700 900111', phone_e164: '447700900111' },
  booking_name: 'Amy Example', service_name: 'Gel polish', starts_at: '2026-11-10T10:00:00.000Z', price_pence: 2500,
  deposit_required_pence: 0, reference: 'K3Q7XP', public_token: 'tok', late_fee_pence: null,
} as unknown as Appointment;

describe('the business name she hasn’t changed yet', () => {
  it('is the database’s starting name', () => {
    expect(schema).toMatch(/^\s+business_name\s+text not null default '([^']+)'/m);
    expect(schema.match(/^\s+business_name\s+text not null default '([^']+)'/m)![1]).toBe(DEFAULT_BUSINESS_NAME);
    expect(DEFAULT_BUSINESS_NAME).toBe('My Nail Studio');
  });
});

describe('the Google review message', () => {
  it('thanks them, asks for a quick review with her link, signs off with the business, and offers nothing', () => {
    const text = fillTemplate(templateFor('review', settings()), appt, settings());
    expect(text).toBe('Hi Amy, thank you so much for coming in! 💅\n\n'
      + 'If you have a minute, a quick Google review would really help me:\nhttps://g.page/r/demo-studio/review\n\nDemo Nail Studio');
    expect(text.split('\n').at(-1)).toBe('Demo Nail Studio');
    expect(DEFAULT_TEMPLATES.review).not.toMatch(/discount|free|off|%|£|prize|draw|win/i);
  });

  it('uses her own wording when she has written one', () => {
    const own = settings({ wa_template_review: 'Thanks {first_name}! Review me here: {review_link}' });
    expect(fillTemplate(templateFor('review', own), appt, own)).toBe('Thanks Amy! Review me here: https://g.page/r/demo-studio/review');
    expect(templateFor('review', settings({ wa_template_review: '   ' }))).toBe(DEFAULT_TEMPLATES.review);
    // Until the database update has been run, the live app has no such setting yet.
    expect(templateFor('review', settings({ wa_template_review: undefined }))).toBe(DEFAULT_TEMPLATES.review);
  });

  it('{review_link} is listed with the other words, and is empty with no link saved', () => {
    expect(TEMPLATE_PLACEHOLDERS).toContain('{review_link}');
    expect(fillTemplate('Link: {review_link}', appt, settings({ review_link: null }))).toBe('Link: ');
    expect(fillTemplate('Link: {review_link}', appt, settings({ review_link: undefined }))).toBe('Link: ');
  });

  it('the other messages are as they were', () => {
    expect(templateFor('reminder', settings({ wa_template_reminder: 'Mine' }))).toBe('Mine');
    expect(templateFor('deposit', settings({ wa_template_deposit: 'Pay me' }))).toBe('Pay me');
    expect(templateFor('confirmed', settings())).toBe(DEFAULT_TEMPLATES.confirmed);
  });
});

describe('isReviewLink: checking her review link before it’s saved', () => {
  it('takes https links with no spaces, as the database does', () => {
    for (const ok of ['https://g.page/r/demo-studio/review', ' https://g.page/r/demo-studio/review ', 'https://maps.app.goo.gl/AbC123',
      'https://goo.gl/maps/AbC123', 'https://www.google.com/maps/place/Demo', 'https://google.co.uk/search?q=demo',
      'https://search.google.com/local/writereview?placeid=AbC', 'https://www.g.page/demo']) {
      expect(isReviewLink(ok)).toEqual({ ok: true, warn: false });
    }
    for (const bad of ['', null, undefined, 'http://g.page/r/demo', 'g.page/r/demo', 'https://g.page/r/demo studio', 'https://',
      `https://${'x'.repeat(291)}`, 'javascript:alert(1)']) {
      expect(isReviewLink(bad)).toEqual({ ok: false, warn: false });
    }
    expect(isReviewLink(`https://${'x'.repeat(290)}`).ok).toBe(true);
  });

  it('warns when it isn’t one of Google’s, but still lets her save it', () => {
    for (const other of ['https://example.com/reviews', 'https://www.instagram.com/demo.nails/', 'https://notgoogle.com/review',
      'https://google.com.example.com/review', 'https://g.page.example.com/r/x', 'https://evilgoo.gl/x']) {
      expect(isReviewLink(other)).toEqual({ ok: true, warn: true });
    }
  });
});

describe('suggestEmail: “Did you mean …?” for a mistyped address', () => {
  it('corrects a domain a letter or two away from a common one', () => {
    expect(suggestEmail('sam@gmial.com')).toBe('sam@gmail.com');
    expect(suggestEmail('sam@gmail.co')).toBe('sam@gmail.com');
    expect(suggestEmail('sam@gamil.com')).toBe('sam@gmail.com');
    expect(suggestEmail('amy@hotmial.co.uk')).toBe('amy@hotmail.co.uk');
    expect(suggestEmail('jess@icloud.co')).toBe('jess@icloud.com');
    expect(suggestEmail(' Sam.Example@GMAIL.CON ')).toBe('Sam.Example@gmail.com');
    expect(suggestEmail('kim@yahoo.co.u')).toBe('kim@yahoo.co.uk');
    expect(suggestEmail('lou@outlok.com')).toBe('lou@outlook.com');
    expect(suggestEmail('mia@btinternet.cm')).toBe('mia@btinternet.com');
    expect(suggestEmail('zoe@me.co')).toBe('zoe@me.com');
  });

  it('leaves right addresses, and real domains that happen to be close, alone', () => {
    for (const fine of ['sam@gmail.com', 'amy@yahoo.co.uk', 'jess@hotmail.co.uk', 'kim@mail.com', 'lou@email.com', 'mia@gmx.com',
      'zoe@gmx.co.uk', 'sam@mac.com', 'amy@live.com', 'jess@sky.com', 'kim@ntlworld.com', 'lou@ymail.com', 'mia@example.com',
      'zoe@nails.example']) {
      expect(suggestEmail(fine)).toBeNull();
    }
  });

  it('never “corrects” another country’s address, however close it looks', () => {
    for (const real of ['yahoo.co.in', 'yahoo.co.nz', 'yahoo.co.jp', 'yahoo.ca', 'hotmail.ca', 'hotmail.co.za', 'live.co.za',
      'hotmail.fr', 'hotmail.co.jp', 'live.co.nz', 'yahoo.com.au', 'hotmail.com.au', 'outlook.ie', 'yahoo.cn', 'gmx.de']) {
      expect(suggestEmail(`sam@${real}`), real).toBeNull();
    }
  });

  it('puts a mistyped ending right, even with the name right: .con, .cm, .co, .om, .ocm, .couk, .co.ik, a dot too many or none', () => {
    expect(suggestEmail('sam@gmail.om')).toBe('sam@gmail.com');
    expect(suggestEmail('sam@gmail.ocm')).toBe('sam@gmail.com');
    expect(suggestEmail('sam@gmail.com.')).toBe('sam@gmail.com');
    expect(suggestEmail('sam@gmailcom')).toBe('sam@gmail.com');
    expect(suggestEmail('amy@hotmail.couk')).toBe('amy@hotmail.co.uk');
    expect(suggestEmail('amy@hotmail.co.ik')).toBe('amy@hotmail.co.uk');
    expect(suggestEmail('amy@hotmail.cp.uk')).toBe('amy@hotmail.co.uk');
  });

  it('a real address other than the usual ones, mistyped, is put right as itself', () => {
    expect(suggestEmail('sam@email.co')).toBe('sam@email.com');
    expect(suggestEmail('sam@live.co')).toBe('sam@live.com');
    expect(suggestEmail('sam@emial.com')).toBe('sam@email.com');
    expect(suggestEmail('sam@ntlworld.co')).toBe('sam@ntlworld.com');
  });

  it('only one letter for short domains, and a short name is never changed: only its ending', () => {
    expect(suggestEmail('sam@aol.co')).toBe('sam@aol.com');
    expect(suggestEmail('sam@aol.cm')).toBe('sam@aol.com');
    expect(suggestEmail('sam@aim.com')).toBeNull(); // two from aol.com
    expect(suggestEmail('sam@mee.cm')).toBeNull(); // two from me.com
    // One letter from me.com, aol.com or live.co.uk, but often someone's real address.
    for (const real of ['my.com', 'mw.com', 'ao.com', 'aon.com', 'lime.co.uk', 'olive.co.uk']) expect(suggestEmail(`sam@${real}`), real).toBeNull();
    // A name typed short: one letter put right at most, none for three letters or fewer.
    expect(suggestEmail('sam@gmai.com')).toBe('sam@gmail.com');
    for (const short of ['ail.com', 'gma.com', 'yah.com']) expect(suggestEmail(`sam@${short}`), short).toBeNull();
  });

  it('nothing to go on is null', () => {
    for (const odd of ['', null, undefined, 'gmial.com', '@gmial.com', 'sam@', 'sam@@gmial.com', 'a@b@gmial.com']) {
      expect(suggestEmail(odd)).toBeNull();
    }
  });
});

describe('dmLinks: “Message me” instead of a dead end', () => {
  it('an Instagram or Facebook message, or an email with the subject filled in', () => {
    expect(dmLinks({ instagram: 'demo.nails', facebook: 'demonails', email: 'owner@example.com' })).toEqual({
      instagram: 'https://ig.me/m/demo.nails',
      facebook: 'https://m.me/demonails',
      email: 'mailto:owner@example.com?subject=Booking%20enquiry',
    });
  });

  it('leaves out the blank ones, and anything that isn’t a handle or an address', () => {
    expect(dmLinks({ instagram: null, facebook: '  ', email: undefined })).toEqual({});
    expect(dmLinks({ instagram: 'demo.nails' })).toEqual({ instagram: 'https://ig.me/m/demo.nails' });
    expect(dmLinks({ email: ' owner@example.com ' })).toEqual({ email: 'mailto:owner@example.com?subject=Booking%20enquiry' });
    expect(dmLinks({ instagram: '@demo nails', facebook: 'https://evil.example/x', email: 'owner@example.com?cc=a@b.com' })).toEqual({});
  });
});

describe('shortNoticeMessage: a message to clients who said yes to short-notice spaces', () => {
  it('signs it with the business, then says how to stop them, last', () => {
    const text = shortNoticeMessage('Spaces for Gel polish: Tue 10 Nov 2pm. Book here: https://book.example.com/book', 'Demo Nail Studio');
    expect(text).toBe("Spaces for Gel polish: Tue 10 Nov 2pm. Book here: https://book.example.com/book\n\nDemo Nail Studio\nReply STOP if you'd rather not get these messages.");
    expect(text.split('\n').at(-1)).toBe(STOP_LINE);
  });

  it('doesn’t sign twice, or add the line twice', () => {
    expect(shortNoticeMessage('A space tomorrow at 10am!\nDemo Nail Studio', 'Demo Nail Studio'))
      .toBe(`A space tomorrow at 10am!\nDemo Nail Studio\n${STOP_LINE}`);
    const once = shortNoticeMessage('A space tomorrow', 'Demo Nail Studio');
    expect(shortNoticeMessage(once, 'Demo Nail Studio')).toBe(once);
    expect(shortNoticeMessage('  A space tomorrow  ', '')).toBe(`A space tomorrow\n\n${STOP_LINE}`);
    expect(shortNoticeMessage('A space tomorrow', null)).toBe(`A space tomorrow\n\n${STOP_LINE}`);
  });
});

describe('before the database update for this version has been run', () => {
  it('says so in words she can pass on', () => {
    const e = new NeedsUpdateError();
    expect(e).toBeInstanceOf(Error);
    expect(e.update).toBe('supabase/updates/2026-11-growth.sql');
    expect(friendlyError(e)).toMatch(/database update for this version of the app, which hasn’t been run yet/);
    expect(friendlyError(e)).toMatch(/2026-11-growth\.sql/);
    expect(isNeedsUpdate(e)).toBe(true);
    expect(isNeedsUpdate(new Error('growth_update_needed'))).toBe(true);
    expect(isNeedsUpdate(new Error('slot_taken'))).toBe(false);
    expect(isNeedsUpdate(null)).toBe(false);
  });
});
