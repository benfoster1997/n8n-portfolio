// A rough Self Assessment estimate for a sole trader whose only income is the
// business, at the rates for England, Wales and Northern Ireland:
//
//   takings (recorded in the app, plus any taken before or outside it)
//   − her business expenses or the trading allowance, whichever is bigger (never both)
//   = profit (never below 0)
//   → Income Tax on the profit above the personal allowance (which shrinks above
//     £100,000), at the basic, higher and additional rates
//   + Class 4 National Insurance on the profit between the lower and upper profits
//     limits, and at the lower rate above that.
//
// Class 2 National Insurance isn't added. Since 6 April 2024 nobody has to pay it:
// on a profit at or above the small profits threshold it's treated as paid (the
// year still counts for the State Pension), and below that paying it is voluntary.
//
// All money is in pence. The maths is exact; round only for display.
import type { Payment, TaxYear } from './types';

/** A tax year's own figures before anything is saved for it. */
export const emptyTaxYear = (startYear: number): TaxYear =>
  ({ start_year: startYear, extra_takings_pence: 0, expenses_pence: 0, updated_at: null });

/** The most either of her figures can be, as the table's checks allow: £1,000,000. */
export const TAX_YEAR_MAX_PENCE = 100_000_000;

export interface TaxRates {
  /** "2026–27" */
  label: string;
  /** Announced but not law yet: the screen says so. */
  announced?: boolean;
  /** Taken off the takings instead of the expenses when it's bigger (never both). */
  tradingAllowance: number;
  personalAllowance: number;
  /** The personal allowance shrinks by £1 for every £2 of income above this, to nothing. */
  taperFrom: number;
  /** Size of the 20% band, above the personal allowance. */
  basicBand: number;
  /** Taxable income above this pays the additional rate. */
  additionalFrom: number;
  basicRate: number;
  higherRate: number;
  additionalRate: number;
  /** Class 4: the main rate between the lower and upper profits limits, the lower rate above. */
  class4Lower: number;
  class4Upper: number;
  class4Main: number;
  class4Above: number;
  /** Class 2 counts as paid on a profit at or above this; below it, paying is voluntary. */
  smallProfitsThreshold: number;
  /** The voluntary Class 2 rate, per week. Never added to the estimate. */
  class2Weekly: number;
}

/** "2026–27" for the tax year starting 6 April 2026. */
export const yearLabel = (startYear: number) => `${startYear}–${String((startYear + 1) % 100).padStart(2, '0')}`;

// Income Tax and Class 4 for trading income. The thresholds are frozen until
// 5 April 2031 (Budget 2025) and Budget 2026 left these rates unchanged.
const FROZEN = {
  personalAllowance: 1_257_000,
  taperFrom: 10_000_000,
  basicBand: 3_770_000, // so 40% starts above £50,270 with the full allowance
  additionalFrom: 12_514_000,
  basicRate: 0.2,
  higherRate: 0.4,
  additionalRate: 0.45,
  class4Lower: 1_257_000,
  class4Upper: 5_027_000,
  class4Main: 0.06, // 6% for the whole of 2024–25 onwards
  class4Above: 0.02,
};

/** Rates by the year the tax year starts (6 April). */
export const TAX_RATES: Record<number, TaxRates> = {
  2024: { label: yearLabel(2024), ...FROZEN, tradingAllowance: 100_000, smallProfitsThreshold: 672_500, class2Weekly: 345 },
  2025: { label: yearLabel(2025), ...FROZEN, tradingAllowance: 100_000, smallProfitsThreshold: 684_500, class2Weekly: 350 },
  2026: { label: yearLabel(2026), ...FROZEN, tradingAllowance: 100_000, smallProfitsThreshold: 710_500, class2Weekly: 365 },
  // Announced in the Budget of 28 October 2026, not law yet: the trading allowance
  // rises to £3,000 (Finance Bill 2026–27); the Class 2 figures need regulations in early 2027.
  2027: {
    label: yearLabel(2027), ...FROZEN, tradingAllowance: 300_000, smallProfitsThreshold: 735_500, class2Weekly: 380,
    announced: true,
  },
};

const KNOWN_YEARS = Object.keys(TAX_RATES).map(Number).sort((a, b) => a - b);

/**
 * The rates for a tax year, or the nearest year the app has (the latest for a
 * later year, the earliest for an earlier one), flagged so the screen can say so.
 */
export function ratesFor(startYear: number): { rates: TaxRates; year: number; exact: boolean } {
  if (TAX_RATES[startYear]) return { rates: TAX_RATES[startYear], year: startYear, exact: true };
  const year = startYear > KNOWN_YEARS[KNOWN_YEARS.length - 1] ? KNOWN_YEARS[KNOWN_YEARS.length - 1] : KNOWN_YEARS[0];
  return { rates: TAX_RATES[year], year, exact: false };
}

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Income Tax on a year's income, when it is the person's only income. */
export function incomeTaxOn(income: number, r: TaxRates): number {
  if (income <= 0) return 0;
  // £1 of allowance goes for every £2 of income over £100,000: none is left at £125,140.
  const allowance = Math.max(0, r.personalAllowance - Math.max(0, income - r.taperFrom) / 2);
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

/**
 * Income Tax and Class 4 on the next pound of profit, each 0–1. Measured on the next
 * penny (profit is always whole pence), so just below a threshold it's the rate
 * that applies there, not a blend of the two.
 */
export function marginalRatesAt(profit: number, r: TaxRates): { incomeTax: number; class4: number } {
  const p = Math.max(0, profit);
  // Rounded so floating-point noise on figures this big never shows as 61.9999…%.
  const next = (on: (n: number, r: TaxRates) => number) => Math.round((on(p + 1, r) - on(p, r)) * 1e6) / 1e6;
  return { incomeTax: next(incomeTaxOn), class4: next(class4On) };
}

/** Income Tax plus Class 4 on the next pound of profit, 0–1 (see marginalRatesAt). */
export function marginalRateAt(profit: number, r: TaxRates): number {
  const { incomeTax, class4 } = marginalRatesAt(profit, r);
  return Math.round((incomeTax + class4) * 1e6) / 1e6;
}

export interface TaxEstimate {
  /** Takings recorded in the app: money received, net of refunds (can be below 0). */
  takings: number;
  /** Takings not recorded in the app, e.g. bookings taken through another app before switching. */
  extraTakings: number;
  /** The two together, never below 0. Making Tax Digital goes on this, before expenses. */
  totalTakings: number;
  /** Her business expenses, as entered. */
  expenses: number;
  /** What comes off the takings: her expenses or the trading allowance, whichever is bigger. */
  deduction: number;
  /** 'allowance' when the trading allowance was bigger than her expenses, so it was used instead. */
  deductionKind: 'expenses' | 'allowance';
  /** totalTakings − deduction, never below 0. */
  profit: number;
  incomeTax: number;
  class4: number;
  total: number;
  /** total ÷ totalTakings, 0–1 (0 when there are no takings). */
  shareOfTakings: number;
  /** Tax on the next £1 of profit, 0–1: what to put aside from each new £1 she takes. */
  marginalRate: number;
  rates: TaxRates;
  /** The tax year whose rates were used (the year it starts). */
  ratesYear: number;
  /** false when the app has no rates for this tax year and used the nearest year's. */
  exactRates: boolean;
}

/**
 * The estimate for a tax year so far. Pence in, pence out (not rounded; round
 * for display). Negative extra takings or expenses count as 0.
 */
export function estimateTax({ taxYearStart, takingsPence, extraTakingsPence = 0, expensesPence = 0 }: {
  taxYearStart: number; takingsPence: number; extraTakingsPence?: number; expensesPence?: number;
}): TaxEstimate {
  const { rates, year, exact } = ratesFor(taxYearStart);
  const extraTakings = Math.max(0, extraTakingsPence);
  const expenses = Math.max(0, expensesPence);
  const totalTakings = Math.max(0, takingsPence + extraTakings);
  // Either the expenses or the trading allowance, never both: whichever leaves the smaller profit.
  const deductionKind = rates.tradingAllowance > expenses ? 'allowance' : 'expenses';
  const deduction = deductionKind === 'allowance' ? rates.tradingAllowance : expenses;
  const profit = Math.max(0, totalTakings - deduction);
  const incomeTax = incomeTaxOn(profit, rates);
  const class4 = class4On(profit, rates);
  const total = incomeTax + class4;
  return {
    takings: takingsPence, extraTakings, totalTakings, expenses, deduction, deductionKind, profit,
    incomeTax, class4, total,
    shareOfTakings: totalTakings > 0 ? total / totalTakings : 0,
    marginalRate: marginalRateAt(profit, rates),
    rates, ratesYear: year, exactRates: exact,
  };
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2028-01-31" → "31 January 2028". */
export const longDate = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};

/** A date to show, and the same date as yyyy-mm-dd to compare with today. */
export interface TaxDate { iso: string; label: string }
const on = (iso: string): TaxDate => ({ iso, label: longDate(iso) });

/** A tax year's first and last days, as yyyy-mm-dd. */
export const taxYearDays = (taxYearStart: number) => ({ first: `${taxYearStart}-04-06`, last: `${taxYearStart + 1}-04-05` });

/**
 * From April 2029 (the 2029–30 tax year) HMRC plans to replace payments on account
 * with smaller automatic payments during the year (how often isn't decided yet).
 */
export const PAYMENTS_DURING_YEAR_FROM = 2029;

/**
 * When a tax year's Self Assessment bill is due, and the payments on account that
 * can come with it: two towards the next tax year, each half of this bill, and the
 * two that went towards this one if she already makes them.
 */
export function taxDates(taxYearStart: number): {
  /** The online return is due, and the bill is paid, by this date. */
  balancing: TaxDate;
  /** Payments on account towards the next tax year. Null once the next year is 2029–30 or later. */
  nextYear: { first: TaxDate; second: TaxDate } | null;
  /** Payments on account that went towards this tax year. Null from 2029–30, when they're paid during the year. */
  thisYear: { first: TaxDate; second: TaxDate } | null;
} {
  const due = taxYearStart + 2;
  return {
    balancing: on(`${due}-01-31`),
    nextYear: taxYearStart + 1 < PAYMENTS_DURING_YEAR_FROM ? { first: on(`${due}-01-31`), second: on(`${due}-07-31`) } : null,
    thisYear: taxYearStart < PAYMENTS_DURING_YEAR_FROM ? { first: on(`${due - 1}-01-31`), second: on(`${due - 1}-07-31`) } : null,
  };
}

/**
 * A due date at a weekend: the day it falls on, and the Friday before ("Friday 29 January").
 * HMRC says a payment due at a weekend has to reach it by the last working day before,
 * unless it's by Faster Payments or debit card (not checked independently; HMRC doesn't take
 * personal credit cards), so paying by that Friday is safe either way. 31 January and 31 July
 * are never bank holidays.
 */
export function weekendDue(iso: string): { day: 'Saturday' | 'Sunday'; friday: string } | null {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (weekday !== 0 && weekday !== 6) return null;
  const friday = new Date(Date.UTC(y, m - 1, d - (weekday === 0 ? 2 : 1)));
  return { day: weekday === 0 ? 'Sunday' : 'Saturday', friday: `Friday ${friday.getUTCDate()} ${MONTHS[friday.getUTCMonth()]}` };
}

/**
 * On the card for the tax year that today is in (null on any other): the next date
 * an earlier tax year still has money due, which that card doesn't otherwise show.
 * - 1 February to 31 July, while payments on account are still made: the second
 *   one, by 31 July, towards the year before, from the bill of the year before that.
 * - Otherwise, until the next 31 January: the tax return and bill for the year
 *   before this one, with the payments on account towards this year that can come
 *   with it (none once those are paid during the year instead, from 2029–30).
 */
export function dueFromEarlierYear(taxYearStart: number, today: string):
  | { kind: 'july'; billYear: number; date: TaxDate }
  | { kind: 'bill'; billYear: number; date: TaxDate; onAccount: { first: TaxDate; second: TaxDate } | null }
  | null {
  const days = taxYearDays(taxYearStart);
  if (today < days.first || today > days.last) return null;
  const year = Number(today.slice(0, 4));
  const monthDay = today.slice(5);
  const july = monthDay >= '02-01' && monthDay <= '07-31' ? taxDates(year - 2).nextYear : null;
  if (july) return { kind: 'july', billYear: year - 2, date: july.second };
  const before = taxDates(taxYearStart - 1);
  return today <= before.balancing.iso
    ? { kind: 'bill', billYear: taxYearStart - 1, date: before.balancing, onAccount: before.nextYear }
    : null;
}

/**
 * HMRC asks for payments on account when a bill is £1,000 or more: none are due
 * only when it's under £1,000, or when more than 80% of the tax was already taken
 * at source (e.g. through PAYE), which can't happen when the business is the only income.
 */
export const PAYMENTS_ON_ACCOUNT_FROM = 100_000;

/** Whole pounds, for an estimate: 141180p → 1412. */
export const wholePounds = (pence: number) => Math.round(pence / 100);

/**
 * A tax year's bill in whole pounds, as the cards show it (Income Tax and Class 4 each
 * rounded, so the rows add up as shown), and each payment on account towards the next
 * tax year: half the bill when it's £1,000 or more, otherwise 0.
 */
export function billInPounds(e: TaxEstimate): { bill: number; onAccount: number } {
  const bill = wholePounds(e.incomeTax) + wholePounds(e.class4);
  return { bill, onAccount: bill >= wholePounds(PAYMENTS_ON_ACCOUNT_FROM) ? wholePounds(e.total / 2) : 0 };
}

/** What Today says about tax: the January bill, or the July payment on account. */
export type TaxDueOnToday =
  | { kind: 'bill'; billYear: number; date: TaxDate; onAccount: { first: TaxDate; second: TaxDate } | null }
  | { kind: 'july'; billYear: number; date: TaxDate };

/**
 * What Today says about tax, only in the weeks before a due date so it doesn't nag:
 * - 1 December to 31 January: the return and bill for the tax year before this one,
 *   due 31 January, with the first payment on account towards the next tax year
 *   (when the bill is £1,000 or more, and while payments on account are still made).
 * - July: the second payment on account, due 31 July, half the bill of the tax year
 *   before last. None from 2030, once those are paid during the year instead.
 * Null the rest of the year. `today` is yyyy-mm-dd in the business's time zone.
 */
export function taxDueOnToday(today: string): TaxDueOnToday | null {
  const month = today.slice(5, 7);
  if (month !== '12' && month !== '01' && month !== '07') return null;
  const [y, m, d] = today.split('-').map(Number);
  const due = dueFromEarlierYear(m > 4 || (m === 4 && d >= 6) ? y : y - 1, today);
  if (!due) return null;
  return (due.kind === 'july') === (month === '07') ? due : null;
}

/**
 * The pounds behind Today's card, on her figures: in January the bill, plus the first
 * payment on account when there is one; in July the second payment on account (0 when
 * the bill is under £1,000, so nothing is due). Anything already paid towards the bill
 * year isn't known to the app, so it isn't taken off.
 */
export function poundsDueOnToday(due: TaxDueOnToday, e: TaxEstimate): { total: number; bill: number; onAccount: number } {
  const { bill, onAccount } = billInPounds(e);
  if (due.kind === 'july') return { total: onAccount, bill, onAccount };
  const first = due.onAccount ? onAccount : 0;
  return { total: bill + first, bill, onAccount: first };
}

/** The days of a month in each tax year it falls in: one part, or two for April (1 to 5 April end the tax year before). */
export function monthTaxParts(ym: string): { taxYearStart: number; from: string; to: string }[] {
  const [y, m] = ym.split('-').map(Number);
  const end = `${ym}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
  if (m === 4) return [{ taxYearStart: y - 1, from: `${ym}-01`, to: `${ym}-05` }, { taxYearStart: y, from: `${ym}-06`, to: end }];
  return [{ taxYearStart: m > 4 ? y : y - 1, from: `${ym}-01`, to: end }];
}

/**
 * How much some takings add to a tax year's estimate: the estimate with them, minus the
 * estimate without them, both with her own figures for the year. That's what to put aside
 * from them. Not the takings × the year's average share of tax: while the profit climbs
 * past the tax-free allowance, that puts aside far too little. Never below 0 (refunds).
 */
export function taxRise({ taxYearStart, takingsBeforePence, takingsPence, extraTakingsPence = 0, expensesPence = 0 }: {
  taxYearStart: number;
  /** The tax year's takings in the app before these. */
  takingsBeforePence: number;
  takingsPence: number;
  extraTakingsPence?: number;
  expensesPence?: number;
}): number {
  const at = (takings: number) => estimateTax({ taxYearStart, takingsPence: takings, extraTakingsPence, expensesPence }).total;
  return Math.max(0, at(takingsBeforePence + takingsPence) - at(takingsBeforePence));
}

/**
 * A month's takings in the app, and roughly how much of them to put aside for tax: the rise
 * in the tax year's estimate from the month, worked out with the year's takings up to the end
 * of the month, minus up to the end of the month before (for April, in each tax year it falls
 * in). `payments` must cover each tax year the month is in, from its 6 April to the month's
 * end; `figures` gives her own figures for a tax year (takings not in the app, expenses).
 */
export function monthPutAside(
  ym: string,
  payments: Pick<Payment, 'paid_on' | 'amount_pence'>[],
  figures: (taxYearStart: number) => Pick<TaxYear, 'extra_takings_pence' | 'expenses_pence'>,
): { takingsPence: number; putAsidePence: number } {
  const sum = (from: string, to: string) =>
    payments.reduce((n, p) => (p.paid_on >= from && p.paid_on <= to ? n + p.amount_pence : n), 0);
  let takingsPence = 0;
  let putAsidePence = 0;
  for (const part of monthTaxParts(ym)) {
    const yearStart = taxYearDays(part.taxYearStart).first;
    const month = sum(part.from, part.to);
    // Up to the end of the month before: from the tax year's first day to the day before this part.
    const before = part.from > yearStart ? sum(yearStart, dayBefore(part.from)) : 0;
    const f = figures(part.taxYearStart);
    takingsPence += month;
    putAsidePence += taxRise({
      taxYearStart: part.taxYearStart, takingsBeforePence: before, takingsPence: month,
      extraTakingsPence: f.extra_takings_pence, expensesPence: f.expenses_pence,
    });
  }
  return { takingsPence, putAsidePence };
}

/** "2026-11-01" → "2026-10-31". */
function dayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Making Tax Digital for Income Tax: takings (before expenses) in testYear over threshold → from 6 April fromYear. */
export interface MtdStage { testYear: number; threshold: number; fromYear: number }

/**
 * The Making Tax Digital limit a tax year's takings are tested against, under
 * current rules: 2024–25 over £50,000 → from April 2026; 2025–26 over £30,000 →
 * April 2027; 2026–27 and later years over £20,000 → the April a year after the
 * tax year ends. None before 2024–25.
 */
export function mtdStage(testYear: number): MtdStage | null {
  if (testYear < 2024) return null;
  const threshold = testYear === 2024 ? 5_000_000 : testYear === 2025 ? 3_000_000 : 2_000_000;
  return { testYear, threshold, fromYear: testYear + 2 };
}

/**
 * Whether a tax year's takings bring in Making Tax Digital. `earlier` lists the
 * stages for the years before it (latest first): any of those over its own limit
 * would have brought it in sooner, so this year's date is only the latest it can start.
 */
export function makingTaxDigital(taxYearStart: number, takingsPence: number): (MtdStage & { earlier: MtdStage[] }) | null {
  const stage = mtdStage(taxYearStart);
  if (!stage || takingsPence <= stage.threshold) return null;
  const earlier: MtdStage[] = [];
  for (let y = taxYearStart - 1; mtdStage(y); y--) earlier.push(mtdStage(y)!);
  return { ...stage, earlier };
}
