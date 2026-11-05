import { Fragment, useState, type ReactNode } from 'react';
import { api } from '../../api';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { fmt, todayInZone } from '../../lib/time';
import { downloadText, friendlyError, money, moneyPlain, parsePounds, taxYearOf, toCsv } from '../../lib/text';
import {
  estimateTax, longDate, makingTaxDigital, marginalRateAt, mtdStage, PAYMENTS_ON_ACCOUNT_FROM, ratesFor, TAX_YEAR_MAX_PENCE, taxDates,
  taxYearDays, yearLabel, type MtdStage, type TaxDate,
} from '../../lib/tax';
import type { PayKind, PayMethod, Payment, TaxYear } from '../../lib/types';
import { Heart, LemonSlice } from '../../components/brand';
import { Glyph } from './Clients';

const KIND_LABEL: Record<PayKind, string> = { deposit: 'Deposit', payment: 'Payment', tip: 'Tip', refund: 'Refund', other: 'Other income' };
const METHOD_LABEL: Record<PayMethod, string> = { cash: 'Cash', bank_transfer: 'Bank transfer' };

function monthRange(ym: string) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` };
}
function shiftMonth(ym: string, by: number) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return d.toISOString().slice(0, 7);
}

export function Money() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const [view, setView] = useState<'month' | 'year'>('month');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [yearOf, setYearOf] = useState(today);
  const [adding, setAdding] = useState(false);
  const toast = useToast();

  const ty = taxYearOf(yearOf);
  const range = view === 'month' ? monthRange(month) : { from: ty.from, to: ty.to };
  const { data, error, loading, reload } = useLoad(
    async () => ({ key: `${range.from}/${range.to}`, rows: await api.listPayments(range.from, range.to) }),
    [range.from, range.to]);
  // While the next period loads, never show (or export) the previous period's figures under the new heading.
  const current = data && data.key === `${range.from}/${range.to}`;
  const rows = current ? data.rows : [];
  const sum = (f: (p: Payment) => boolean) => rows.filter(f).reduce((n, p) => n + p.amount_pence, 0);
  const total = sum(() => true);
  const cash = sum((p) => p.method === 'cash');
  const bank = sum((p) => p.method === 'bank_transfer');
  const tips = sum((p) => p.kind === 'tip');
  const refunds = sum((p) => p.kind === 'refund');
  const label = view === 'month' ? fmt(`${month}-15T12:00:00Z`, 'MMMM yyyy', tz) : `Tax year ${ty.label}`;
  const labelSub = view === 'month' ? null : `6 Apr ${ty.from.slice(0, 4)} – 5 Apr ${ty.to.slice(0, 4)}`;
  // How the takings split between cash and bank transfer, for the little bar under the total.
  const cashShare = cash > 0 || bank > 0 ? Math.round((Math.max(cash, 0) / (Math.max(cash, 0) + Math.max(bank, 0))) * 100) : null;
  // Long figures (pence, or thousands) get a smaller size and lose the tile icons, so a number never breaks in two.
  const longStats = [cash, bank, tips, refunds].some((p) => money(p).length > 6);
  const longTotal = money(total).length > 7;

  function exportCsv() {
    const lines = [['Date', 'Client', 'Description', 'Type', 'Paid by', 'Amount (£)', 'Note']];
    for (const p of [...rows].reverse()) {
      lines.push([p.paid_on, p.client_name ?? '', p.description ?? '', KIND_LABEL[p.kind], METHOD_LABEL[p.method], moneyPlain(p.amount_pence), p.note ?? '']);
    }
    lines.push([], ['Total', '', '', '', '', moneyPlain(total), ''], ['Cash', '', '', '', '', moneyPlain(cash), ''], ['Bank transfer', '', '', '', '', moneyPlain(bank), '']);
    const name = view === 'month' ? `takings-${month}.csv` : `takings-tax-year-${ty.label.replace('–', '-')}.csv`;
    downloadText(name, toCsv(lines));
    toast('Spreadsheet downloaded');
  }

  const byDay = new Map<string, Payment[]>();
  for (const p of rows) byDay.set(p.paid_on, [...(byDay.get(p.paid_on) ?? []), p]);

  return (
    <div className="page od od-money">
      <TopBar title="Money" right={<button className="icon-btn od-top-add" aria-label="Add income or refund" onClick={() => setAdding(true)}><Icon name="plus" /></button>} />
      <Seg label="Period" value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'year', label: 'Tax year' }]} />
      <div className="od-period">
        <button className="icon-btn" aria-label="Previous" onClick={() => (view === 'month' ? setMonth(shiftMonth(month, -1)) : setYearOf(`${Number(ty.from.slice(0, 4)) - 1}-06-01`))}><Icon name="left" /></button>
        <div className="od-period-label">
          <strong>{label}</strong>
          {labelSub && <span className="od-period-sub">{labelSub}</span>}
        </div>
        <button className="icon-btn" aria-label="Next" onClick={() => (view === 'month' ? setMonth(shiftMonth(month, 1)) : setYearOf(`${Number(ty.from.slice(0, 4)) + 1}-06-01`))}><Icon name="right" /></button>
      </div>
      <ErrorBox error={error} />
      {!current ? <Spinner /> : (
        <>
          <div className={`stat-grid od-stats${longStats ? ' od-stats-long' : ''}`}>
            <div className="stat od-stat-total" style={{ gridColumn: '1 / -1' }}>
              <LemonSlice size={92} className="od-stat-lemon" />
              <div className="label">Money received</div>
              <div className={`value${longTotal ? ' od-long' : ''}`}>{money(total)}</div>
              {cashShare !== null && (
                <div className="od-split" aria-hidden="true">
                  <span className="od-split-cash" style={{ width: `${cashShare}%` }} />
                  <span className="od-split-bank" style={{ width: `${100 - cashShare}%` }} />
                </div>
              )}
            </div>
            <div className="stat od-stat-cash"><div className="label">Cash</div><div className="od-stat-row"><div className="value">{money(cash)}</div><span className="od-stat-ic" aria-hidden="true"><Glyph name="cash" size={18} /></span></div></div>
            <div className="stat od-stat-bank"><div className="label">Bank transfer</div><div className="od-stat-row"><div className="value">{money(bank)}</div><span className="od-stat-ic" aria-hidden="true"><Glyph name="bank" size={18} /></span></div></div>
            <div className="stat od-stat-tips"><div className="label">Tips</div><div className="od-stat-row"><div className="value">{money(tips)}</div><span className="od-stat-ic" aria-hidden="true"><Heart size={16} /></span></div></div>
            <div className="stat od-stat-refunds"><div className="label">Refunds</div><div className="od-stat-row"><div className="value">{money(refunds)}</div><span className="od-stat-ic" aria-hidden="true"><Glyph name="refund" size={18} /></span></div></div>
          </div>
          {view === 'year' && (
            <TaxCard startYear={Number(ty.from.slice(0, 4))} rangeLabel={labelSub ?? ''} today={today} takingsPence={total} hasTakings={rows.length > 0} />
          )}
          <button className="btn block od-export" disabled={!rows.length || loading} onClick={exportCsv}><Glyph name="download" size={20} /> Download spreadsheet (CSV)</button>
          <p className="od-tax-note">
            <span className="od-tax-note-ic" aria-hidden="true"><Glyph name="receipt" size={17} /></span>
            This is your record of money received, for your Self Assessment. Keep the receipts for your expenses (products, training, insurance):
            they lower your tax bill, and you can add them to the tax estimate {view === 'year' ? <>above with <b>Edit</b></> : <>under Tax year → <b>Edit</b></>}.
          </p>
          {view === 'month' && (
            <button className="btn ghost small od-tax-link" onClick={() => { setYearOf(`${month}-15`); setView('year'); }}>
              See roughly how much tax to put aside
            </button>
          )}
          {[...byDay.entries()].map(([day, list]) => (
            <div key={day} className="od-day">
              <div className="day-head"><h2>{fmt(`${day}T12:00:00Z`, 'EEE d MMM', tz)}</h2><span className="od-day-total">{money(list.reduce((n, p) => n + p.amount_pence, 0))}</span></div>
              <div className="card tight"><ul className="list">
                {list.map((p) => {
                  // Deposits and checkout tips are saved as "Deposit · BIAB new set": say the type once, not twice.
                  const kind = KIND_LABEL[p.kind];
                  const title = p.client_name || p.description || kind;
                  const desc = p.client_name && p.description !== kind ? p.description : null;
                  const kindSaid = [title, desc].some((t) => t === kind || !!t?.startsWith(`${kind} ·`));
                  return (
                  <li key={p.id} className={`list-row od-pay${p.amount_pence < 0 ? ' od-pay-out' : ''}`}>
                    <span className={`od-ic small ${p.kind === 'refund' ? 'danger' : p.kind === 'tip' ? 'pink' : p.method === 'cash' ? 'lemon' : 'lilac'}`} aria-hidden="true">
                      {p.kind === 'refund' ? <Glyph name="refund" size={18} /> : p.kind === 'tip' ? <Heart size={16} /> : <Glyph name={p.method === 'cash' ? 'cash' : 'bank'} size={18} />}
                    </span>
                    <div className="grow">
                      <div className="title">{title}</div>
                      <div className="meta"><MetaParts parts={[desc, kindSaid ? null : kind, METHOD_LABEL[p.method], p.note]} /></div>
                    </div>
                    <strong className="od-amt">{money(p.amount_pence)}</strong>
                    <button className="icon-btn od-del" aria-label="Delete entry"
                      onClick={async () => {
                        if (!window.confirm('Delete this entry from your takings?')) return;
                        try { await api.deletePayment(p.id); reload(); } catch (e) { toast(friendlyError(e)); }
                      }}>
                      <Icon name="trash" size={18} />
                    </button>
                  </li>
                  );
                })}
              </ul></div>
            </div>
          ))}
          {!rows.length && <div className="card empty" style={{ marginTop: 12 }}>Nothing recorded for this period.</div>}
        </>
      )}
      {adding && <AddPaymentSheet tz={tz} onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); toast('Added to takings'); }} />}
    </div>
  );
}

/** Whole pounds, for an estimate: 141180 → 1412. */
const toPounds = (pence: number) => Math.round(pence / 100);
/** Whole pounds as money: 1412 → "£1,412". */
const showPounds = (pounds: number) => money(pounds * 100);

/** Nothing saved for the tax year: Edit hasn't been used for it. */
const nothingSaved = (row: TaxYear) => row.updated_at === null && !row.extra_takings_pence && !row.expenses_pence;

/**
 * What the card has to work with from loading a year's figures: the row once it's in
 * (never another year's, while this one loads), or whether loading it failed. Without
 * the row there's no estimate and no Edit: blank boxes saved after a failed load would
 * wipe her figures.
 */
export function taxCardState(data: { year: number; row: TaxYear } | undefined, error: unknown, loading: boolean, startYear: number) {
  const row = data && data.year === startYear ? data.row : null;
  return { row, failed: !row && !!error && !loading };
}

/**
 * Tax year view: roughly how much to put aside for this tax year's Self Assessment,
 * assuming the business is her only income (see lib/tax.ts). Her own figures for
 * the year (takings not in the app, expenses) come from Edit.
 */
function TaxCard({ startYear, rangeLabel, today, takingsPence, hasTakings }: {
  startYear: number; rangeLabel: string; today: string; takingsPence: number; hasTakings: boolean;
}) {
  const { data, error, loading, setData, reload } = useLoad(async () => ({ year: startYear, row: await api.getTaxYear(startYear) }), [startYear]);
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const { row, failed } = taxCardState(data, error, loading, startYear);
  const label = yearLabel(startYear);
  return (
    <TaxCardView startYear={startYear} today={today} takingsPence={takingsPence} hasTakings={hasTakings}
      row={row} failed={failed} onEdit={() => setEditing(true)} onRetry={reload}>
      {editing && row && (
        <TaxYearSheet startYear={startYear} rangeLabel={rangeLabel} ended={today > taxYearDays(startYear).last} row={row}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            // Show the new figures straight away, then read them back.
            setData({ year: startYear, row: saved });
            reload();
            setEditing(false);
            toast(`Saved your figures for ${label}`);
          }} />
      )}
    </TaxCardView>
  );
}

/** The card for what has loaded so far (exported for the tests). */
export function TaxCardView({ startYear, today, takingsPence, hasTakings, row, failed, onEdit, onRetry, children }: {
  startYear: number;
  /** yyyy-mm-dd in the business's time zone. */
  today: string;
  /** Takings recorded in the app for the tax year, net of refunds. */
  takingsPence: number;
  /** Whether anything at all is recorded in the app for the tax year. */
  hasTakings: boolean;
  /** Her figures for the year, or null until they've loaded. */
  row: TaxYear | null;
  /** Loading her figures failed, and isn't being tried again right now. */
  failed: boolean;
  onEdit: () => void;
  onRetry: () => void;
  children?: ReactNode;
}) {
  return (
    <section className="card stack od-taxcard" aria-labelledby="od-taxcard-h">
      <div className="od-taxcard-head">
        <h2 id="od-taxcard-h" className="od-taxcard-h">Tax to put aside</h2>
        <button className="btn small od-taxcard-edit" disabled={!row} onClick={onEdit}>
          <Glyph name="pencil" size={16} /> Edit
        </button>
      </div>
      {row ? (
        !hasTakings && nothingSaved(row)
          ? <TaxEmpty startYear={startYear} today={today} />
          : <TaxFigures startYear={startYear} today={today} takingsPence={takingsPence} row={row} />
      ) : failed ? (
        <div className="stack od-taxcard-failed">
          {/* one span, so the error box's icon sits beside the whole line */}
          <div className="error" role="alert">
            <span>Your figures for <Year start={startYear} /> couldn’t be loaded just now, so there’s no estimate yet.</span>
          </div>
          <button className="btn small od-taxcard-retry" onClick={onRetry}>Try again</button>
        </div>
      ) : <Spinner />}
      {children}
    </section>
  );
}

/** A tax year's label kept on one line: "2026–27". */
const Year = ({ start }: { start: number }) => <span className="od-nowrap">{yearLabel(start)}</span>;
/** A date kept on one line: "31 January 2028". */
const When = ({ d }: { d: TaxDate | string }) => <span className="od-nowrap">{typeof d === 'string' ? d : d.label}</span>;
/** "6 April 2028": the day a Making Tax Digital stage starts. */
const mtdStart = (s: MtdStage) => `6 April ${s.fromYear}`;

/** A tax year with nothing in the app and nothing added: ask for its figures, rather than show £0 as if nothing were due. */
function TaxEmpty({ startYear, today }: { startYear: number; today: string }) {
  const days = taxYearDays(startYear);
  const due = taxDates(startYear).balancing;
  const year = <Year start={startYear} />;
  const [title, text] = today < days.first
    ? [<>Nothing for {year} yet</>, <>It starts on <When d={longDate(days.first)} />. Takings you record from then on count here.</>]
    : today <= days.last
      ? [<>No takings for {year} in the app yet</>,
        <>Took money another way this tax year, such as bookings through another app? Tap <b>Edit</b> to add it, with your
          expenses, to see roughly what to put aside.</>]
      : today <= due.iso
        ? [<>No takings for {year} in the app</>,
          <>If you worked that tax year, tap <b>Edit</b> and add its takings and expenses to see roughly what to put aside
            for <When d={due} />.</>]
        : [<>No takings for {year} in the app</>,
          <>To see roughly what that year’s bill came to, tap <b>Edit</b> and add its takings and expenses.</>];
  return (
    <div className="od-taxcard-empty">
      <p className="od-taxcard-empty-h">{title}</p>
      <p className="sub">{text}</p>
    </div>
  );
}

function TaxFigures({ startYear, today, takingsPence, row }: { startYear: number; today: string; takingsPence: number; row: TaxYear }) {
  const e = estimateTax({
    taxYearStart: startYear, takingsPence, extraTakingsPence: row.extra_takings_pence, expensesPence: row.expenses_pence,
  });
  const r = e.rates;
  const ended = today > taxYearDays(startYear).last;
  const dates = taxDates(startYear);
  const duePassed = today > dates.balancing.iso;
  // Whole pounds, worked out so the rows add up as shown.
  const inApp = toPounds(e.takings);
  const other = toPounds(e.extraTakings);
  const takings = Math.max(0, inApp + other);
  const allowancePounds = toPounds(r.tradingAllowance);
  // The trading allowance can't take the profit below £0, so no more of it than the takings comes off.
  const off = e.deductionKind === 'allowance' ? Math.min(allowancePounds, takings) : toPounds(e.deduction);
  const profit = Math.max(0, takings - off);
  const incomeTax = toPounds(e.incomeTax);
  const class4 = toPounds(e.class4);
  const total = incomeTax + class4;
  const share = Math.round(e.shareOfTakings * 100);
  const pence = Math.round(e.marginalRate * 100);
  // What each new £1 costs once the profit is past the tax-free allowance.
  const abovePence = Math.round(marginalRateAt(r.personalAllowance, r) * 100);
  const allowance = showPounds(allowancePounds);
  const personal = showPounds(toPounds(r.personalAllowance));
  // A bill of £1,000 or more usually brings two payments on account towards the next
  // tax year, each half of it: by 31 January, on top of the bill, and by 31 July.
  const onAccount = total >= toPounds(PAYMENTS_ON_ACCOUNT_FROM) ? toPounds(e.total / 2) : 0;
  const mtd = makingTaxDigital(startYear, e.totalTakings);
  const rates = r.announced
    ? <>the rates announced for <Year start={e.ratesYear} /> (not law yet)</>
    : <>the <Year start={e.ratesYear} /> rates</>;
  return (
    <>
      <div>
        <div className="od-taxcard-value">{showPounds(total)}</div>
        <p className="sub od-taxcard-sub">
          {total > 0
            ? <>{ended ? 'For the whole tax year' : 'So far this tax year'}: {share > 0 ? `about ${share}%` : 'less than 1%'} of your takings.</>
            : <>{ended ? 'Nothing to pay' : 'Nothing yet'}: the first {personal} of profit each tax year is tax-free.</>}
        </p>
      </div>
      <dl className="od-taxcard-rows">
        <div><dt>Takings in the app</dt><dd>{showPounds(inApp)}</dd></div>
        <div><dt>Other takings</dt><dd>{showPounds(other)}</dd></div>
        {e.deductionKind === 'expenses' ? (
          <div className="od-taxcard-off">
            <dt>Expenses</dt><dd>{showPounds(-off)}</dd>
            {off > takings && (
              <dd className="od-taxcard-why">Your expenses are more than your takings, so there’s no profit and no tax to pay.</dd>
            )}
          </div>
        ) : (
          <div className="od-taxcard-off">
            <dt>Trading allowance</dt><dd>{showPounds(-off)}</dd>
            <dd className="od-taxcard-why">
              {takings <= allowancePounds
                ? <>Takings of {allowance} or less in a tax year are tax-free: that’s the trading allowance.</>
                : e.expenses > 0
                  ? <>Used instead of your {money(e.expenses)} of expenses, as it’s bigger: it’s one or the other, not both.</>
                  : <>With no expenses added, the {allowance} tax-free allowance comes off instead.</>}
            </dd>
          </div>
        )}
        <div className="od-taxcard-profit"><dt>Profit</dt><dd>{showPounds(profit)}</dd></div>
        <div><dt>Income Tax</dt><dd>{showPounds(incomeTax)}</dd></div>
        <div><dt>Class 4 National Insurance</dt><dd>{showPounds(class4)}</dd></div>
      </dl>
      {!ended && (
        <p className="od-taxcard-tip">
          {pence > 0
            ? <>From here, put aside about <b>{pence}p of each £1</b> you take.</>
            : <>Once your profit for the year is over {personal}, put aside about <b>{abovePence}p of each £1</b> you take.</>}
        </p>
      )}
      <p className="od-taxcard-due-line">
        <span className="od-taxcard-due-ic" aria-hidden="true"><Glyph name="calendar" size={17} /></span>
        <span>
          {duePassed
            ? <>Your <Year start={startYear} /> tax return{total > 0 ? ' and bill were' : ' was'} due by <b><When d={dates.balancing} /></b>.</>
            : <>Send your <Year start={startYear} /> tax return online{total > 0 ? ' and pay the bill' : ''} by <b><When d={dates.balancing} /></b>.</>}
        </span>
      </p>
      {!duePassed && onAccount > 0 && (dates.nextYear ? (
        <div className="od-taxcard-plan">
          <p>
            With a bill of {money(PAYMENTS_ON_ACCOUNT_FROM)} or more, HMRC usually also asks for two payments towards{' '}
            <Year start={startYear + 1} />, each half of this bill (“payments on account”).{' '}
            {ended ? 'That means:' : 'On the figures so far, that means:'}
          </p>
          <dl className="od-taxcard-rows">
            <div>
              <dt>By <When d={dates.nextYear.first} /></dt><dd>{showPounds(total + onAccount)}</dd>
              <dd className="od-taxcard-why">This bill, plus {showPounds(onAccount)} towards <Year start={startYear + 1} /></dd>
            </div>
            <div><dt>By <When d={dates.nextYear.second} /></dt><dd>{showPounds(onAccount)}</dd></div>
          </dl>
          {dates.thisYear && (
            <p className="od-taxcard-small">
              Already make payments on account? Then part of this bill {today > dates.thisYear.second.iso ? 'was' : 'is'} paid in
              advance, so there’s less to pay in January.
            </p>
          )}
        </div>
      ) : (
        <p className="od-taxcard-plan">
          A bill of {money(PAYMENTS_ON_ACCOUNT_FROM)} or more usually also means paying towards the next tax year in advance. From April
          2029, HMRC plans to collect that in smaller automatic payments during the year: the details are still to come.
        </p>
      ))}
      {mtd && <MtdNotice mtd={mtd} today={today} ended={ended} />}
      <details className="od-more od-taxcard-more">
        <summary>How it’s paid</summary>
        <div className="stack od-taxcard-due">
          {dates.nextYear ? (
            <p className="sub">
              When a bill is {money(PAYMENTS_ON_ACCOUNT_FROM)} or more, HMRC usually also asks for two payments towards the next tax year
              (“payments on account”), each half of this bill: one by <When d={dates.nextYear.first} />, on top of this bill, and the
              other half by <When d={dates.nextYear.second} />. Not if more than 80% of your tax is already taken at source, such as
              through PAYE.
            </p>
          ) : (
            <p className="sub">
              When a bill is {money(PAYMENTS_ON_ACCOUNT_FROM)} or more, HMRC has usually also asked for two payments towards the next tax
              year (“payments on account”), each half of the bill. From April 2029, it plans to replace them with smaller automatic
              payments during the year: the details are still to come.
            </p>
          )}
          {dates.thisYear ? (
            <p className="sub">
              If you already make payments on account, part of this bill will have been paid in advance,
              by <When d={dates.thisYear.first} /> and <When d={dates.thisYear.second} />.
            </p>
          ) : (
            <p className="sub">If you already pay towards your tax in advance, part of this bill will have been paid during the year.</p>
          )}
          {dates.nextYear && today <= dates.nextYear.second.iso && (
            <p className="sub">
              Expect a smaller bill next year? You can ask HMRC to reduce your payments on account (online, or with form SA303), but if
              you reduce them too far you’ll pay interest on the difference.
            </p>
          )}
        </div>
      </details>
      {!mtd && <MtdTimetable today={today} />}
      {startYear >= 2024 && (
        <p className="od-taxcard-small">
          No Class 2 National Insurance is added: with a profit of {showPounds(toPounds(r.smallProfitsThreshold))} or more for the year
          it counts as paid, so the year still counts towards your State Pension. Below that, paying it ({money(r.class2Weekly)} a week)
          is up to you.
        </p>
      )}
      <p className="od-taxcard-small">
        A rough guide for putting money aside, not tax advice. It assumes your nail business is your only income: wages or other income
        would mean more tax. It uses {rates}
        {e.exactRates ? '' : <>, as <Year start={startYear} />’s aren’t in the app{e.ratesYear < startYear ? ' yet' : ''},</>} for England,
        Wales and Northern Ireland, and doesn’t include student loan repayments or Scotland’s rates.
        {e.ratesYear > startYear && <> National Insurance was higher before April 2024, so the real bill for <Year start={startYear} /> was higher.</>}
      </p>
    </>
  );
}

/** One Making Tax Digital stage: "2025–26 over £30,000: from 6 April 2027" (or "since", once it has started). */
function StageItem({ s, today }: { s: MtdStage; today: string }) {
  return (
    <li>
      <Year start={s.testYear} /> over {money(s.threshold)}: {today >= `${s.fromYear}-04-06` ? 'since' : 'from'} <When d={mtdStart(s)} />
    </li>
  );
}

/** This tax year's takings bring in Making Tax Digital: from when (at the latest), and what it means. */
function MtdNotice({ mtd, today, ended }: { mtd: MtdStage & { earlier: MtdStage[] }; today: string; ended: boolean }) {
  const started = today >= `${mtd.fromYear}-04-06`;
  const sooner = mtd.earlier.length > 0;
  // The £20,000 years before this one go on one line, so a far-off year's list stays short.
  const twenty = mtd.earlier.filter((s) => s.threshold === mtdStage(2026)!.threshold);
  const higher = mtd.earlier.filter((s) => s.threshold !== mtdStage(2026)!.threshold);
  return (
    <div className="notice warn od-taxcard-mtd">
      <p>
        Your takings for <Year start={mtd.testYear} /> {ended ? 'were' : 'are'} over {money(mtd.threshold)}, so under current rules
        HMRC’s Making Tax Digital {started ? 'has applied to you since' : 'applies to you from'} <When d={mtdStart(mtd)} />
        {sooner ? (started ? ' or earlier' : ' at the latest') : ''} (the start of the <Year start={mtd.fromYear} /> tax year):{' '}
        {started
          ? <>you need to keep digital records and send HMRC an update every quarter (by 7 August, 7 November, 7 February and 7 May),
            using software that works with Making Tax Digital.</>
          : <>you’ll keep digital records and send HMRC an update every quarter, using software that works with Making Tax Digital.</>}
      </p>
      {sooner && (
        <>
          <p>Sooner if an earlier tax year’s takings were over its limit:</p>
          <ul className="od-taxcard-list">
            {twenty.length === 1 && <StageItem s={twenty[0]} today={today} />}
            {twenty.length > 1 && (
              <li>
                Any tax year from <Year start={twenty[twenty.length - 1].testYear} /> to <Year start={twenty[0].testYear} /> over{' '}
                {money(twenty[0].threshold)}: from the April a year after it ends
              </li>
            )}
            {higher.map((s) => <StageItem key={s.testYear} s={s} today={today} />)}
          </ul>
        </>
      )}
    </div>
  );
}

/** When Making Tax Digital starts, under current rules, for a year whose own takings don't bring it in. */
function MtdTimetable({ today }: { today: string }) {
  return (
    <details className="od-more od-taxcard-more">
      <summary>Making Tax Digital</summary>
      <div className="stack od-taxcard-due">
        <p className="sub">
          Under current rules, HMRC’s Making Tax Digital starts once a tax year’s takings (before expenses, and including any not
          recorded in this app) are over its limit:
        </p>
        <ul className="od-taxcard-list sub">
          {[2024, 2025, 2026].map((y) => <StageItem key={y} s={mtdStage(y)!} today={today} />)}
          <li>Later tax years over £20,000: from the April a year after the tax year ends</li>
        </ul>
        <p className="sub">
          It means keeping digital records and sending HMRC an update every quarter (by 7 August, 7 November, 7 February and 7 May),
          using software that works with Making Tax Digital.
        </p>
      </div>
    </details>
  );
}

/** "2500" for 250000p, "2400.50" for 240050p, "" for nothing. */
const poundsInput = (pence: number) => (pence ? (pence % 100 === 0 ? String(pence / 100) : (pence / 100).toFixed(2)) : '');

/** Her own figures for a tax year's estimate: takings not recorded in the app, and business expenses. */
function TaxYearSheet({ startYear, rangeLabel, ended, row, onClose, onSaved }: {
  startYear: number; rangeLabel: string; ended: boolean; row: TaxYear; onClose: () => void; onSaved: (saved: TaxYear) => void;
}) {
  const [f, setF] = useState({ extra: poundsInput(row.extra_takings_pence), expenses: poundsInput(row.expenses_pence) });
  const { busy, error, run, setError } = useAction();
  const { rates } = ratesFor(startYear);
  const allowance = money(rates.tradingAllowance);
  async function save() {
    const read = (t: string) => (t.trim() ? parsePounds(t) : 0);
    const extra = read(f.extra);
    const expenses = read(f.expenses);
    if (extra === null) return setError(new Error('Check the takings: just the amount in pounds, like 2,400 or 2400.50.'));
    if (expenses === null) return setError(new Error('Check the expenses: just the amount in pounds, like 850 or 850.25.'));
    if (extra > TAX_YEAR_MAX_PENCE || expenses > TAX_YEAR_MAX_PENCE) return setError(new Error('That’s more than £1,000,000. Please check the amount.'));
    let saved: TaxYear | undefined;
    if (await run(async () => { saved = await api.saveTaxYear({ start_year: startYear, extra_takings_pence: extra, expenses_pence: expenses }); })) {
      onSaved(saved!);
    }
  }
  return (
    <Sheet title={`Your figures for ${yearLabel(startYear)}`} onClose={onClose}>
      <div className="stack">
        <p className="sub od-taxsheet-intro">
          Totals for the tax year{ended ? '' : ' so far'} ({rangeLabel}). Rough figures are fine, and you can change them any time.
        </p>
        <div className="od-amount od-amount-tip">
          <Field label="Takings not recorded in this app (£)"
            hint={`Money from your nail work in ${yearLabel(startYear)} that isn’t in Money, such as bookings paid through another app before you switched.`}>
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={f.extra}
              onChange={(ev) => setF({ ...f, extra: ev.target.value })} />
          </Field>
        </div>
        <div className="od-amount od-amount-tip">
          <Field label="Business expenses (£)"
            hint={<>What the business {ended ? 'cost' : 'has cost'} you in {yearLabel(startYear)}: products, tools, PPE, training, insurance, and a share of your phone
              and home costs. Keep the receipts. Under {allowance}? The estimate uses the {allowance} trading
              allowance{rates.announced ? ' (announced, not law yet)' : ''} instead.</>}>
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={f.expenses}
              onChange={(ev) => setF({ ...f, expenses: ev.target.value })} />
          </Field>
        </div>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </Sheet>
  );
}

/** "BIAB infill · Payment · Bank transfer", where a line can break only between the parts, not inside one. */
function MetaParts({ parts }: { parts: (string | null | undefined)[] }) {
  const list = parts.filter((t): t is string => !!t);
  return <>{list.map((t, i) => {
    const more = i < list.length - 1;
    return <Fragment key={i}><span className="od-meta-part">{t}{more ? ' ·' : ''}</span>{more ? ' ' : ''}</Fragment>;
  })}</>;
}

function AddPaymentSheet({ tz, onClose, onSaved }: { tz: string; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'other' | 'refund' | 'tip'>('other');
  const [f, setF] = useState({ paid_on: todayInZone(tz), description: '', client_name: '', amount: '', method: 'cash' as PayMethod, note: '' });
  const { busy, error, run, setError } = useAction();
  async function save() {
    const pence = parsePounds(f.amount);
    if (!pence) return setError(new Error('Enter the amount.'));
    if (!f.description.trim() && kind === 'other') return setError(new Error('Say what it was for (e.g. cuticle oil sale).'));
    if (await run(() => api.addPayment({
      appointment_id: null, client_id: null, client_name: f.client_name.trim() || null,
      description: f.description.trim() || (kind === 'refund' ? 'Refund' : 'Tip'),
      amount_pence: kind === 'refund' ? -pence : pence, method: f.method, kind, paid_on: f.paid_on, note: f.note.trim() || null,
    }))) onSaved();
  }
  return (
    <Sheet title="Add to takings" onClose={onClose}>
      <div className="stack">
        <Seg label="Type" value={kind} onChange={setKind} options={[{ value: 'other', label: 'Income' }, { value: 'tip', label: 'Tip' }, { value: 'refund', label: 'Refund' }]} />
        <Field label="Date"><input type="date" value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
        <Field label="What for"><input type="text" value={f.description} maxLength={200} placeholder={kind === 'refund' ? 'e.g. Deposit refund' : 'e.g. Cuticle oil'} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Client (optional)"><input type="text" value={f.client_name} maxLength={100} onChange={(e) => setF({ ...f, client_name: e.target.value })} /></Field>
        <div className="od-amount"><Field label={kind === 'refund' ? 'Amount refunded (£)' : 'Amount (£)'}><input type="text" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field></div>
        <Seg label="Paid by" value={f.method} onChange={(method) => setF({ ...f, method })} options={[{ value: 'cash', label: 'Cash' }, { value: 'bank_transfer', label: 'Bank transfer' }]} />
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Add'}</button>
      </div>
    </Sheet>
  );
}
