import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, isNeedsUpdate } from '../../api';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { fmt, startOfDayInstant, todayInZone } from '../../lib/time';
import { summariseNewClients, type NewClientsSummary } from '../../lib/source';
import { lastMonthText, newClientsText } from '../../lib/growth';
import { friendlyError, money, moneyPlain, parsePounds, taxYearOf, toCsv } from '../../lib/text';
import {
  billInPounds, dueFromEarlierYear, emptyTaxYear, estimateTax, longDate, makingTaxDigital, marginalRatesAt, monthPutAside, monthTaxParts, mtdStage,
  PAYMENTS_ON_ACCOUNT_FROM, ratesFor, TAX_YEAR_MAX_PENCE, taxDates, taxYearDays, weekendDue, wholePounds, yearLabel,
  type MtdStage, type TaxDate, type TaxRates,
} from '../../lib/tax';
import { downloadFile, firstShareable, isAbort, saveFile } from '../../lib/files';
import { rememberSpreadsheet } from '../../lib/backup';
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

/** "?taxyear=2025" (from Today's tax card or spreadsheet reminder): open on that tax year. */
export function linkedTaxYear(value: string | null): number | null {
  if (!value || !/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return year >= 2000 && year <= 2100 ? year : null;
}

export function Money() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const [params] = useSearchParams();
  const [linked] = useState(() => linkedTaxYear(params.get('taxyear')));
  const [view, setView] = useState<'month' | 'year'>(linked === null ? 'month' : 'year');
  const [month, setMonth] = useState(today.slice(0, 7));
  const [yearOf, setYearOf] = useState(linked === null ? today : `${linked}-06-01`);
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

  // On an iPhone the spreadsheet goes to the share sheet, where she chooses Save to Files (or sends it
  // to her accountant); elsewhere it downloads. Either way she's asked to check, never told it's saved.
  async function exportCsv() {
    const lines = [['Date', 'Client', 'Description', 'Type', 'Paid by', 'Amount (£)', 'Note']];
    for (const p of [...rows].reverse()) {
      lines.push([p.paid_on, p.client_name ?? '', p.description ?? '', KIND_LABEL[p.kind], METHOD_LABEL[p.method], moneyPlain(p.amount_pence), p.note ?? '']);
    }
    lines.push([], ['Total', '', '', '', '', moneyPlain(total), ''], ['Cash', '', '', '', '', moneyPlain(cash), ''], ['Bank transfer', '', '', '', '', moneyPlain(bank), '']);
    const name = view === 'month' ? `takings-${month}.csv` : `takings-tax-year-${ty.label.replace('–', '-')}.csv`;
    const file = new File([toCsv(lines)], name, { type: 'text/csv' });
    // A finished tax year's spreadsheet: Today stops reminding her about it. One saved while the year
    // is still running stops short, so the reminder after 5 April still comes.
    const saved = () => { if (view === 'year' && today > ty.to) rememberSpreadsheet(Number(ty.from.slice(0, 4))); toast('Check it’s in Files'); };
    try {
      await saveFile([file]);
      saved();
    } catch (e) {
      if (isAbort(e)) return; // she closed the share sheet
      // The share sheet couldn't open: download it instead.
      downloadFile(file, name);
      saved();
    }
  }
  const canShare = !!firstShareable([new File([''], 'takings.csv', { type: 'text/csv' })]);

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
          {view === 'month' && total > 0 && (
            <MonthPutAside month={month} today={today} tz={tz} version={`${rows.length}:${total}`} />
          )}
          {view === 'month' && <NewClientsCard month={month} today={today} tz={tz} />}
          <button className="btn block od-export" disabled={!rows.length || loading} onClick={exportCsv}><Glyph name="download" size={20} /> Save spreadsheet (CSV)</button>
          {canShare && rows.length > 0 && <p className="od-export-hint">Choose Save to Files, or send it to your accountant.</p>}
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

/**
 * Month view: roughly how much of the month's takings to put aside for tax. That's how much they
 * raise the tax year's estimate, with her own figures for the year (lib/tax monthPutAside), so it
 * grows as her profit for the year passes the tax-free allowance. `version` changes when the
 * month's entries do.
 */
function MonthPutAside({ month, today, tz, version }: { month: string; today: string; tz: string; version: string }) {
  const parts = monthTaxParts(month);
  const from = taxYearDays(parts[0].taxYearStart).first;
  const to = parts[parts.length - 1].to;
  const key = `${month}/${version}`;
  const { data } = useLoad(async () => {
    const [payments, ...figures] = await Promise.all([api.listPayments(from, to), ...parts.map((p) => api.getTaxYear(p.taxYearStart))]);
    return { key, payments, figures };
  }, [key]);
  // Only this month's, once it's in; if it can't be worked out, the line is left off.
  if (!data || data.key !== key) return null;
  const figuresFor = (year: number) => data.figures.find((r) => r.start_year === year) ?? emptyTaxYear(year);
  const { takingsPence, putAsidePence } = monthPutAside(month, data.payments, figuresFor);
  if (takingsPence <= 0) return null;
  // Never "nothing to put aside" for an amount that rounds down to £0.
  const pounds = putAsidePence > 0 ? Math.max(1, wholePounds(putAsidePence)) : 0;
  const current = month === today.slice(0, 7);
  const name = fmt(`${month}-15T12:00:00Z`, 'MMMM', tz);
  // Only the tax years this month's takings are in: April's 1st to 5th are in the year before.
  const takenIn = (p: { from: string; to: string }) =>
    data.payments.reduce((n, x) => (x.paid_on >= p.from && x.paid_on <= p.to ? n + x.amount_pence : n), 0);
  const years = parts.filter((p) => takenIn(p) > 0).map((p) => yearLabel(p.taxYearStart)).join(' and ');
  const taken = current ? <>the <b>{money(takingsPence)}</b> taken so far this month,</> : <>{name}’s <b>{money(takingsPence)}</b></>;
  // Nothing saved with Edit for the tax year: takings from before she switched apps are missing, so this is too low.
  const unsaved = parts.filter((p) => nothingSaved(figuresFor(p.taxYearStart)));
  return (
    <div className="od-putaside">
      <span className="od-putaside-ic" aria-hidden="true"><Glyph name="pound" size={20} /></span>
      <div className="od-putaside-text">
        {pounds > 0 ? (
          <>
            <p className="od-putaside-main">Put aside about <b>{showPounds(pounds)}</b> of {taken} for tax.</p>
            <p className="od-putaside-sub">That’s how much {current ? 'this month' : name} adds to your rough tax estimate for {years}.</p>
          </>
        ) : (
          <p className="od-putaside-main">
            Nothing to put aside for tax from {current ? <>the <b>{money(takingsPence)}</b> taken so far this month</> : taken}: on your
            figures, your profit for {years} {current ? 'is' : 'was'} still tax-free.
          </p>
        )}
        {unsaved.length > 0 && (
          <p className="od-putaside-sub">
            Took money another way in {unsaved.map((p) => yearLabel(p.taxYearStart)).join(' or ')}, such as through another app? Add it
            under Tax year → <b>Edit</b>, or this will be too low.
          </p>
        )}
      </div>
    </div>
  );
}

/** One month's new clients, and the month before's to compare (NewClientsCard). */
export interface NewClientsData {
  month: string;
  now: NewClientsSummary;
  before: NewClientsSummary;
}

/**
 * Month view: the new clients who booked this month (listNewClientBookings, each counted once by
 * summariseNewClients), how they found her and the links they used, with last month's total. Plain
 * numbers. Bookings count in the month they were made.
 */
function NewClientsCard({ month, today, tz }: { month: string; today: string; tz: string }) {
  const { data, error } = useLoad(async (): Promise<NewClientsData> => {
    const start = (ym: string) => startOfDayInstant(`${ym}-01`, tz);
    const rows = await api.listNewClientBookings(start(shiftMonth(month, -1)).toISOString(), start(shiftMonth(month, 1)).toISOString());
    const from = start(month).getTime();
    const inMonth = (r: { created_at: string }) => new Date(r.created_at).getTime() >= from;
    return { month, now: summariseNewClients(rows.filter(inMonth)), before: summariseNewClients(rows.filter((r) => !inMonth(r))) };
  }, [month]);
  return <NewClientsView month={month} today={today} tz={tz} data={data?.month === month ? data : null} error={error} />;
}

/**
 * The New clients card for what has loaded (exported for the tests). Before the database update there's
 * nothing to count yet: one line says who to ask, instead of an error. Nothing while it loads.
 */
export function NewClientsView({ month, today, tz, data, error }: {
  /** "2026-11" */
  month: string;
  /** yyyy-mm-dd in the business's time zone. */
  today: string;
  tz: string;
  /** This month's, once it's in (never another month's). */
  data: NewClientsData | null;
  error: unknown;
}) {
  if (!data && !error) return null;
  const name = (ym: string) => fmt(`${ym}-15T12:00:00Z`, 'MMMM', tz);
  const text = data && {
    ...newClientsText(data.now, name(month), month >= today.slice(0, 7)),
    before: lastMonthText(data.before, name(shiftMonth(month, -1))),
  };
  return (
    <section className="card od-newclients" aria-labelledby="od-newclients-h">
      <h2 id="od-newclients-h" className="od-newclients-h">
        <span className="od-ic small lilac" aria-hidden="true"><Glyph name="user" size={18} /></span>
        New clients
      </h2>
      {text ? (
        <div className="od-newclients-text">
          <p className="od-newclients-main">{text.headline}</p>
          {text.answers && <p>{text.answers}</p>}
          {text.links && <p>{text.links}</p>}
          <p className="od-newclients-before">{text.before}</p>
        </div>
      ) : isNeedsUpdate(error) ? (
        <p className="sub od-newclients-update">
          New clients will show here once the app’s database update has been run: ask whoever set up the app (see SETUP.md).
        </p>
      ) : <ErrorBox error={error} />}
    </section>
  );
}

/** Whole pounds, for an estimate: 141180 → 1412. */
const toPounds = wholePounds;
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
 * the year (takings not in the app, expenses) come from Edit. Exported for the tests.
 */
export function TaxCard({ startYear, rangeLabel, today, takingsPence, hasTakings }: {
  startYear: number; rangeLabel: string; today: string; takingsPence: number; hasTakings: boolean;
}) {
  const { data, error, loading, setData, reload } = useLoad(async () => ({ year: startYear, row: await api.getTaxYear(startYear) }), [startYear]);
  const [editing, setEditing] = useState(false);
  const toast = useToast();
  const { row, failed } = taxCardState(data, error, loading, startYear);
  const label = yearLabel(startYear);
  return (
    <>
      <TaxCardView startYear={startYear} today={today} takingsPence={takingsPence} hasTakings={hasTakings}
        row={row} failed={failed} onEdit={() => setEditing(true)} onRetry={reload} />
      {/* Outside the card: while the card slides in, a sheet inside it would be placed against the card, not the screen. */}
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
    </>
  );
}

/** The card for what has loaded so far (exported for the tests). */
export function TaxCardView({ startYear, today, takingsPence, hasTakings, row, failed, onEdit, onRetry }: {
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
    </section>
  );
}

/** A tax year's label kept on one line: "2026–27". */
const Year = ({ start }: { start: number }) => <span className="od-nowrap">{yearLabel(start)}</span>;
/** A date kept on one line: "31 January 2028". */
const When = ({ d }: { d: TaxDate | string }) => <span className="od-nowrap">{typeof d === 'string' ? d : d.label}</span>;
/** "6 April 2028": the day a Making Tax Digital stage starts. */
const mtdStart = (s: MtdStage) => `6 April ${s.fromYear}`;

/**
 * On this tax year's card, above its own due date: what an earlier tax year still has due
 * before then (see dueFromEarlierYear), and where to see how much.
 */
function EarlierDue({ startYear, today }: { startYear: number; today: string }) {
  const due = dueFromEarlierYear(startYear, today);
  if (!due) return null;
  const year = <Year start={due.billYear} />;
  const back = <>Tap <b>‹</b>{startYear - due.billYear > 1 ? ' twice' : ''} at the top to see {year}.</>;
  return (
    <p className="od-taxcard-due-line od-taxcard-first">
      <span className="od-taxcard-due-ic" aria-hidden="true"><Glyph name="calendar" size={17} /></span>
      <span>
        {due.kind === 'july' ? (
          <>
            Due next, if HMRC asked for payments on account: half your {year} bill again, by <b><When d={due.date} /></b>, towards{' '}
            {due.billYear + 1 === startYear ? 'this year’s bill' : <Year start={due.billYear + 1} />}. {back}
          </>
        ) : (
          <>
            Due first, if you worked in {year}: its tax return and bill, by <b><When d={due.date} /></b>.
            {due.onAccount && (
              <> If that bill is {money(PAYMENTS_ON_ACCOUNT_FROM)} or more, HMRC usually also asks for half of it again then, and another
                half by <When d={due.onAccount.second} />, both towards this year’s bill.</>
            )}{' '}
            {back}
          </>
        )}
      </span>
    </p>
  );
}

/** What the year before's bill pays towards this one in advance (payments on account), and what that means for this bill. */
function PaidAhead({ startYear, today }: { startYear: number; today: string }) {
  const dates = taxDates(startYear);
  if (!dates.thisYear) return <>If you already pay towards your tax in advance, part of this bill will have been paid during the year.</>;
  const firstGone = today > dates.thisYear.first.iso;
  const secondGone = today > dates.thisYear.second.iso;
  return (
    <>
      Was your <Year start={startYear - 1} /> bill {money(PAYMENTS_ON_ACCOUNT_FROM)} or more? Then half of it
      again {firstGone ? 'went' : 'goes'} towards this bill by <When d={dates.thisYear.first} />, and another
      half {firstGone && !secondGone ? 'goes ' : ''}by <When d={dates.thisYear.second} />, so
      there{today > dates.balancing.iso ? ' was' : '’s'} that much less to pay on <When d={dates.balancing} />.
    </>
  );
}

/** A dated payment in the plan, with a line under it for what it's for and, for a weekend date, when to pay to be safe. */
function PlanRow({ d, pounds, why }: { d: TaxDate; pounds: number; why?: ReactNode }) {
  const weekend = weekendDue(d.iso);
  return (
    <div>
      <dt>By <When d={d} /></dt><dd>{showPounds(pounds)}</dd>
      {(why || weekend) && (
        <dd className="od-taxcard-why">
          {why}{why && weekend ? ' ' : ''}{weekend && <>That’s a {weekend.day}: to be safe, pay by {weekend.friday}.</>}
        </dd>
      )}
    </div>
  );
}

/** "26p of each £1 you take: 20p Income Tax and 6p National Insurance.", for the next £1 of a profit. */
function PutAside({ profit, r }: { profit: number; r: TaxRates }) {
  const m = marginalRatesAt(profit, r);
  const incomeTax = Math.round(m.incomeTax * 100);
  const ni = Math.round(m.class4 * 100);
  return (
    <>
      put aside about <b>{incomeTax + ni}p of each £1</b> you take
      {incomeTax > 0 && ni > 0 ? `: ${incomeTax}p Income Tax and ${ni}p National Insurance` : ''}.
    </>
  );
}

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
    <>
      <div className="od-taxcard-empty">
        <p className="od-taxcard-empty-h">{title}</p>
        <p className="sub">{text}</p>
      </div>
      <EarlierDue startYear={startYear} today={today} />
    </>
  );
}

function TaxFigures({ startYear, today, takingsPence, row }: { startYear: number; today: string; takingsPence: number; row: TaxYear }) {
  const e = estimateTax({
    taxYearStart: startYear, takingsPence, extraTakingsPence: row.extra_takings_pence, expensesPence: row.expenses_pence,
  });
  const r = e.rates;
  const days = taxYearDays(startYear);
  const ended = today > days.last;
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
  // The bill and each payment on account in whole pounds, the same as Today's tax card (lib/tax).
  const { bill: total, onAccount } = billInPounds(e);
  const share = Math.round(e.shareOfTakings * 100);
  const allowance = showPounds(allowancePounds);
  // The trading allowance is the one figure that changes for 2027–28, and that isn't law yet.
  const notLaw = r.announced ? ' (announced, not law yet)' : '';
  const personal = showPounds(toPounds(r.personalAllowance));
  // A bill of £1,000 or more usually brings two payments on account towards the next
  // tax year, each half of it (onAccount): by 31 January, on top of the bill, and by 31 July.
  // Both of them until the bill is due, then the July one on its own until that's due too.
  const plan = onAccount > 0 && !duePassed ? dates.nextYear : null;
  const julyOnly = onAccount > 0 && duePassed && dates.nextYear && today <= dates.nextYear.second.iso ? dates.nextYear.second : null;
  // On this year's card, the line above the due date can already say what the year before's
  // bill pays towards this one in advance; then the plan only says what that means for it.
  const earlier = dueFromEarlierYear(startYear, today);
  const paidAheadAbove = earlier?.kind === 'bill' && !!earlier.onAccount;
  const payWeekend = total > 0 && !duePassed ? weekendDue(dates.balancing.iso) : null;
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
            ? <>{ended ? 'For the whole tax year' : 'So far this tax year'}: {share > 0 ? `about ${share}%` : 'less than 1%'} of your takings
              {e.profit <= r.taperFrom ? <>, as the first {personal} of profit is tax-free</> : ''}.</>
            : <>{ended ? 'Nothing to pay' : 'Nothing yet'}: the first {personal} of profit each tax year is tax-free.</>}
        </p>
      </div>
      {/* Until she uses Edit, takings from another app (most of the year she switched) are missing. */}
      {nothingSaved(row) && today >= days.first && (
        <p className="od-taxcard-tip od-taxcard-ask">
          {ended
            ? <>Took money another way in <Year start={startYear} />, such as through another app? Tap <b>Edit</b> to add it, with your
              expenses.</>
            : <>Took money another way this tax year, such as bookings through another app before you switched? Tap <b>Edit</b> to add
              it, with your expenses.</>}
        </p>
      )}
      <dl className="od-taxcard-rows">
        <div><dt>Takings in the app</dt><dd>{showPounds(inApp)}</dd></div>
        <div><dt>Takings not in the app</dt><dd>{showPounds(other)}</dd></div>
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
                ? <>Takings of {allowance} or less in a tax year are tax-free: that’s the trading allowance{notLaw}.</>
                : e.expenses > 0
                  ? <>Used instead of your {money(e.expenses)} of expenses, as {notLaw ? <>the {allowance} allowance{notLaw} is</> : 'it’s'} bigger:
                    it’s one or the other, not both.</>
                  : <>With no expenses added, the {allowance} trading allowance{notLaw} comes off instead.</>}
            </dd>
          </div>
        )}
        <div className="od-taxcard-profit"><dt>Profit</dt><dd>{showPounds(profit)}</dd></div>
        <div><dt>Income Tax</dt><dd>{showPounds(incomeTax)}</dd></div>
        <div><dt>Class 4 National Insurance</dt><dd>{showPounds(class4)}</dd></div>
      </dl>
      {!ended && (
        <p className="od-taxcard-tip">
          {e.marginalRate > 0
            ? <>From here, <PutAside profit={e.profit} r={r} /></>
            : <>Once your profit for the year is over {personal}, <PutAside profit={r.personalAllowance} r={r} /></>}
        </p>
      )}
      <EarlierDue startYear={startYear} today={today} />
      <p className="od-taxcard-due-line">
        <span className="od-taxcard-due-ic" aria-hidden="true"><Glyph name="calendar" size={17} /></span>
        <span>
          {duePassed
            ? <>Your <Year start={startYear} /> tax return{total > 0 ? ' and bill were' : ' was'} due by <b><When d={dates.balancing} /></b>.</>
            : plan
              ? <>Send your <Year start={startYear} /> tax return online by <b><When d={dates.balancing} /></b>
                {ended ? ', and pay HMRC:' : '. On the figures so far, you’ll pay HMRC:'}</>
              : <>Send your <Year start={startYear} /> tax return online{total > 0 ? ' and pay the bill' : ''} by{' '}
                <b><When d={dates.balancing} /></b>{payWeekend ? ` (a ${payWeekend.day}: to be safe, pay by ${payWeekend.friday})` : ''}.</>}
        </span>
      </p>
      {plan && (
        <div className="od-taxcard-plan">
          <dl className="od-taxcard-rows">
            <PlanRow d={plan.first} pounds={total + onAccount}
              why={<>This bill, plus {showPounds(onAccount)} towards <Year start={startYear + 1} />.</>} />
            <PlanRow d={plan.second} pounds={onAccount} />
          </dl>
          <p>
            The two {showPounds(onAccount)} payments go towards <Year start={startYear + 1} /> (“payments on account”): when a bill
            is {money(PAYMENTS_ON_ACCOUNT_FROM)} or more, HMRC usually asks for half of it again, twice.
          </p>
          <p className="od-taxcard-small">
            {paidAheadAbove
              ? <>Paying part of this bill early, as above? Then there’s that much less to pay on <When d={dates.balancing} />.</>
              : <PaidAhead startYear={startYear} today={today} />}
          </p>
        </div>
      )}
      {julyOnly && (
        <div className="od-taxcard-plan">
          <p>
            HMRC usually also asks for a second payment towards <Year start={startYear + 1} />, half of this bill (a “payment on
            account”):
          </p>
          <dl className="od-taxcard-rows"><PlanRow d={julyOnly} pounds={onAccount} /></dl>
        </div>
      )}
      {onAccount > 0 && !duePassed && !dates.nextYear && (
        <p className="od-taxcard-plan">
          A bill of {money(PAYMENTS_ON_ACCOUNT_FROM)} or more usually also means paying towards the next tax year in advance. From April
          2029, HMRC plans to collect that in smaller automatic payments during the year: the details are still to come.
        </p>
      )}
      {mtd && <MtdNotice mtd={mtd} today={today} ended={ended} />}
      <details className="od-more od-taxcard-more">
        <summary>How it’s paid</summary>
        <div className="stack od-taxcard-due">
          {/* The plan above already says these two. */}
          {!plan && (dates.nextYear ? (
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
          ))}
          {!plan && <p className="sub"><PaidAhead startYear={startYear} today={today} /></p>}
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
        {/* Class 4 was 9% before April 2024, but only on profit over £12,570: below that the bill was £0 then too. */}
        {e.ratesYear > startYear && e.class4 > 0 && <> National Insurance was higher before April 2024, so the real bill for <Year start={startYear} /> was higher.</>}
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

/** This tax year's takings bring in Making Tax Digital: from when (at the latest), what it means, and that this app can't do it. */
function MtdNotice({ mtd, today, ended }: { mtd: MtdStage & { earlier: MtdStage[] }; today: string; ended: boolean }) {
  const started = today >= `${mtd.fromYear}-04-06`;
  // One earlier stage fits in a sentence; more go in a list, with the £20,000 years on one line so a far-off year's list stays short.
  const one = mtd.earlier.length === 1 ? mtd.earlier[0] : null;
  const twenty = mtd.earlier.filter((s) => s.threshold === mtdStage(2026)!.threshold);
  const higher = mtd.earlier.filter((s) => s.threshold !== mtdStage(2026)!.threshold);
  return (
    <div className="notice warn od-taxcard-mtd">
      <p>
        Your <Year start={mtd.testYear} /> takings {ended ? 'were' : 'are'} over {money(mtd.threshold)}, so under current rules{' '}
        {started
          ? <>Making Tax Digital has applied to you since <When d={mtdStart(mtd)} />{mtd.earlier.length ? ' or earlier' : ''}. You need
            software that works with it, to keep digital records and send HMRC an update every quarter (by 7 August, 7 November,
            7 February and 7 May).</>
          : <>Making Tax Digital starts for you by <When d={mtdStart(mtd)} />. From then you’ll need software that works with it, to
            keep digital records and send HMRC an update every quarter, the first by <When d={`7 August ${mtd.fromYear}`} />.</>}
        {' '}This app doesn’t send them.
      </p>
      {one && (
        <p>
          It {today >= `${one.fromYear}-04-06` ? 'started' : 'starts'} sooner, on <When d={mtdStart(one)} />, if
          your <Year start={one.testYear} /> takings were over {money(one.threshold)}.
        </p>
      )}
      {mtd.earlier.length > 1 && (
        <>
          <p>It can start sooner, if an earlier tax year’s takings were over that year’s limit:</p>
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
          using software that works with Making Tax Digital. This app doesn’t send them.
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
  const toast = useToast();
  // Closed while saving? Then a failure can't show in the sheet, so it's a toast instead.
  const open = useRef(true);
  useEffect(() => { open.current = true; return () => { open.current = false; }; }, []);
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
    } else if (!open.current) {
      toast(`Your figures for ${yearLabel(startYear)} weren’t saved. Tap Edit to try again.`);
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
            hint={`Money from your nail work in ${yearLabel(startYear)} that isn’t recorded in this app, such as bookings paid through another app `
              + 'before you switched. Use what clients paid, before that app’s fees.'}>
            <input type="text" inputMode="decimal" autoComplete="off" placeholder="0" value={f.extra}
              onChange={(ev) => setF({ ...f, extra: ev.target.value })} />
          </Field>
        </div>
        <div className="od-amount od-amount-tip">
          <Field label="Business expenses (£)"
            hint={<>What the business {ended ? 'cost' : 'has cost'} you in {yearLabel(startYear)}: products, tools, PPE, training, insurance, booking-app
              fees, and a share of your phone and home costs. Keep the receipts. Under {allowance}? The estimate uses the {allowance} trading
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
