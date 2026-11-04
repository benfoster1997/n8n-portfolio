import { describe, expect, it } from 'vitest';
import { estimateTax, makingTaxDigital, ratesFor, taxDates } from '../../src/lib/tax';

const gbp = (pounds: number) => Math.round(pounds * 100);
const est = (profitPounds: number, year = 2026) => estimateTax({ taxYearStart: year, takingsPence: gbp(profitPounds) });

describe('tax estimate (only income is the business, England 2026–27)', () => {
  it('owes nothing with no takings, or with refunds bigger than takings', () => {
    expect(est(0).total).toBe(0);
    expect(estimateTax({ taxYearStart: 2026, takingsPence: -5_000 }).total).toBe(0);
  });

  it('owes nothing up to the £12,570 tax-free allowance', () => {
    expect(est(10_000).total).toBe(0);
    expect(est(12_570).total).toBe(0);
    expect(est(10_000).marginalRate).toBe(0);
  });

  it('£18,000 profit: 20% Income Tax and 6% Class 4 on the £5,430 above the allowance', () => {
    const e = est(18_000);
    expect(e.incomeTax).toBeCloseTo(gbp(1_086), 6);
    expect(e.class4).toBeCloseTo(gbp(325.8), 6);
    expect(e.total).toBeCloseTo(gbp(1_411.8), 6);
    expect(e.marginalRate).toBeCloseTo(0.26, 10);
    expect(e.shareOfTakings).toBeCloseTo(1_411.8 / 18_000, 10);
  });

  it('£30,000 profit', () => {
    const e = est(30_000);
    expect(e.incomeTax).toBeCloseTo(gbp(3_486), 6);
    expect(e.class4).toBeCloseTo(gbp(1_045.8), 6);
  });

  it('£50,270 profit: the whole basic-rate band', () => {
    const e = est(50_270);
    expect(e.incomeTax).toBeCloseTo(gbp(7_540), 6);
    expect(e.class4).toBeCloseTo(gbp(2_262), 6);
  });

  it('£60,000 profit: 40% Income Tax and 2% Class 4 above £50,270', () => {
    const e = est(60_000);
    expect(e.incomeTax).toBeCloseTo(gbp(11_432), 6);
    expect(e.class4).toBeCloseTo(gbp(2_456.6), 6);
    expect(e.marginalRate).toBeCloseTo(0.42, 10);
  });

  it('£110,000 profit: the allowance shrinks by £1 for every £2 over £100,000', () => {
    const e = est(110_000);
    // allowance £7,570, so £102,430 is taxed: £37,700 at 20% and £64,730 at 40%
    expect(e.incomeTax).toBeCloseTo(gbp(33_432), 6);
    expect(e.class4).toBeCloseTo(gbp(3_456.6), 6);
    expect(e.marginalRate).toBeCloseTo(0.62, 10);
  });

  it('takes expenses off before working out the profit, never below zero', () => {
    expect(estimateTax({ taxYearStart: 2026, takingsPence: gbp(20_000), expensesPence: gbp(2_000) }).total).toBeCloseTo(est(18_000).total, 6);
    expect(estimateTax({ taxYearStart: 2026, takingsPence: gbp(1_000), expensesPence: gbp(2_000) }).profit).toBe(0);
  });

  it('uses the nearest known rates for a year it has no table for, and says so', () => {
    expect(ratesFor(2026).exact).toBe(true);
    const later = ratesFor(2030);
    expect(later.exact).toBe(false);
    expect(later.rates.label).toBe('2026–27');
    expect(est(18_000, 2030).exactRates).toBe(false);
  });
});

describe('tax dates', () => {
  it('a tax year’s bill is due on 31 January, nearly two years after it starts', () => {
    const d = taxDates(2026);
    expect(d.balancing).toBe('31 January 2028');
    expect(d.nextYearSecond).toBe('31 July 2028');
    expect(d.thisYearFirst).toBe('31 January 2027');
  });
});

describe('Making Tax Digital', () => {
  it('2026–27 takings over £20,000 bring it in from April 2028', () => {
    expect(makingTaxDigital(2026, gbp(25_000))).toEqual({ threshold: gbp(20_000), fromYear: 2028 });
    expect(makingTaxDigital(2026, gbp(20_000))).toBeNull();
  });
  it('2025–26 over £30,000 means April 2027; 2024–25 over £50,000 means April 2026', () => {
    expect(makingTaxDigital(2025, gbp(35_000))?.fromYear).toBe(2027);
    expect(makingTaxDigital(2025, gbp(25_000))).toBeNull();
    expect(makingTaxDigital(2024, gbp(55_000))?.fromYear).toBe(2026);
  });
});
