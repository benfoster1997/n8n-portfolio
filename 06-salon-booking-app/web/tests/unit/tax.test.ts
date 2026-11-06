import { describe, expect, it } from 'vitest';
import {
  dueFromEarlierYear, estimateTax, incomeTaxOn, longDate, makingTaxDigital, marginalRateAt, marginalRatesAt, mtdStage,
  PAYMENTS_ON_ACCOUNT_FROM, ratesFor, TAX_RATES, taxDates, taxYearDays, weekendDue, yearLabel,
} from '../../src/lib/tax';

// Every figure below is worked out by hand from the published rates: personal
// allowance £12,570, 20% on the next £37,700 (to £50,270), 40% to £125,140 and
// 45% above; Class 4 at 6% from £12,570 to £50,270 and 2% above; a £1,000
// trading allowance (2024–25 to 2026–27) and £3,000 announced for 2027–28.
const gbp = (pounds: number) => Math.round(pounds * 100);
/** The estimate when takings are the only figure: the £1,000 trading allowance comes off. */
const est = (takingsPounds: number, year = 2026) => estimateTax({ taxYearStart: year, takingsPence: gbp(takingsPounds) });
/** The estimate for a profit, with expenses that make the takings work out to it exactly. */
const forProfit = (profitPounds: number) =>
  estimateTax({ taxYearStart: 2026, takingsPence: gbp(profitPounds + 2_000), expensesPence: gbp(2_000) });

describe('the rate tables match the published figures', () => {
  it('2024–25 to 2026–27: frozen thresholds, 20/40/45%, Class 4 at 6% and 2%, a £1,000 trading allowance', () => {
    for (const year of [2024, 2025, 2026]) {
      const r = TAX_RATES[year];
      expect(r.label).toBe(yearLabel(year));
      expect(r.announced).toBeFalsy();
      expect(r.personalAllowance).toBe(gbp(12_570));
      expect(r.personalAllowance + r.basicBand).toBe(gbp(50_270));
      expect(r.additionalFrom).toBe(gbp(125_140));
      expect(r.taperFrom).toBe(gbp(100_000));
      // The allowance is all gone exactly where the additional rate starts.
      expect(r.taperFrom + 2 * r.personalAllowance).toBe(r.additionalFrom);
      expect([r.basicRate, r.higherRate, r.additionalRate]).toEqual([0.2, 0.4, 0.45]);
      expect([r.class4Lower, r.class4Upper, r.class4Main, r.class4Above]).toEqual([gbp(12_570), gbp(50_270), 0.06, 0.02]);
      expect(r.tradingAllowance).toBe(gbp(1_000));
    }
  });

  it('Class 2: the small profits threshold and voluntary weekly rate for each year', () => {
    expect([2024, 2025, 2026, 2027].map((y) => TAX_RATES[y].smallProfitsThreshold)).toEqual([gbp(6_725), gbp(6_845), gbp(7_105), gbp(7_355)]);
    expect([2024, 2025, 2026, 2027].map((y) => TAX_RATES[y].class2Weekly)).toEqual([345, 350, 365, 380]);
  });

  it('2027–28: the same Income Tax and Class 4, a £3,000 trading allowance, marked as announced', () => {
    const r = TAX_RATES[2027];
    expect(r.label).toBe('2027–28');
    expect(r.announced).toBe(true);
    expect(r.tradingAllowance).toBe(gbp(3_000));
    expect(r.personalAllowance).toBe(gbp(12_570));
    expect(r.personalAllowance + r.basicBand).toBe(gbp(50_270));
    expect([r.class4Main, r.class4Above]).toEqual([0.06, 0.02]);
  });
});

describe('tax estimate (the business is the only income, England 2026–27)', () => {
  it('no takings: nothing to pay', () => {
    const e = est(0);
    expect(e.total).toBe(0);
    expect(e.profit).toBe(0);
    expect(e.shareOfTakings).toBe(0);
    expect(e.marginalRate).toBe(0);
    expect(e.deductionKind).toBe('allowance');
    // Refunds bigger than the takings don't make a negative bill.
    expect(estimateTax({ taxYearStart: 2026, takingsPence: -5_000 }).total).toBe(0);
  });

  it('takings under the £1,000 trading allowance are tax-free', () => {
    for (const pounds of [800, 1_000]) {
      const e = est(pounds);
      expect(e.deduction).toBe(gbp(1_000));
      expect(e.profit).toBe(0);
      expect(e.total).toBe(0);
    }
  });

  it('profit under the £12,570 personal allowance: nothing to pay, and nothing on the next £1 yet', () => {
    const e = est(10_000); // £9,000 profit after the trading allowance
    expect(e.profit).toBe(gbp(9_000));
    expect(e.total).toBe(0);
    expect(e.marginalRate).toBe(0);
  });

  it('profit exactly at the personal allowance: still nothing, but the next £1 pays 20% + 6%', () => {
    const e = est(13_570);
    expect(e.profit).toBe(gbp(12_570));
    expect(e.total).toBe(0);
    expect(e.marginalRate).toBeCloseTo(0.26, 10);
  });

  it('profit £100 over the allowance: £20 Income Tax and £6 Class 4', () => {
    const e = est(13_670);
    expect(e.profit).toBe(gbp(12_670));
    expect(e.incomeTax).toBeCloseTo(gbp(20), 6);
    expect(e.class4).toBeCloseTo(gbp(6), 6);
    expect(e.total).toBeCloseTo(gbp(26), 6);
  });

  it('£18,000 profit: 20% Income Tax and 6% Class 4 on the £5,430 above the allowance', () => {
    const e = est(19_000);
    expect(e.profit).toBe(gbp(18_000));
    expect(e.incomeTax).toBeCloseTo(gbp(1_086), 6);
    expect(e.class4).toBeCloseTo(gbp(325.8), 6);
    expect(e.total).toBeCloseTo(gbp(1_411.8), 6);
    expect(e.marginalRate).toBeCloseTo(0.26, 10);
    expect(e.shareOfTakings).toBeCloseTo(1_411.8 / 19_000, 10);
  });

  it('£30,000 profit', () => {
    const e = forProfit(30_000);
    expect(e.profit).toBe(gbp(30_000));
    expect(e.incomeTax).toBeCloseTo(gbp(3_486), 6);
    expect(e.class4).toBeCloseTo(gbp(1_045.8), 6);
    expect(e.total).toBeCloseTo(gbp(4_531.8), 6);
  });

  it('profit exactly at the £50,270 higher-rate threshold: the whole basic-rate band; the next £1 pays 40% + 2%', () => {
    const e = forProfit(50_270);
    expect(e.incomeTax).toBeCloseTo(gbp(7_540), 6);
    expect(e.class4).toBeCloseTo(gbp(2_262), 6);
    expect(e.marginalRate).toBeCloseTo(0.42, 10);
  });

  it('£60,000 profit, crossing the higher-rate threshold: 40% Income Tax and 2% Class 4 on the £9,730 above it', () => {
    const e = forProfit(60_000);
    expect(e.incomeTax).toBeCloseTo(gbp(11_432), 6);
    expect(e.class4).toBeCloseTo(gbp(2_456.6), 6);
    expect(e.total).toBeCloseTo(gbp(13_888.6), 6);
    expect(e.marginalRate).toBeCloseTo(0.42, 10);
  });

  it('£110,000 profit: the allowance shrinks by £1 for every £2 over £100,000, so the next £1 pays 62p', () => {
    const e = forProfit(110_000);
    // allowance £7,570, so £102,430 is taxed: £37,700 at 20% and £64,730 at 40%
    expect(e.incomeTax).toBeCloseTo(gbp(33_432), 6);
    expect(e.class4).toBeCloseTo(gbp(3_456.6), 6);
    expect(e.marginalRate).toBeCloseTo(0.62, 10);
  });

  it('£125,140 and over: no allowance left, and 45% above £125,140', () => {
    expect(forProfit(125_140).incomeTax).toBeCloseTo(gbp(42_516), 6);
    const e = forProfit(130_000);
    // £37,700 at 20% + £87,440 at 40% + £4,860 at 45%
    expect(e.incomeTax).toBeCloseTo(gbp(44_703), 6);
    expect(e.class4).toBeCloseTo(gbp(3_856.6), 6);
    expect(e.marginalRate).toBeCloseTo(0.47, 10);
    expect(incomeTaxOn(gbp(125_140), TAX_RATES[2026]) + gbp(0.45)).toBeCloseTo(incomeTaxOn(gbp(125_141), TAX_RATES[2026]), 6);
  });

  it('expenses smaller than the trading allowance: the allowance is used instead', () => {
    const e = estimateTax({ taxYearStart: 2026, takingsPence: gbp(20_000), expensesPence: gbp(600) });
    expect(e.deductionKind).toBe('allowance');
    expect(e.deduction).toBe(gbp(1_000));
    expect(e.expenses).toBe(gbp(600));
    expect(e.profit).toBe(gbp(19_000));
    expect(e.incomeTax).toBeCloseTo(gbp(1_286), 6);
    expect(e.class4).toBeCloseTo(gbp(385.8), 6);
    expect(e.total).toBeCloseTo(gbp(1_671.8), 6);
  });

  it('expenses bigger than the trading allowance: the expenses are used, never both', () => {
    const e = estimateTax({ taxYearStart: 2026, takingsPence: gbp(20_000), expensesPence: gbp(2_500) });
    expect(e.deductionKind).toBe('expenses');
    expect(e.deduction).toBe(gbp(2_500));
    expect(e.profit).toBe(gbp(17_500));
    expect(e.incomeTax).toBeCloseTo(gbp(986), 6);
    expect(e.class4).toBeCloseTo(gbp(295.8), 6);
    expect(e.total).toBeCloseTo(gbp(1_281.8), 6);
    // Exactly £1,000 of expenses: the same either way, and her own figure is shown.
    expect(estimateTax({ taxYearStart: 2026, takingsPence: gbp(20_000), expensesPence: gbp(1_000) }).deductionKind).toBe('expenses');
  });

  it('expenses bigger than the takings: no profit, nothing to pay', () => {
    const e = estimateTax({ taxYearStart: 2026, takingsPence: gbp(3_000), expensesPence: gbp(4_000) });
    expect(e.deductionKind).toBe('expenses');
    expect(e.profit).toBe(0);
    expect(e.total).toBe(0);
    expect(e.marginalRate).toBe(0);
  });

  it('adds the takings not recorded in the app, and refunds still count against them', () => {
    const e = estimateTax({ taxYearStart: 2026, takingsPence: gbp(15_000), extraTakingsPence: gbp(4_000) });
    expect(e.totalTakings).toBe(gbp(19_000));
    expect(e.total).toBeCloseTo(est(19_000).total, 6);
    expect(e.shareOfTakings).toBeCloseTo(1_411.8 / 19_000, 10);
    expect(estimateTax({ taxYearStart: 2026, takingsPence: gbp(-50), extraTakingsPence: gbp(5_000) }).totalTakings).toBe(gbp(4_950));
  });

  it('2027–28 uses the £3,000 trading allowance', () => {
    const e = estimateTax({ taxYearStart: 2027, takingsPence: gbp(21_000), expensesPence: gbp(2_000) });
    expect(e.exactRates).toBe(true);
    expect(e.deductionKind).toBe('allowance');
    expect(e.profit).toBe(gbp(18_000));
    expect(e.total).toBeCloseTo(gbp(1_411.8), 6);
  });

  it('a tax year it has no table for uses the nearest year’s rates, and says so', () => {
    expect(ratesFor(2026)).toMatchObject({ year: 2026, exact: true });
    const later = estimateTax({ taxYearStart: 2030, takingsPence: gbp(21_000) });
    expect(later.exactRates).toBe(false);
    expect(later.ratesYear).toBe(2027);
    expect(later.rates.label).toBe('2027–28');
    expect(later.profit).toBe(gbp(18_000)); // with 2027–28’s £3,000 allowance
    expect(later.total).toBeCloseTo(gbp(1_411.8), 6);
    expect(ratesFor(2019)).toMatchObject({ year: 2024, exact: false });
  });

  it('the rate on the next £1 of profit, at each threshold', () => {
    const r = TAX_RATES[2026];
    expect(marginalRateAt(gbp(12_569), r)).toBe(0); // the next £1 only reaches the allowance
    // Just under a threshold it's the rate there, not a blend of the two.
    expect(marginalRateAt(gbp(12_569.5), r)).toBe(0);
    expect(marginalRateAt(gbp(50_269.5), r)).toBe(0.26);
    expect(marginalRateAt(gbp(99_999.5), r)).toBe(0.42);
    expect(marginalRateAt(gbp(125_139.5), r)).toBe(0.62);
    expect(marginalRateAt(gbp(12_570), r)).toBeCloseTo(0.26, 10);
    expect(marginalRateAt(gbp(50_269), r)).toBeCloseTo(0.26, 10);
    expect(marginalRateAt(gbp(50_270), r)).toBeCloseTo(0.42, 10);
    expect(marginalRateAt(gbp(99_999), r)).toBeCloseTo(0.42, 10);
    expect(marginalRateAt(gbp(100_000), r)).toBeCloseTo(0.62, 10);
    expect(marginalRateAt(gbp(125_140), r)).toBeCloseTo(0.47, 10);
  });

  it('the next £1’s rate, split into Income Tax and Class 4', () => {
    const r = TAX_RATES[2026];
    expect(marginalRatesAt(gbp(10_000), r)).toEqual({ incomeTax: 0, class4: 0 });
    expect(marginalRatesAt(gbp(12_570), r)).toEqual({ incomeTax: 0.2, class4: 0.06 });
    expect(marginalRatesAt(gbp(60_000), r)).toEqual({ incomeTax: 0.4, class4: 0.02 });
    expect(marginalRatesAt(gbp(110_000), r)).toEqual({ incomeTax: 0.6, class4: 0.02 });
    expect(marginalRatesAt(gbp(130_000), r)).toEqual({ incomeTax: 0.45, class4: 0.02 });
  });
});

describe('when it’s paid', () => {
  it('a tax year’s bill is due on 31 January, nearly two years after it starts', () => {
    const d = taxDates(2026);
    expect(d.balancing).toEqual({ iso: '2028-01-31', label: '31 January 2028' });
    // Towards 2027–28, each half of this bill: on top of it in January, then in July.
    expect(d.nextYear).toEqual({ first: { iso: '2028-01-31', label: '31 January 2028' }, second: { iso: '2028-07-31', label: '31 July 2028' } });
    // If she already makes them, these went towards this bill.
    expect(d.thisYear).toEqual({ first: { iso: '2027-01-31', label: '31 January 2027' }, second: { iso: '2027-07-31', label: '31 July 2027' } });
    expect(taxDates(2025).balancing.label).toBe('31 January 2027');
    expect(taxYearDays(2026)).toEqual({ first: '2026-04-06', last: '2027-04-05' });
    expect(longDate('2027-07-31')).toBe('31 July 2027');
  });

  it('payments on account start at a bill of £1,000, and HMRC plans to replace them from April 2029', () => {
    expect(PAYMENTS_ON_ACCOUNT_FROM).toBe(gbp(1_000));
    // 2027–28's bill still brings the old kind towards 2028–29 (January and July 2029)…
    expect(taxDates(2027).nextYear?.second.label).toBe('31 July 2029');
    // …but from 2029–30 the payments come during the year instead, with no set dates yet.
    expect(taxDates(2028).nextYear).toBeNull();
    expect(taxDates(2028).thisYear?.second.label).toBe('31 July 2029');
    expect(taxDates(2029).thisYear).toBeNull();
  });

  it('a due date at a weekend: the safe day to pay is the Friday before', () => {
    expect(weekendDue('2027-01-31')).toEqual({ day: 'Sunday', friday: 'Friday 29 January' });
    expect(weekendDue('2027-07-31')).toEqual({ day: 'Saturday', friday: 'Friday 30 July' });
    expect(weekendDue('2026-01-31')).toEqual({ day: 'Saturday', friday: 'Friday 30 January' });
    expect(weekendDue('2028-01-31')).toBeNull(); // a Monday
    expect(weekendDue('2028-07-31')).toBeNull(); // a Monday
  });

  it('this tax year’s card: what an earlier year still has due before this year’s own bill', () => {
    const d = (label: string) => expect.objectContaining({ label });
    // Until 31 January 2027: 2025–26's return and bill, and the payments on account towards 2026–27 that come with it.
    expect(dueFromEarlierYear(2026, '2026-11-05')).toEqual({
      kind: 'bill', billYear: 2025, date: d('31 January 2027'), onAccount: { first: d('31 January 2027'), second: d('31 July 2027') },
    });
    expect(dueFromEarlierYear(2026, '2027-01-31')).toMatchObject({ kind: 'bill', billYear: 2025 });
    // 1 February to 31 July: the second payment towards 2026–27, from the 2025–26 bill, on 2026–27's card and then 2027–28's.
    for (const [year, today] of [[2026, '2027-02-01'], [2026, '2027-04-05'], [2027, '2027-04-06'], [2027, '2027-07-31']] as const) {
      expect(dueFromEarlierYear(year, today)).toEqual({ kind: 'july', billYear: 2025, date: d('31 July 2027') });
    }
    // From 1 August: 2026–27's return and bill, due 31 January 2028.
    expect(dueFromEarlierYear(2027, '2027-08-01')).toMatchObject({ kind: 'bill', billYear: 2026, date: d('31 January 2028') });
    // Only on the card for the tax year that today is in.
    expect(dueFromEarlierYear(2025, '2026-11-05')).toBeNull();
    expect(dueFromEarlierYear(2027, '2026-11-05')).toBeNull();
    // The last July payment on account is towards 2028–29; after that, the return and bill only.
    expect(dueFromEarlierYear(2029, '2029-05-01')).toMatchObject({ kind: 'july', billYear: 2027, date: d('31 July 2029') });
    expect(dueFromEarlierYear(2029, '2029-11-05')).toMatchObject({ kind: 'bill', billYear: 2028, onAccount: null });
    expect(dueFromEarlierYear(2029, '2030-03-01')).toBeNull();
    expect(dueFromEarlierYear(2030, '2030-05-01')).toMatchObject({ kind: 'bill', billYear: 2029, date: d('31 January 2031'), onAccount: null });
  });
});

describe('Making Tax Digital', () => {
  it('the limits under current rules: £50,000 for 2024–25, £30,000 for 2025–26, then £20,000', () => {
    expect(mtdStage(2023)).toBeNull();
    expect(mtdStage(2024)).toEqual({ testYear: 2024, threshold: gbp(50_000), fromYear: 2026 });
    expect(mtdStage(2025)).toEqual({ testYear: 2025, threshold: gbp(30_000), fromYear: 2027 });
    expect(mtdStage(2026)).toEqual({ testYear: 2026, threshold: gbp(20_000), fromYear: 2028 });
    expect(mtdStage(2030)).toEqual({ testYear: 2030, threshold: gbp(20_000), fromYear: 2032 });
  });

  it('2026–27 takings over £20,000 bring it in from April 2028 at the latest: 2025–26 or 2024–25 could have brought it sooner', () => {
    expect(makingTaxDigital(2026, gbp(25_000))).toEqual({
      testYear: 2026, threshold: gbp(20_000), fromYear: 2028,
      earlier: [{ testYear: 2025, threshold: gbp(30_000), fromYear: 2027 }, { testYear: 2024, threshold: gbp(50_000), fromYear: 2026 }],
    });
    // Over the limit means more than it.
    expect(makingTaxDigital(2026, gbp(20_000))).toBeNull();
  });

  it('2025–26 over £30,000 means April 2027; 2024–25 over £50,000 means April 2026, with nothing sooner', () => {
    expect(makingTaxDigital(2025, gbp(35_000))).toMatchObject({ fromYear: 2027, earlier: [{ testYear: 2024 }] });
    expect(makingTaxDigital(2025, gbp(25_000))).toBeNull();
    expect(makingTaxDigital(2024, gbp(55_000))).toMatchObject({ fromYear: 2026, earlier: [] });
    expect(makingTaxDigital(2024, gbp(45_000))).toBeNull();
  });

  it('later years stay at £20,000 under current rules; years before 2024–25 don’t count', () => {
    expect(makingTaxDigital(2027, gbp(20_001))).toMatchObject({ threshold: gbp(20_000), fromYear: 2029 });
    expect(makingTaxDigital(2027, gbp(20_001))?.earlier.map((s) => s.testYear)).toEqual([2026, 2025, 2024]);
    expect(makingTaxDigital(2023, gbp(90_000))).toBeNull();
  });
});
