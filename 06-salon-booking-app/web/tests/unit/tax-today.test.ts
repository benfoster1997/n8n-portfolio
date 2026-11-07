import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StaticRouter } from 'react-router-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { estimateTax, poundsDueOnToday, taxDueOnToday, type TaxDueOnToday } from '../../src/lib/tax';
import type { TaxYear } from '../../src/lib/types';
import { TaxDueView, type BillYearFigures } from '../../src/pages/admin/TaxDue';
import { TaxCardView } from '../../src/pages/admin/Money';

// Today's tax card: from 1 December to 31 January the bill for the tax year before (2025–26 in
// 2026–27, due Sunday 31 January 2027), and in July the 31 July payment on account. Figures
// are worked by hand at the 2025–26 rates (the same as 2026–27's: see tax.test.ts).
vi.mock('../../src/api', () => ({ api: {} }));

const gbp = (pounds: number) => Math.round(pounds * 100);
const saved = (year: number, extra: number, expenses = 0): TaxYear =>
  ({ start_year: year, extra_takings_pence: gbp(extra), expenses_pence: gbp(expenses), updated_at: '2026-12-01T10:00:00.000Z' });
const figures = (row: TaxYear, takings = 0): BillYearFigures => ({ row, takingsPence: gbp(takings), hasTakings: takings !== 0 });
const nothing = (year: number): BillYearFigures => ({ row: { start_year: year, extra_takings_pence: 0, expenses_pence: 0, updated_at: null }, takingsPence: 0, hasTakings: false });

const text = (html: string) => html.replace(/<\/(p|div|span|li|dt|dd|a|h2)>/g, ' ').replace(/<[^>]+>/g, '')
  .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function card(today: string, f: BillYearFigures | null, failed = false) {
  const due = taxDueOnToday(today);
  if (!due) throw new Error(`nothing due on ${today}`);
  const html = renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, createElement(TaxDueView, { due, today, figures: f, failed })));
  return { html, text: text(html) };
}

describe('when Today shows the tax card', () => {
  it('from 1 December to 31 January: the year before’s return and bill, with the first payment on account', () => {
    expect(taxDueOnToday('2026-11-30')).toBeNull();
    for (const day of ['2026-12-01', '2026-12-25', '2027-01-01', '2027-01-31']) {
      const due = taxDueOnToday(day)!;
      expect(due.kind).toBe('bill');
      expect(due.billYear).toBe(2025);
      expect(due.date.iso).toBe('2027-01-31');
      expect(due.kind === 'bill' && due.onAccount?.first.iso).toBe('2027-01-31');
    }
    expect(taxDueOnToday('2027-02-01')).toBeNull();
  });

  it('in July: the second payment on account, due 31 July, from the bill of the tax year before last', () => {
    expect(taxDueOnToday('2027-06-30')).toBeNull();
    for (const day of ['2027-07-01', '2027-07-31']) {
      const due = taxDueOnToday(day)!;
      expect(due).toEqual({ kind: 'july', billYear: 2025, date: { iso: '2027-07-31', label: '31 July 2027' } });
    }
    expect(taxDueOnToday('2027-08-01')).toBeNull();
    // Not at any other time of year.
    for (const day of ['2027-03-15', '2027-04-06', '2027-05-31', '2027-10-31']) expect(taxDueOnToday(day)).toBeNull();
  });

  it('once payments on account are paid during the year (from April 2029): the January bill alone, and no July card', () => {
    const due = taxDueOnToday('2029-12-10')!;
    expect(due.kind === 'bill' && due.billYear).toBe(2028);
    expect(due.kind === 'bill' && due.onAccount).toBeNull();
    expect(taxDueOnToday('2030-07-10')).toBeNull();
  });
});

describe('the amount, on her figures', () => {
  const e = (extra: number, expenses = 0, year = 2025) => estimateTax({ taxYearStart: year, takingsPence: 0, extraTakingsPence: gbp(extra), expensesPence: gbp(expenses) });
  it('January: the bill plus half of it again, when the bill is £1,000 or more', () => {
    // £28,500 − £2,150 = £26,350 of profit: £13,780 over £12,570, at 20% (£2,756) and 6% (£826.80).
    expect(poundsDueOnToday(taxDueOnToday('2026-12-07')!, e(28_500, 2_150))).toEqual({ total: 5_374, bill: 3_583, onAccount: 1_791 });
  });
  it('January, a bill under £1,000: just the bill', () => {
    // £16,000 − £1,000 allowance = £15,000 of profit: (£15,000 − £12,570) × 26% = £631.80.
    expect(poundsDueOnToday(taxDueOnToday('2027-01-10')!, e(16_000))).toEqual({ total: 632, bill: 632, onAccount: 0 });
  });
  it('July: the second payment on account, or nothing under £1,000', () => {
    expect(poundsDueOnToday(taxDueOnToday('2027-07-05')!, e(28_500, 2_150)).total).toBe(1_791);
    expect(poundsDueOnToday(taxDueOnToday('2027-07-05')!, e(16_000)).total).toBe(0);
  });
});

describe('the card', () => {
  it('her figures: about £X on them, with the first payment towards 2026–27, less anything already paid', () => {
    const { html, text: t } = card('2026-12-07', figures(saved(2025, 28_500, 2_150)));
    expect(html).toContain('href="/money?taxyear=2025"');
    expect(t).toContain('Your 2025–26 tax return and bill are due Sunday 31 January. Pay by Friday 29 January to be safe.');
    expect(t).toContain('About £5,374 on your figures, including the first payment towards 2026–27: your £3,583 bill, plus £1,791.');
    expect(t).toContain('Less anything you’ve already paid towards 2025–26 (the HMRC app shows the exact amount).');
  });

  it('takings recorded in the app for that year count too', () => {
    const { text: t } = card('2027-01-12', figures(saved(2025, 20_000, 2_150), 8_500));
    expect(t).toContain('About £5,374 on your figures');
  });

  it('no figures for that year (nothing saved, nothing in the app): asks for them instead of a figure', () => {
    const { text: t } = card('2026-12-01', nothing(2025));
    expect(t).toContain('Add your 2025–26 takings and expenses to see your bill.');
    expect(t).not.toContain('About £');
    expect(t).toContain('Your 2025–26 tax return and bill are due Sunday 31 January. Pay by Friday 29 January to be safe.');
  });

  it('a bill under £1,000: no payment on account', () => {
    const { text: t } = card('2026-12-07', figures(saved(2025, 16_000)));
    expect(t).toContain('About £632 on your figures.');
    expect(t).not.toContain('first payment');
    expect(t).toContain('Less anything you’ve already paid towards 2025–26');
  });

  it('nothing to pay on her figures: just the return', () => {
    const { text: t } = card('2026-12-07', figures(saved(2025, 9_000)));
    expect(t).toContain('Your 2025–26 tax return is due Sunday 31 January.');
    expect(t).toContain('Nothing to pay on your figures.');
    expect(t).not.toContain('Pay by');
  });

  it('after the Friday before a weekend due date: pay today by Faster Payments or debit card (HMRC takes no personal credit cards)', () => {
    const { text: t } = card('2027-01-30', figures(saved(2025, 28_500, 2_150)));
    expect(t).not.toContain('Pay by Friday 29 January');
    expect(t).toContain('Not paid yet? Pay today by Faster Payments (your banking app) or debit card: those count on the day.');
  });

  it('a due date on a weekday: no “to be safe” day', () => {
    // 2026–27’s bill is due Monday 31 January 2028.
    const { text: t } = card('2027-12-10', figures(saved(2026, 28_500, 2_150)));
    expect(t).toContain('Your 2026–27 tax return and bill are due Monday 31 January.');
    expect(t).not.toContain('to be safe');
  });

  it('only the app’s takings, with nothing saved for that year (the year she switched apps): says the figure is too low without the rest', () => {
    // 2026–27, from 1 December 2027: £15,000 taken in the app from September, nothing added with Edit.
    // £14,000 of profit after the trading allowance: £286 Income Tax and £86 Class 4.
    const appOnly: BillYearFigures = { row: nothing(2026).row, takingsPence: gbp(15_000), hasTakings: true };
    const hint = 'Took money another way in 2026–27, such as through another app? Tap to add it, or this is too low.';
    const { text: t } = card('2027-12-05', appOnly);
    expect(t).toContain('About £372 on your figures.');
    expect(t).toContain(hint);
    // Under the tax-free allowance on the app's takings alone: still worth asking.
    expect(card('2027-12-05', { ...appOnly, takingsPence: gbp(9_000) }).text).toContain(`Nothing to pay on your figures. ${hint}`);
    // Once she has saved her figures for that year (even just expenses), it isn't said.
    expect(card('2027-12-05', figures(saved(2026, 0, 500), 15_000)).text).not.toContain('Took money another way');
    expect(card('2026-12-07', figures(saved(2025, 28_500, 2_150))).text).not.toContain('Took money another way');
  });

  it('while her figures load, and if they can’t be', () => {
    expect(card('2026-12-07', null).text).toContain('Working out your bill…');
    expect(card('2026-12-07', null, true).text).toContain('Your 2025–26 figures couldn’t be loaded just now.');
  });

  it('July: half the bill again towards the next year, if HMRC asked for it', () => {
    const { html, text: t } = card('2027-07-05', figures(saved(2025, 28_500, 2_150)));
    expect(html).toContain('href="/money?taxyear=2025"');
    expect(t).toContain('Half your 2025–26 bill again is due Saturday 31 July, towards 2026–27, if HMRC asked for payments on account. '
      + 'Pay by Friday 30 July to be safe.');
    expect(t).toContain('About £1,791 on your figures.');
    expect(t).toContain('The HMRC app shows the exact amount.');
  });

  it('July: no card when the bill was under £1,000 (nothing is due), or while it loads', () => {
    expect(card('2027-07-05', figures(saved(2025, 16_000))).html).toBe('');
    expect(card('2027-07-05', null).html).toBe('');
    expect(card('2027-07-05', nothing(2025)).text).toContain('Add your 2025–26 takings and expenses to see roughly how much.');
  });

  it('says the same as the tax card in Money for that year', () => {
    const today = '2026-12-07';
    const row = saved(2025, 28_500, 2_150);
    const money = text(renderToStaticMarkup(createElement(TaxCardView, {
      startYear: 2025, today, takingsPence: 0, hasTakings: false, row, failed: false, onEdit: () => {}, onRetry: () => {},
    })));
    expect(money).toContain('By 31 January 2027 £5,374');
    expect(card(today, figures(row)).text).toContain('About £5,374');
  });
});

/** Every kind of card, so a test can check what any of them say. */
const allDue: TaxDueOnToday[] = ['2026-12-07', '2027-07-05'].map((d) => taxDueOnToday(d)!);
it('never uses the tab names, so the card can’t be mistaken for a tab', () => {
  for (const due of allDue) {
    for (const f of [figures(saved(2025, 28_500, 2_150)), nothing(2025), null,
      { row: nothing(2025).row, takingsPence: gbp(15_000), hasTakings: true }]) {
      const t = text(renderToStaticMarkup(createElement(StaticRouter, { location: '/' }, createElement(TaxDueView, { due, today: '2026-12-07', figures: f, failed: false }))));
      expect(t).not.toMatch(/\b(Today|Diary|Clients|Money|Settings)\b/);
    }
  }
});
