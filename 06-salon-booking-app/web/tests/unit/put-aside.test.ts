import { describe, expect, it } from 'vitest';
import { estimateTax, monthPutAside, monthTaxParts, taxRise } from '../../src/lib/tax';
import { linkedTaxYear } from '../../src/pages/admin/Money';
import type { Payment, TaxYear } from '../../src/lib/types';

// Money → Month: "Put aside about £X of November's £Y for tax". The amount is how much the
// month's takings raise the tax year's estimate, worked by hand at the 2026–27 rates: nothing
// until the profit passes £12,570, then 20% Income Tax + 6% Class 4 = 26p of each £1, and
// 40% + 2% = 42p above £50,270. The trading allowance (£1,000) comes off the takings.
const gbp = (pounds: number) => Math.round(pounds * 100);
const pay = (paid_on: string, pounds: number): Pick<Payment, 'paid_on' | 'amount_pence'> => ({ paid_on, amount_pence: gbp(pounds) });
const none = (): Pick<TaxYear, 'extra_takings_pence' | 'expenses_pence'> => ({ extra_takings_pence: 0, expenses_pence: 0 });

describe('which tax year a month is in', () => {
  it('a month after April is in the tax year that started that April', () => {
    expect(monthTaxParts('2026-11')).toEqual([{ taxYearStart: 2026, from: '2026-11-01', to: '2026-11-30' }]);
  });
  it('January to March end the tax year that started the April before', () => {
    expect(monthTaxParts('2027-02')).toEqual([{ taxYearStart: 2026, from: '2027-02-01', to: '2027-02-28' }]);
    expect(monthTaxParts('2028-02')).toEqual([{ taxYearStart: 2027, from: '2028-02-01', to: '2028-02-29' }]);
  });
  it('April is split: 1 to 5 April end one tax year, the 6th starts the next', () => {
    expect(monthTaxParts('2027-04')).toEqual([
      { taxYearStart: 2026, from: '2027-04-01', to: '2027-04-05' },
      { taxYearStart: 2027, from: '2027-04-06', to: '2027-04-30' },
    ]);
  });
});

describe('how much some takings add to the tax year’s estimate', () => {
  const rise = (beforePounds: number, monthPounds: number, extra = 0, expenses = 0, year = 2026) => taxRise({
    taxYearStart: year, takingsBeforePence: gbp(beforePounds), takingsPence: gbp(monthPounds),
    extraTakingsPence: gbp(extra), expensesPence: gbp(expenses),
  });

  it('nothing while the profit stays under the £12,570 tax-free allowance', () => {
    // £8,000 + £2,480 of takings, less the £1,000 trading allowance: a profit of £9,480.
    expect(rise(8_000, 2_480)).toBe(0);
  });

  it('a month that takes the profit past £12,570: 26p of each £1 above it, far more than the year’s average share', () => {
    // Profit £11,000 before the month (£12,000 takings less £1,000), £13,480 after: £910 is taxed.
    const amount = rise(12_000, 2_480);
    expect(amount).toBeCloseTo(gbp(910 * 0.26), 6); // £236.60
    // The rise is exactly the estimate after the month minus the estimate before it.
    const est = (pounds: number) => estimateTax({ taxYearStart: 2026, takingsPence: gbp(pounds) }).total;
    expect(amount).toBeCloseTo(est(14_480) - est(12_000), 6);
    // This month's takings × the year's average share would put aside about £40.
    const averageShare = gbp(2_480) * (est(14_480) / gbp(14_480));
    expect(Math.round(averageShare / 100)).toBe(41);
    expect(amount).toBeGreaterThan(5 * averageShare);
  });

  it('with £15,000 of profit already, November’s £2,480 adds £645: the average share would put aside under £200', () => {
    // £16,000 of takings less the £1,000 trading allowance: £15,000 of profit before November.
    const amount = rise(16_000, 2_480);
    expect(Math.round(amount / 100)).toBe(645);
    // The year's average share of tax, even counted at the end of November, times November's takings.
    const est = (pounds: number) => estimateTax({ taxYearStart: 2026, takingsPence: gbp(pounds) }).total;
    expect(Math.round((gbp(2_480) * (est(18_480) / gbp(18_480))) / 100)).toBe(171);
  });

  it('a month that crosses the £50,270 higher-rate threshold: 26p of each £1 below it and 42p above', () => {
    // Profit £49,000 before, £52,000 after.
    expect(rise(50_000, 3_000)).toBeCloseTo(gbp(1_270 * 0.26 + 1_730 * 0.42), 6); // £1,056.80
  });

  it('her own figures count from the start of the year: takings before the app, and expenses', () => {
    // £14,000 taken through another app, £2,000 of expenses: a profit of £12,000 before the app's first £1,500.
    expect(rise(0, 1_500, 14_000, 2_000)).toBeCloseTo(gbp(930 * 0.26), 6); // £13,500 − £12,570 = £930
    // Without them it looks tax-free.
    expect(rise(0, 1_500)).toBe(0);
  });

  it('refunds that outweigh the takings never give a negative amount', () => {
    expect(rise(20_000, -300)).toBe(0);
  });
});

describe('a month’s takings and what to put aside from them', () => {
  it('November: the tax year’s takings before it count, the year before’s and later months don’t', () => {
    const payments = [
      pay('2026-03-20', 40_000), // the tax year before: ignored
      pay('2026-04-06', 6_000), pay('2026-08-15', 6_000), // £12,000 before November
      pay('2026-11-02', 1_500), pay('2026-11-20', 1_000), pay('2026-11-28', -20), // November: £2,480 after a refund
      pay('2026-12-01', 5_000), // after November: ignored
    ];
    const { takingsPence, putAsidePence } = monthPutAside('2026-11', payments, none);
    expect(takingsPence).toBe(gbp(2_480));
    expect(putAsidePence).toBeCloseTo(gbp(910 * 0.26), 6);
  });

  it('the current month: what’s been taken so far', () => {
    const { takingsPence, putAsidePence } = monthPutAside('2026-11', [pay('2026-06-01', 16_000), pay('2026-11-03', 310)], none);
    expect(takingsPence).toBe(gbp(310));
    expect(putAsidePence).toBeCloseTo(gbp(310 * 0.26), 6);
  });

  it('uses the saved figures for the month’s own tax year', () => {
    const figures = (year: number) => (year === 2026 ? { extra_takings_pence: gbp(14_000), expenses_pence: gbp(2_000) } : none());
    const { putAsidePence } = monthPutAside('2026-11', [pay('2026-11-10', 1_500)], figures);
    expect(putAsidePence).toBeCloseTo(gbp(930 * 0.26), 6);
  });

  it('April: 1 to 5 April add to the old tax year’s estimate, the rest to the new one’s', () => {
    const payments = [
      pay('2026-04-10', 20_000), // the old tax year (2026–27), well over the allowance
      pay('2027-04-02', 500), // 1 to 5 April: the end of 2026–27, at 26p
      pay('2027-04-20', 2_000), // the start of 2027–28: under its allowances, nothing yet
    ];
    const { takingsPence, putAsidePence } = monthPutAside('2027-04', payments, none);
    expect(takingsPence).toBe(gbp(2_500));
    expect(putAsidePence).toBeCloseTo(gbp(500 * 0.26), 6);
  });

  it('over a whole year the months add up to the year’s estimate: £30,000 of profit earned evenly gives £4,532', () => {
    // £31,000 of takings (£30,000 of profit after the £1,000 allowance), the same each month.
    const months = ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11', '2026-12', '2027-01', '2027-02', '2027-03'];
    const payments = months.map((m) => pay(`${m}-${m === '2026-04' ? '06' : '15'}`, 31_000 / 12));
    const monthly = months.map((m) => monthPutAside(m, payments, none).putAsidePence);
    const year = estimateTax({ taxYearStart: 2026, takingsPence: payments.reduce((n, p) => n + p.amount_pence, 0) }).total;
    expect(Math.round(year / 100)).toBe(4_532);
    expect(monthly.reduce((n, p) => n + p, 0)).toBeCloseTo(year, 4);
    // Nothing for the first months, then 26p of each £1 once the profit is past £12,570.
    expect(monthly.slice(0, 4).every((p) => p === 0)).toBe(true);
    expect(Math.round(monthly[11] / 100)).toBe(Math.round((31_000 / 12) * 0.26));
  });
});

describe('Today’s tax card opens Money on its tax year', () => {
  it('reads ?taxyear=2025, and ignores anything else', () => {
    expect(linkedTaxYear('2025')).toBe(2025);
    for (const bad of [null, '', 'abc', '1999', '2101', '20255', '2025.5', ' 2025']) expect(linkedTaxYear(bad)).toBeNull();
  });
});
