import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { TaxYear } from '../../src/lib/types';
import { TaxCardView, taxCardState } from '../../src/pages/admin/Money';

// The "Tax to put aside" card (Money → Tax year) as it renders, without the live or
// demo API behind it (vi.mock runs before the imports). Figures are worked by hand
// from the 2025–26 and 2026–27 rates.
vi.mock('../../src/api', () => ({ api: {} }));

const gbp = (pounds: number) => Math.round(pounds * 100);
const TODAY = '2026-11-05';

function figures(year: number, extra = 0, expenses = 0, saved = extra > 0 || expenses > 0): TaxYear {
  return { start_year: year, extra_takings_pence: gbp(extra), expenses_pence: gbp(expenses), updated_at: saved ? '2026-11-01T12:00:00.000Z' : null };
}

/** The card's HTML, and its text with one space between blocks. */
function card({ year = 2026, today = TODAY, takings = 0, row = figures(year), failed = false, hasTakings = takings !== 0 }: {
  year?: number; today?: string; takings?: number; row?: TaxYear | null; failed?: boolean; hasTakings?: boolean;
} = {}) {
  const html = renderToStaticMarkup(createElement(TaxCardView, {
    startYear: year, today, takingsPence: gbp(takings), hasTakings, row, failed, onEdit: () => {}, onRetry: () => {},
  }));
  const text = html.replace(/<\/(p|div|li|dt|dd|summary|h2|button|ul)>/g, ' ').replace(/<[^>]+>/g, '')
    .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
  return { html, text };
}
const EDIT_OFF = /<button class="btn small od-taxcard-edit" disabled="">/;
const EDIT_ON = /<button class="btn small od-taxcard-edit">/;
const ESTIMATE = 'od-taxcard-value';

describe('her figures for the year couldn’t be loaded', () => {
  it('Edit stays off and there’s no estimate, just a way to try again', () => {
    // getTaxYear threw (say a dropped connection) before anything loaded for this year.
    const state = taxCardState(undefined, new Error('upstream request timeout'), false, 2026);
    expect(state).toEqual({ row: null, failed: true });
    const { html, text } = card({ takings: 19_000, ...state });
    expect(html).toMatch(EDIT_OFF);
    expect(html).not.toContain(ESTIMATE);
    expect(text).toContain('Your figures for 2026–27 couldn’t be loaded just now, so there’s no estimate yet.');
    expect(text).toContain('Try again');
    expect(text).not.toContain('upstream request timeout');
  });

  it('while it tries again, and while another year’s figures are still showing, Edit stays off too', () => {
    const retrying = taxCardState(undefined, new Error('x'), true, 2026);
    expect(retrying).toEqual({ row: null, failed: false });
    expect(card({ takings: 19_000, ...retrying }).html).toMatch(EDIT_OFF);
    // The previous year's figures never stand in for this year's.
    expect(taxCardState({ year: 2025, row: figures(2025, 16_400) }, new Error('x'), false, 2026)).toEqual({ row: null, failed: true });
  });

  it('a refresh that fails after a save keeps the saved figures, and Edit', () => {
    const saved = figures(2026, 16_400, 2_150);
    const state = taxCardState({ year: 2026, row: saved }, new Error('x'), false, 2026);
    expect(state).toEqual({ row: saved, failed: false });
    const { html } = card({ takings: 190, ...state });
    expect(html).toMatch(EDIT_ON);
    expect(html).toContain(ESTIMATE);
  });
});

describe('a tax year with nothing in the app and nothing added', () => {
  it('asks for that year’s figures before its bill is due, instead of showing £0', () => {
    const { html, text } = card({ year: 2025 });
    expect(html).not.toContain(ESTIMATE);
    expect(html).toMatch(EDIT_ON);
    expect(text).toContain('No takings for 2025–26 in the app');
    expect(text).toContain('tap Edit and add its takings and expenses to see roughly what to put aside for 31 January 2027');
    expect(text).not.toContain('Nothing yet');
  });

  it('this tax year, a finished one whose bill was due, and one that hasn’t started', () => {
    expect(card({ year: 2026 }).text).toContain('No takings for 2026–27 in the app yet');
    expect(card({ year: 2024 }).text).toContain('To see roughly what that year’s bill came to');
    expect(card({ year: 2027 }).text).toContain('Nothing for 2027–28 yet It starts on 6 April 2027.');
  });

  it('shows the estimate once she has saved figures for it, even zeros', () => {
    const { html, text } = card({ year: 2025, row: figures(2025, 0, 0, true) });
    expect(html).toContain(ESTIMATE);
    expect(text).toContain('Nothing to pay: the first £12,570 of profit each tax year is tax-free.');
  });
});

describe('takings in the app, but nothing added with Edit yet', () => {
  it('asks about money taken another way, until she saves her figures', () => {
    // The year she switched: a few weeks in the app, most of the year's money in another app.
    const { html, text } = card({ takings: 2_500 });
    expect(html).toContain(ESTIMATE);
    expect(text).toContain('Nothing yet: the first £12,570 of profit each tax year is tax-free. Took money another way this tax year, such as '
      + 'bookings through another app before you switched? Tap Edit to add it, with your expenses.');
    expect(card({ takings: 2_500, row: figures(2026, 0, 0, true) }).text).not.toContain('Took money another way');
    expect(card({ takings: 2_500, row: figures(2026, 16_400) }).text).not.toContain('Took money another way');
    // A finished year names it.
    expect(card({ year: 2025, takings: 2_500 }).text)
      .toContain('Took money another way in 2025–26, such as through another app? Tap Edit to add it, with your expenses.');
  });
});

describe('when it’s paid', () => {
  it('a bill of £1,000 or more: what to pay on 31 January (the bill and half of it again) and 31 July (the other half)', () => {
    // 2026–27: £19,000 of takings, so £18,000 profit: £1,086 Income Tax + £325.80 Class 4 = £1,411.80.
    const { text } = card({ takings: 19_000 });
    expect(text).toContain('£1,412');
    // The amounts come straight after the date, not four lines later.
    expect(text).toContain('Send your 2026–27 tax return online by 31 January 2028. On the figures so far, you’ll pay HMRC: '
      + 'By 31 January 2028 £2,118 This bill, plus £706 towards 2027–28. By 31 July 2028 £706 '
      + 'The two £706 payments go towards 2027–28 (“payments on account”): when a bill is £1,000 or more, HMRC usually asks for half of it again, twice.');
    // The line above says what 2025–26's bill pays towards this one early, so this only says what that means for it.
    expect(text).toContain('Paying part of this bill early, as above? Then there’s that much less to pay on 31 January 2028.');
    // "How it's paid" doesn't repeat the plan, but still says how to ask for smaller payments.
    expect(text).not.toContain('Not if more than 80%');
    expect(text).toContain('How it’s paid Expect a smaller bill next year? You can ask HMRC to reduce your payments on account (online, or with form SA303)');
  });

  it('the 2025–26 bill, due in January 2027, gets the same, for a whole tax year, with the safe day to pay at a weekend', () => {
    // £21,500 of takings and £3,500 of expenses: the same £18,000 profit.
    const { text } = card({ year: 2025, row: figures(2025, 21_500, 3_500) });
    expect(text).toContain('For the whole tax year: about 7% of your takings, as the first £12,570 of profit is tax-free.');
    // 31 January 2027 is a Sunday and 31 July 2027 a Saturday.
    expect(text).toContain('Send your 2025–26 tax return online by 31 January 2027, and pay HMRC: '
      + 'By 31 January 2027 £2,118 This bill, plus £706 towards 2026–27. That’s a Sunday: to be safe, pay by Friday 29 January. '
      + 'By 31 July 2027 £706 That’s a Saturday: to be safe, pay by Friday 30 July.');
    // Payments on account towards 2025–26 itself come from the 2024–25 bill.
    expect(text).toContain('Was your 2024–25 bill £1,000 or more? Then half of it again went towards this bill by 31 January 2026, and '
      + 'another half by 31 July 2026, so there’s that much less to pay on 31 January 2027.');
    // Not this year's card: no line about an earlier year.
    expect(text).not.toContain('Due first');
  });

  it('from 1 February, the July payment still shows until it’s due', () => {
    // 2025–26 with £19,000 of takings: a £1,412 bill, so £706 more by 31 July 2027.
    const july = 'Your 2025–26 tax return and bill were due by 31 January 2027. HMRC usually also asks for a second payment towards 2026–27, '
      + 'half of this bill (a “payment on account”): By 31 July 2027 £706 That’s a Saturday: to be safe, pay by Friday 30 July.';
    for (const today of ['2027-02-01', '2027-07-31']) expect(card({ year: 2025, today, row: figures(2025, 19_000) }).text).toContain(july);
    // The January row has gone with its date.
    expect(card({ year: 2025, today: '2027-02-01', row: figures(2025, 19_000) }).text).not.toContain('By 31 January 2027');
    // Once it's due too, nothing more to plan.
    const after = card({ year: 2025, today: '2027-08-01', row: figures(2025, 19_000) }).text;
    expect(after).not.toContain('second payment');
    expect(after).not.toContain('By 31 July 2027');
  });

  it('under £1,000: just the bill, with no payments on account to add', () => {
    // £15,000 → £14,000 profit: £286 + £85.80
    const { text } = card({ takings: 15_000 });
    expect(text).toContain('£372');
    expect(text).toContain('Send your 2026–27 tax return online and pay the bill by 31 January 2028.');
    expect(text).not.toContain('pay HMRC:');
    // With no plan on the card, "How it's paid" explains payments on account.
    expect(text).toContain('other half by 31 July 2028. Not if more than 80% of your tax is already taken at source');
    expect(text).toContain('Was your 2025–26 bill £1,000 or more? Then half of it again goes towards this bill by 31 January 2027');
  });

  it('a weekend due date with no plan: when to pay to be safe', () => {
    // 2025–26, £13,600 of takings: a £8 bill, due on Sunday 31 January 2027.
    expect(card({ year: 2025, row: figures(2025, 13_600) }).text)
      .toContain('Send your 2025–26 tax return online and pay the bill by 31 January 2027 (a Sunday: to be safe, pay by Friday 29 January).');
    // Nothing to pay: just the return, which can be sent online at a weekend.
    expect(card({ year: 2025, row: figures(2025, 9_000) }).text).toContain('Send your 2025–26 tax return online by 31 January 2027.');
  });

  it('a year whose bill was due in the past says so, and plans nothing', () => {
    const { text } = card({ year: 2024, row: figures(2024, 19_000) });
    expect(text).toContain('Your 2024–25 tax return and bill were due by 31 January 2026.');
    expect(text).not.toContain('Send your');
    expect(text).not.toContain('pay HMRC:');
    expect(text).not.toContain('second payment');
    expect(text).toContain('so there was that much less to pay on 31 January 2026.');
  });

  it('this year’s card says first what the year before still has due, and where to see it', () => {
    const first = 'Due first, if you worked in 2025–26: its tax return and bill, by 31 January 2027. If that bill is £1,000 or more, HMRC '
      + 'usually also asks for half of it again then, and another half by 31 July 2027, both towards this year’s bill. Tap ‹ at the top to see 2025–26.';
    // Above this year's own date, with or without figures for this year.
    expect(card({ takings: 19_000 }).text).toContain(`${first} Send your 2026–27 tax return online by 31 January 2028.`);
    expect(card({ year: 2026 }).text).toContain(`No takings for 2026–27 in the app yet Took money another way this tax year`);
    expect(card({ year: 2026 }).text).toContain(first);
    // From 1 February, the payment still to come by 31 July: towards this year until 5 April, then towards the year before.
    expect(card({ today: '2027-02-01', takings: 19_000 }).text).toContain('Due next, if HMRC asked for payments on account: half your '
      + '2025–26 bill again, by 31 July 2027, towards this year’s bill. Tap ‹ at the top to see 2025–26.');
    expect(card({ year: 2027, today: '2027-04-06', takings: 2_000 }).text).toContain('Due next, if HMRC asked for payments on account: '
      + 'half your 2025–26 bill again, by 31 July 2027, towards 2026–27. Tap ‹ twice at the top to see 2025–26.');
    expect(card({ year: 2027, today: '2027-08-01', takings: 9_000 }).text)
      .toContain('Due first, if you worked in 2026–27: its tax return and bill, by 31 January 2028.');
    // Payments towards 2029–30 come during the year instead, so that year's card only gives 2028–29's return and bill.
    expect(card({ year: 2029, today: '2029-11-05', takings: 9_000 }).text)
      .toContain('Due first, if you worked in 2028–29: its tax return and bill, by 31 January 2030. Tap ‹ at the top to see 2028–29.');
    expect(card({ year: 2029, today: '2030-03-01', takings: 9_000 }).text).not.toMatch(/Due (first|next)/);
    // Only on this year's card.
    expect(card({ year: 2025, row: figures(2025, 19_000) }).text).not.toMatch(/Due (first|next)/);
  });

  it('from 2028–29, no dates for payments towards 2029–30: HMRC plans payments during the year instead', () => {
    const { text } = card({ year: 2028, today: '2028-11-05', takings: 30_000 });
    expect(text).toContain('Send your 2028–29 tax return online and pay the bill by 31 January 2030.');
    expect(text).not.toContain('By 31 January 2030');
    expect(text).toContain('From April 2029, HMRC plans to collect that in smaller automatic payments during the year');
  });
});

describe('Making Tax Digital', () => {
  it('2026–27 takings over £20,000: by April 2028, what that means, that this app can’t do it, and the earlier limits', () => {
    const { html, text } = card({ row: figures(2026, 24_500, 600), takings: 190 });
    expect(text).toContain('Your 2026–27 takings are over £20,000, so under current rules Making Tax Digital starts for you by 6 April 2028. '
      + 'From then you’ll need software that works with it, to keep digital records and send HMRC an update every quarter, the first by '
      + '7 August 2028. This app doesn’t send them.');
    expect(text).toContain('It can start sooner, if an earlier tax year’s takings were over that year’s limit: '
      + '2025–26 over £30,000: from 6 April 2027 2024–25 over £50,000: since 6 April 2026');
    // The dates never break over two lines.
    expect(html).toContain('<span class="od-nowrap">6 April 2028</span>');
    expect(html).toContain('<span class="od-nowrap">7 August 2028</span>');
  });

  it('2025–26 over £30,000: one earlier limit, in a sentence', () => {
    expect(card({ year: 2025, row: figures(2025, 32_000) }).text).toContain('Your 2025–26 takings were over £30,000, so under current rules '
      + 'Making Tax Digital starts for you by 6 April 2027. From then you’ll need software that works with it, to keep digital records and '
      + 'send HMRC an update every quarter, the first by 7 August 2027. This app doesn’t send them. '
      + 'It started sooner, on 6 April 2026, if your 2024–25 takings were over £50,000.');
  });

  it('a start date that has passed: it has applied since then', () => {
    const { text } = card({ year: 2024, row: figures(2024, 55_000) });
    expect(text).toContain('Your 2024–25 takings were over £50,000, so under current rules Making Tax Digital has applied to you since '
      + '6 April 2026. You need software that works with it, to keep digital records and send HMRC an update every quarter (by 7 August, '
      + '7 November, 7 February and 7 May). This app doesn’t send them.');
    expect(text).not.toContain('sooner');
  });

  it('under this year’s limit, the timetable is still there to check', () => {
    const { text } = card({ takings: 15_000 });
    expect(text).not.toContain('starts for you');
    expect(text).toContain('Making Tax Digital Under current rules');
    expect(text).toContain('2024–25 over £50,000: since 6 April 2026 2025–26 over £30,000: from 6 April 2027 2026–27 over £20,000: from 6 April 2028');
    expect(text).toContain('using software that works with Making Tax Digital. This app doesn’t send them.');
  });
});

describe('the breakdown', () => {
  it('a share under 1% says so, rather than “about 1%”', () => {
    // £13,600 → £12,600 profit: £6 + £1.80, rounded to £6 + £2
    const { text } = card({ takings: 13_600 });
    expect(text).toContain('£8');
    expect(text).toContain('So far this tax year: less than 1% of your takings, as the first £12,570 of profit is tax-free.');
  });

  it('what to put aside from each £1, and what it’s made of', () => {
    expect(card({ takings: 19_000 }).text).toContain('From here, put aside about 26p of each £1 you take: 20p Income Tax and 6p National Insurance.');
    // £61,000 → £60,000 profit, in the higher-rate band.
    expect(card({ takings: 61_000 }).text).toContain('put aside about 42p of each £1 you take: 40p Income Tax and 2p National Insurance.');
    expect(card({ takings: 5_000 }).text).toContain('Once your profit for the year is over £12,570, put aside about 26p of each £1 you take: '
      + '20p Income Tax and 6p National Insurance.');
    // Over £100,000 the tax-free amount shrinks, so the share line doesn't say it's £12,570.
    const taper = card({ takings: 111_000 }).text;
    expect(taper).toContain('62p of each £1 you take: 60p Income Tax and 2p National Insurance.');
    expect(taper).toMatch(/So far this tax year: about \d+% of your takings\./);
  });

  it('labels the takings the same way as the Edit sheet does', () => {
    expect(card({ takings: 190, row: figures(2026, 16_400) }).text).toContain('Takings in the app £190 Takings not in the app £16,400');
  });

  it('takings under the trading allowance: only as much of it as the takings comes off', () => {
    const { text } = card({ takings: 500 });
    expect(text).toContain('Trading allowance −£500');
    expect(text).toContain('Takings of £1,000 or less in a tax year are tax-free: that’s the trading allowance.');
    expect(text).toContain('Profit £0');
    expect(card({ takings: 19_000 }).text).toContain('With no expenses added, the £1,000 trading allowance comes off instead.');
  });

  it('2027–28’s £3,000 trading allowance is announced, not law yet, wherever the card uses it', () => {
    const at = (takings: number, expenses = 0) => card({ year: 2027, today: '2027-08-15', takings, row: figures(2027, 0, expenses, true) }).text;
    expect(at(2_500)).toContain('Takings of £3,000 or less in a tax year are tax-free: that’s the trading allowance (announced, not law yet).');
    expect(at(20_000)).toContain('With no expenses added, the £3,000 trading allowance (announced, not law yet) comes off instead.');
    expect(at(20_000, 2_000)).toContain('Used instead of your £2,000 of expenses, as the £3,000 allowance (announced, not law yet) is bigger: '
      + 'it’s one or the other, not both.');
    // Years that are law say it plainly.
    expect(card({ takings: 20_000, row: figures(2026, 0, 200) }).text).toContain('Used instead of your £200 of expenses, as it’s bigger:');
  });

  it('a year before 2024–25 says its real bill was higher only when Class 4 was due', () => {
    // The 9% Class 4 rate before April 2024 was only on profit over £12,570: below that the bill was £0 then too.
    const higher = 'National Insurance was higher before April 2024, so the real bill for 2023–24 was higher.';
    for (const takings of [800, 2_500, 13_570]) expect(card({ year: 2023, row: figures(2023, takings) }).text).not.toContain(higher);
    expect(card({ year: 2023, row: figures(2023, 19_000) }).text).toContain(higher);
  });

  it('expenses bigger than the takings: no profit, and it says why', () => {
    const { text } = card({ takings: 3_000, row: figures(2026, 0, 4_000) });
    expect(text).toContain('Expenses −£4,000');
    expect(text).toContain('Your expenses are more than your takings, so there’s no profit and no tax to pay.');
    expect(text).toContain('Nothing yet: the first £12,570 of profit each tax year is tax-free.');
  });
});
