import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Icon, useLoad } from '../../components/ui';
import { estimateTax, poundsDueOnToday, taxYearDays, weekendDue, yearLabel, type TaxDueOnToday } from '../../lib/tax';
import { money } from '../../lib/text';
import { fmtDayLong } from '../../lib/time';
import type { TaxYear } from '../../lib/types';
import { Glyph } from './Clients';

/** Her figures for the year the bill is for: what she saved with Edit, and her takings in the app. */
export interface BillYearFigures {
  row: TaxYear;
  takingsPence: number;
  /** Whether anything at all is recorded in the app for that tax year. */
  hasTakings: boolean;
}

/**
 * Today's tax card, shown only in the weeks before a due date (taxDueOnToday). Her figures for
 * the bill's tax year are loaded only while it shows. Tapping it opens Money → Tax year on that year.
 */
export function TaxDueCard({ due, today }: { due: TaxDueOnToday; today: string }) {
  const { first, last } = taxYearDays(due.billYear);
  const { data, error, loading } = useLoad(async () => {
    const [row, payments] = await Promise.all([api.getTaxYear(due.billYear), api.listPayments(first, last)]);
    return { year: due.billYear, row, takingsPence: payments.reduce((n, p) => n + p.amount_pence, 0), hasTakings: payments.length > 0 };
  }, [due.billYear]);
  // Never another year's figures under this year's card.
  const figures = data && data.year === due.billYear ? data : null;
  return <TaxDueView due={due} today={today} figures={figures} failed={!figures && !!error && !loading} />;
}

/** Nothing saved with Edit for that year. */
const nothingSaved = (row: TaxYear) => row.updated_at === null && !row.extra_takings_pence && !row.expenses_pence;
/** Nothing saved with Edit for that year, and nothing in the app for it either: there's no figure to give. */
const noFigures = (f: BillYearFigures) => !f.hasTakings && nothingSaved(f.row);

/** The card for what has loaded so far (exported for the tests). */
export function TaxDueView({ due, today, figures, failed }: {
  due: TaxDueOnToday; today: string; figures: BillYearFigures | null; failed: boolean;
}) {
  const year = yearLabel(due.billYear);
  const next = yearLabel(due.billYear + 1);
  const amount = figures && !noFigures(figures)
    ? poundsDueOnToday(due, estimateTax({
      taxYearStart: due.billYear, takingsPence: figures.takingsPence,
      extraTakingsPence: figures.row.extra_takings_pence, expensesPence: figures.row.expenses_pence,
    }))
    : null;
  // July with a bill under £1,000 on her figures: no payment on account, so no card.
  if (due.kind === 'july' && (!figures || (amount && amount.total === 0))) {
    if (!failed) return null;
  }
  const weekend = weekendDue(due.date.iso);
  const dueDay = fmtDayLong(`${due.date.iso}T12:00:00Z`);
  // The Friday has gone and the date is at a weekend: it can still be paid on the day, by Faster Payments or
  // debit card (HMRC doesn't take personal credit cards).
  const safeDay = weekend && today <= fridayBefore(due.date.iso)
    ? <> Pay by <span className="od-nowrap">{weekend.friday}</span> to be safe.</>
    : weekend ? <> Not paid yet? Pay today by Faster Payments (your banking app) or debit card: those count on the day.</> : null;
  const nothing = due.kind === 'bill' && amount?.total === 0;
  const ask = due.kind === 'bill'
    ? `Add your ${year} takings and expenses to see your bill.`
    : `Add your ${year} takings and expenses to see roughly how much.`;
  // Only the app's takings, as she hasn't used Edit for that year: in the year she switched apps, the
  // money taken before is missing. (No tab names on the card: tapping it opens that year, with Edit.)
  const appOnly = figures && nothingSaved(figures.row)
    ? <span className="td-tax-small">Took money another way in {year}, such as through another app? Tap to add it, or this is too low.</span>
    : null;
  return (
    <Link className="card td-tax" to={`/money?taxyear=${due.billYear}`}>
      <span className="td-tax-head">
        <span className="td-tax-ico" aria-hidden="true"><Glyph name="calendar" size={18} /></span>
        <span className="td-tax-kicker">Tax<span className="visually-hidden">:</span></span>
        <span className="chev"><Icon name="chev" size={18} /></span>
      </span>
      <span className="td-tax-due">
        {due.kind === 'bill'
          ? <>Your {year} tax return{nothing ? ' is' : ' and bill are'} due <b className="od-nowrap">{dueDay}</b>.{!nothing && safeDay}</>
          : <>Half your {year} bill again is due <b className="od-nowrap">{dueDay}</b>, towards {next}, if HMRC asked for payments
            on account.{safeDay}</>}
      </span>
      {amount ? (
        nothing ? <><span className="td-tax-amount">Nothing to pay on your figures.</span>{appOnly}</> : (
          <>
            <span className="td-tax-amount">
              About <b className="td-tax-pounds">{money(amount.total * 100)}</b> on your figures
              {due.kind === 'bill' && amount.onAccount > 0
                ? <>, including the first payment towards {next}: your {money(amount.bill * 100)} bill, plus {money(amount.onAccount * 100)}.</>
                : '.'}
            </span>
            <span className="td-tax-small">
              {due.kind === 'bill'
                ? <>Less anything you’ve already paid towards {year} (the HMRC app shows the exact amount).</>
                : <>The HMRC app shows the exact amount.</>}
            </span>
            {appOnly}
          </>
        )
      ) : figures ? (
        <span className="td-tax-amount td-tax-ask">{ask}</span>
      ) : failed ? (
        <span className="td-tax-small">Your {year} figures couldn’t be loaded just now. Tap to see them.</span>
      ) : (
        <span className="td-tax-small">Working out your bill…</span>
      )}
    </Link>
  );
}

/** "2027-01-31" (a Sunday) → "2027-01-29": the last weekday before a weekend due date. */
function fridayBefore(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const back = weekday === 0 ? 2 : weekday === 6 ? 1 : 0;
  return new Date(Date.UTC(y, m - 1, d - back)).toISOString().slice(0, 10);
}
