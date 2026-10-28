import { Fragment, useState } from 'react';
import { api } from '../../api';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { fmt, todayInZone } from '../../lib/time';
import { downloadText, friendlyError, money, moneyPlain, parsePounds, taxYearOf, toCsv } from '../../lib/text';
import type { PayKind, PayMethod, Payment } from '../../lib/types';
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
          <div className="stat-grid od-stats">
            <div className="stat od-stat-total" style={{ gridColumn: '1 / -1' }}>
              <LemonSlice size={92} className="od-stat-lemon" />
              <div className="label">Money received</div>
              <div className="value">{money(total)}</div>
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
          <button className="btn block od-export" disabled={!rows.length || loading} onClick={exportCsv}><Glyph name="download" size={20} /> Download spreadsheet (CSV)</button>
          <p className="od-tax-note">
            <span className="od-tax-note-ic" aria-hidden="true"><Glyph name="receipt" size={17} /></span>
            This is your record of money received, for your Self Assessment. Keep receipts for your expenses (products, training, insurance) separately — they reduce your tax bill.
          </p>
          {[...byDay.entries()].map(([day, list]) => (
            <div key={day} className="od-day">
              <div className="day-head"><h2>{fmt(`${day}T12:00:00Z`, 'EEE d MMM', tz)}</h2><span className="od-day-total">{money(list.reduce((n, p) => n + p.amount_pence, 0))}</span></div>
              <div className="card tight"><ul className="list">
                {list.map((p) => (
                  <li key={p.id} className={`list-row od-pay${p.amount_pence < 0 ? ' od-pay-out' : ''}`}>
                    <span className={`od-ic small ${p.kind === 'refund' ? 'danger' : p.kind === 'tip' ? 'pink' : p.method === 'cash' ? 'lemon' : 'lilac'}`} aria-hidden="true">
                      {p.kind === 'refund' ? <Glyph name="refund" size={18} /> : p.kind === 'tip' ? <Heart size={16} /> : <Glyph name={p.method === 'cash' ? 'cash' : 'bank'} size={18} />}
                    </span>
                    <div className="grow">
                      <div className="title">{p.client_name || p.description || KIND_LABEL[p.kind]}</div>
                      <div className="meta"><MetaParts parts={[p.client_name ? p.description : null, KIND_LABEL[p.kind], METHOD_LABEL[p.method], p.note]} /></div>
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
                ))}
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
