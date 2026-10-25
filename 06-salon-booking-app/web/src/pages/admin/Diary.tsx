import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { ApptRow } from '../../components/appts';
import { useOwner } from '../../components/owner';
import { ErrorBox, Field, Icon, Seg, Sheet, Spinner, TopBar, useAction, useLoad, useToast } from '../../components/ui';
import { addDays, dateInZone, fmt, fmtDayLong, fmtTime, isoWeekday, startOfDayInstant, startOfWeek, todayInZone, zonedToInstant } from '../../lib/time';

export function Diary() {
  const { settings: s } = useOwner();
  const tz = s.timezone;
  const today = todayInZone(tz);
  const [params, setParams] = useSearchParams();
  const day = params.get('d') ?? today;
  const week = startOfWeek(day);
  const [blocking, setBlocking] = useState(false);

  const { data, error, loading, reload } = useLoad(async () => {
    const from = startOfDayInstant(week, tz).toISOString();
    const to = startOfDayInstant(addDays(week, 7), tz).toISOString();
    const [appts, off, hours] = await Promise.all([api.listAppointments(from, to), api.listTimeOff(from), api.listOpeningHours()]);
    return { appts, off: off.filter((t) => t.starts_at < to), hours };
  }, [week]);

  const pick = (d: string) => setParams({ d }, { replace: true });
  const dayStart = startOfDayInstant(day, tz).toISOString();
  const dayEnd = startOfDayInstant(addDays(day, 1), tz).toISOString();
  const appts = (data?.appts ?? []).filter((a) => a.starts_at >= dayStart && a.starts_at < dayEnd);
  const active = appts.filter((a) => a.status !== 'cancelled');
  const cancelled = appts.filter((a) => a.status === 'cancelled');
  const off = (data?.off ?? []).filter((t) => t.starts_at < dayEnd && t.ends_at > dayStart);
  const hours = data?.hours.find((h) => h.weekday === isoWeekday(day));
  const countFor = (d: string) => (data?.appts ?? []).filter((a) => a.status !== 'cancelled' && dateInZone(a.starts_at, tz) === d).length;

  return (
    <div className="page">
      <TopBar title="Diary" right={<>
        <button className="btn small" onClick={() => setBlocking(true)}>Block time</button>
        <Link className="icon-btn" to={`/appointments/new?d=${day}`} aria-label="New appointment"><Icon name="plus" /></Link>
      </>} />
      <div className="row spread" style={{ marginBottom: 8 }}>
        <button className="icon-btn" aria-label="Previous week" onClick={() => pick(addDays(week, -7))}><Icon name="left" /></button>
        <button className="btn ghost small" onClick={() => pick(today)}>{fmt(week + 'T12:00:00Z', 'MMMM yyyy', tz)} · Today</button>
        <button className="icon-btn" aria-label="Next week" onClick={() => pick(addDays(week, 7))}><Icon name="right" /></button>
      </div>
      <div className="date-strip" style={{ justifyContent: 'space-between' }}>
        {Array.from({ length: 7 }, (_, i) => addDays(week, i)).map((d) => {
          const n = countFor(d);
          return (
            <button key={d} className={`date-pill${d === day ? ' on' : ''}${d === today ? ' today' : ''}`} style={{ width: 'auto', flex: '1 0 44px' }}
              onClick={() => pick(d)} aria-label={`${fmtDayLong(d + 'T12:00:00Z', tz)}, ${n} appointments`}>
              <div className="dow">{fmt(d + 'T12:00:00Z', 'EEEEE', tz)}</div>
              <div className="dom">{Number(d.slice(8))}</div>
              <div className="mon">{n ? '•'.repeat(Math.min(n, 4)) : ' '}</div>
            </button>
          );
        })}
      </div>
      <div className="day-head">
        <h2>{fmtDayLong(day + 'T12:00:00Z', tz)}</h2>
        <span className="sub">{hours?.is_open ? `Open ${hours.open_time}–${hours.close_time}` : 'Closed'}</span>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? <Spinner /> : (
        <div className="card tight">
          {off.length === 0 && active.length === 0 ? <div className="empty">Nothing booked.</div> : (
            <ul className="list">
              {off.map((t) => (
                <li key={t.id} className="list-row timeoff-row">
                  <div className="time-col">{t.starts_at <= dayStart ? 'All' : fmtTime(t.starts_at, tz)}<small>{t.ends_at >= dayEnd ? 'day' : `to ${fmtTime(t.ends_at, tz)}`}</small></div>
                  <div className="grow"><div className="title">Blocked</div><div className="meta">{t.note || 'Time off'}</div></div>
                  <Link className="btn small" to="/settings/time-off">Edit</Link>
                </li>
              ))}
              {active.map((a) => <ApptRow key={a.id} a={a} tz={tz} />)}
            </ul>
          )}
        </div>
      )}
      {cancelled.length > 0 && (
        <>
          <div className="section-title">Cancelled</div>
          <div className="card tight"><ul className="list">{cancelled.map((a) => <ApptRow key={a.id} a={a} tz={tz} />)}</ul></div>
        </>
      )}
      {blocking && <BlockTimeSheet day={day} tz={tz} onClose={() => setBlocking(false)} onSaved={() => { setBlocking(false); reload(); }} />}
    </div>
  );
}

export function BlockTimeSheet({ day, tz, onClose, onSaved }: { day: string; tz: string; onClose: () => void; onSaved: () => void }) {
  const [kind, setKind] = useState<'day' | 'hours'>('day');
  const [from, setFrom] = useState(day);
  const [to, setTo] = useState(day);
  const [startTime, setStartTime] = useState('12:00');
  const [endTime, setEndTime] = useState('13:00');
  const [note, setNote] = useState('');
  const { busy, error, run, setError } = useAction();
  const toast = useToast();

  async function save() {
    const starts = kind === 'day' ? startOfDayInstant(from, tz) : zonedToInstant(from, startTime, tz);
    const ends = kind === 'day' ? startOfDayInstant(addDays(to, 1), tz) : zonedToInstant(from, endTime, tz);
    if (ends <= starts) { setError(new Error('The end must be after the start.')); return; }
    if (await run(() => api.addTimeOff({ starts_at: starts.toISOString(), ends_at: ends.toISOString(), note: note.trim() || null }))) {
      toast('Time blocked — clients can’t book it');
      onSaved();
    }
  }

  return (
    <Sheet title="Block time" onClose={onClose}>
      <div className="stack">
        <Seg label="Length" value={kind} onChange={setKind} options={[{ value: 'day', label: 'Whole days' }, { value: 'hours', label: 'Part of a day' }]} />
        {kind === 'day' ? (
          <div className="row">
            <Field label="From"><input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (e.target.value > to) setTo(e.target.value); }} /></Field>
            <Field label="To (inclusive)"><input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></Field>
          </div>
        ) : (
          <>
            <Field label="Date"><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
            <div className="row">
              <Field label="From"><input type="time" step={300} value={startTime} onChange={(e) => setStartTime(e.target.value)} /></Field>
              <Field label="To"><input type="time" step={300} value={endTime} onChange={(e) => setEndTime(e.target.value)} /></Field>
            </div>
          </>
        )}
        <Field label="Note (only you see this)"><input type="text" value={note} maxLength={200} placeholder="Holiday, training, lunch…" onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorBox error={error} />
        <button className="btn primary block" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Block this time'}</button>
      </div>
    </Sheet>
  );
}
