// A rough Self Assessment estimate for a sole trader whose only income is the
// business: Income Tax on the profit above the tax-free personal allowance,
// plus Class 4 National Insurance, at the rates for England, Wales and
// Northern Ireland. Class 2 isn't added: since 6 April 2024 it isn't payable on
// profits above the small profits threshold (it's treated as paid), and below
// that it's voluntary. All money is in pence.

export interface TaxRates {
  /** "2026–27" */
  label: string;
  personalAllowance: number;
  /** The allowance shrinks by £1 for every £2 of income above this. */
  taperFrom: number;
  /** Size of the 20% band, above the allowance. */
  basicBand: number;
  /** Taxable income above this pays the additional rate. */
  additionalFrom: number;
  basicRate: number;
  higherRate: number;
  additionalRate: number;
  class4Lower: number;
  class4Upper: number;
  class4Main: number;
  class4Above: number;
}

const ENGLAND_2024_ON = {
  personalAllowance: 1_257_000,
  taperFrom: 10_000_000,
  basicBand: 3_770_000,
  additionalFrom: 12_514_000,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  class4Lower: 1_257_000,
  class4Upper: 5_027_000,
  class4Main: 0.06,
  class4Above: 0.02,
};

/** Rates by the year the tax year starts (6 April). The thresholds are frozen, so these three match. */
export const TAX_RATES: Record<number, TaxRates> = {
  2024: { label: '2024–25', ...ENGLAND_2024_ON },
  2025: { label: '2025–26', ...ENGLAND_2024_ON },
  2026: { label: '2026–27', ...ENGLAND_2024_ON },
};

const KNOWN_YEARS = Object.keys(TAX_RATES).map(Number).sort((a, b) => a - b);

/** The rates for a tax year, or the nearest year we have (flagged, so the screen can say so). */
export function ratesFor(startYear: number): { rates: TaxRates; exact: boolean } {
  if (TAX_RATES[startYear]) return { rates: TAX_RATES[startYear], exact: true };
  const nearest = startYear > KNOWN_YEARS[KNOWN_YEARS.length - 1] ? KNOWN_YEARS[KNOWN_YEARS.length - 1] : KNOWN_YEARS[0];
  return { rates: TAX_RATES[nearest], exact: false };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Income Tax on a year's income, when it is the person's only income. */
export function incomeTaxOn(income: number, r: TaxRates): number {
  if (income <= 0) return 0;
  const allowance = Math.max(0, r.personalAllowance - Math.floor(Math.max(0, income - r.taperFrom) / 2));
  const taxable = Math.max(0, income - allowance);
  const basic = Math.min(taxable, r.basicBand);
  const higher = clamp(taxable - r.basicBand, 0, r.additionalFrom - r.basicBand);
  const additional = Math.max(0, taxable - r.additionalFrom);
  return basic * r.basicRate + higher * r.higherRate + additional * r.additionalRate;
}

/** Class 4 National Insurance on a year's trading profit. */
export function class4On(profit: number, r: TaxRates): number {
  const main = clamp(profit - r.class4Lower, 0, r.class4Upper - r.class4Lower);
  const above = Math.max(0, profit - r.class4Upper);
  return main * r.class4Main + above * r.class4Above;
}

export interface TaxEstimate {
  takings: number;
  profit: number;
  incomeTax: number;
  class4: number;
  total: number;
  /** total ÷ takings, 0–1 (0 when there are no takings). */
  shareOfTakings: number;
  /** Tax on the next £1 of profit, 0–1: what to put aside from each new payment. */
  marginalRate: number;
  rates: TaxRates;
  /** false when this tax year's rates aren't known and the nearest year's were used. */
  exactRates: boolean;
}

/**
 * The estimate for a tax year so far. Takings are the money received (net of
 * refunds); expenses are taken off to give the profit, which never goes below 0.
 * Pence in, pence out (not rounded; round for display).
 */
export function estimateTax({ taxYearStart, takingsPence, expensesPence = 0 }: {
  taxYearStart: number; takingsPence: number; expensesPence?: number;
}): TaxEstimate {
  const { rates, exact } = ratesFor(taxYearStart);
  const takings = Math.max(0, takingsPence);
  const profit = Math.max(0, takings - Math.max(0, expensesPence));
  const incomeTax = incomeTaxOn(profit, rates);
  const class4 = class4On(profit, rates);
  const total = incomeTax + class4;
  const step = 10_000; // the next £100, so pence rounding doesn't show
  const marginalRate = (incomeTaxOn(profit + step, rates) + class4On(profit + step, rates) - total) / step;
  return {
    takings, profit, incomeTax, class4, total,
    shareOfTakings: takings > 0 ? total / takings : 0,
    marginalRate, rates, exactRates: exact,
  };
}

/** When a tax year's Self Assessment bill is due, and the payments on account that can come with it. */
export function taxDates(taxYearStart: number) {
  const due = taxYearStart + 2;
  return {
    /** Return filed online and the bill paid by this date. */
    balancing: `31 January ${due}`,
    /** Payments on account towards the next tax year, when the bill is over £1,000. */
    nextYearFirst: `31 January ${due}`,
    nextYearSecond: `31 July ${due}`,
    /** If she already makes payments on account, these went towards this tax year. */
    thisYearFirst: `31 January ${due - 1}`,
    thisYearSecond: `31 July ${due - 1}`,
  };
}

/** HMRC asks for payments on account when the bill is over this. */
export const PAYMENTS_ON_ACCOUNT_FROM = 100_000;

/**
 * Making Tax Digital for Income Tax: qualifying income (turnover) in a tax year
 * over the threshold for that year means quarterly digital updates from the
 * April a year after it ends. 2024–25 over £50,000 → April 2026; 2025–26 over
 * £30,000 → April 2027; 2026–27 (and later) over £20,000 → April 2028 (and later).
 */
export function makingTaxDigital(taxYearStart: number, takingsPence: number): { threshold: number; fromYear: number } | null {
  if (taxYearStart < 2024) return null;
  const threshold = taxYearStart === 2024 ? 5_000_000 : taxYearStart === 2025 ? 3_000_000 : 2_000_000;
  return takingsPence > threshold ? { threshold, fromYear: taxYearStart + 2 } : null;
}
