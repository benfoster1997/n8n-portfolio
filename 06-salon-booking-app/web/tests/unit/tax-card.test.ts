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

describe('when it’s paid', () => {
  it('a bill of £1,000 or more: half of it again on 31 January, and the other half on 31 July', () => {
    // 2026–27: £19,000 of takings, so £18,000 profit: £1,086 Income Tax + £325.80 Class 4 = £1,411.80.
    const { text } = card({ takings: 19_000 });
    expect(text).toContain('£1,412');
    expect(text).toContain('Send your 2026–27 tax return online and pay the bill by 31 January 2028.');
    expect(text).toContain('On the figures so far, that means: By 31 January 2028 £2,118 This bill, plus £706 towards 2027–28 By 31 July 2028 £706');
    expect(text).toContain('Already make payments on account? Then part of this bill is paid in advance, so there’s less to pay in January.');
    expect(text).toContain('other half by 31 July 2028. Not if more than 80% of your tax is already taken at source');
    expect(text).toContain('You can ask HMRC to reduce your payments on account (online, or with form SA303)');
  });

  it('the 2025–26 bill, due in January 2027, gets the same, for a whole tax year', () => {
    // £21,500 of takings and £3,500 of expenses: the same £18,000 profit.
    const { text } = card({ year: 2025, row: figures(2025, 21_500, 3_500) });
    expect(text).toContain('For the whole tax year: about 7% of your takings.');
    expect(text).toContain('That means: By 31 January 2027 £2,118 This bill, plus £706 towards 2026–27 By 31 July 2027 £706');
    expect(text).toContain('part of this bill was paid in advance');
  });

  it('under £1,000: just the bill, with no payments on account to add', () => {
    // £15,000 → £14,000 profit: £286 + £85.80
    const { text } = card({ takings: 15_000 });
    expect(text).toContain('£372');
    expect(text).not.toContain('that means:');
  });

  it('a year whose bill was due in the past says so, and plans nothing', () => {
    const { text } = card({ year: 2024, row: figures(2024, 19_000) });
    expect(text).toContain('Your 2024–25 tax return and bill were due by 31 January 2026.');
    expect(text).not.toContain('Send your');
    expect(text).not.toContain('that means:');
  });

  it('from 2028–29, no dates for payments towards 2029–30: HMRC plans payments during the year instead', () => {
    const { text } = card({ year: 2028, today: '2028-11-05', takings: 30_000 });
    expect(text).toContain('Send your 2028–29 tax return online and pay the bill by 31 January 2030.');
    expect(text).not.toContain('By 31 January 2030');
    expect(text).toContain('From April 2029, HMRC plans to collect that in smaller automatic payments during the year');
  });
});

describe('Making Tax Digital', () => {
  it('2026–27 takings over £20,000: from April 2028 at the latest, or sooner after higher takings in 2025–26 or 2024–25', () => {
    const { html, text } = card({ row: figures(2026, 24_500, 600), takings: 190 });
    expect(text).toContain('Your takings for 2026–27 are over £20,000, so under current rules HMRC’s Making Tax Digital applies to you from 6 April 2028 at the latest (the start of the 2028–29 tax year)');
    expect(text).toContain('Sooner if an earlier tax year’s takings were over its limit: 2025–26 over £30,000: from 6 April 2027 2024–25 over £50,000: since 6 April 2026');
    // The date never breaks over two lines.
    expect(html).toContain('<span class="od-nowrap">6 April 2028</span>');
  });

  it('a start date that has passed: it has applied since then', () => {
    const { text } = card({ year: 2024, row: figures(2024, 55_000) });
    expect(text).toContain('Your takings for 2024–25 were over £50,000, so under current rules HMRC’s Making Tax Digital has applied to you since 6 April 2026 (the start of the 2026–27 tax year)');
    expect(text).toContain('by 7 August, 7 November, 7 February and 7 May');
    expect(text).not.toContain('Sooner if');
  });

  it('under this year’s limit, the timetable is still there to check', () => {
    const { text } = card({ takings: 15_000 });
    expect(text).not.toContain('applies to you');
    expect(text).toContain('Making Tax Digital Under current rules');
    expect(text).toContain('2024–25 over £50,000: since 6 April 2026 2025–26 over £30,000: from 6 April 2027 2026–27 over £20,000: from 6 April 2028');
  });
});

describe('the breakdown', () => {
  it('a share under 1% says so, rather than “about 1%”', () => {
    // £13,600 → £12,600 profit: £6 + £1.80, rounded to £6 + £2
    const { text } = card({ takings: 13_600 });
    expect(text).toContain('£8');
    expect(text).toContain('So far this tax year: less than 1% of your takings.');
  });

  it('takings under the trading allowance: only as much of it as the takings comes off', () => {
    const { text } = card({ takings: 500 });
    expect(text).toContain('Trading allowance −£500');
    expect(text).toContain('Takings of £1,000 or less in a tax year are tax-free: that’s the trading allowance.');
    expect(text).toContain('Profit £0');
  });

  it('expenses bigger than the takings: no profit, and it says why', () => {
    const { text } = card({ takings: 3_000, row: figures(2026, 0, 4_000) });
    expect(text).toContain('Expenses −£4,000');
    expect(text).toContain('Your expenses are more than your takings, so there’s no profit and no tax to pay.');
    expect(text).toContain('Nothing yet: the first £12,570 of profit each tax year is tax-free.');
  });
});
