import { useEffect, useId, useMemo, useRef } from 'react';
import { availableSlots } from '../lib/slots';
import { fmt, fmtDayLong, fmtTime } from '../lib/time';
import type { BookingInfo, BusyRange } from '../lib/types';

/** Free start times on each of these days for a treatment of this length (none until the busy times have loaded). */
export function useFreeSlots(info: BookingInfo, days: string[], durationMin: number | null, busy: BusyRange[] | undefined) {
  const slotsByDay = useMemo(() => {
    const m = new Map<string, Date[]>();
    if (!durationMin || !busy) return m;
    for (const d of days) m.set(d, availableSlots(d, durationMin, info, busy));
    return m;
  }, [durationMin, busy, days, info]);
  const daysWithSlots = useMemo(() => days.filter((d) => (slotsByDay.get(d)?.length ?? 0) > 0), [days, slotsByDay]);
  return { slotsByDay, daysWithSlots };
}

const PARTS = [
  { key: 'morning', label: 'Morning', until: 12 },
  { key: 'afternoon', label: 'Afternoon', until: 17 },
  { key: 'evening', label: 'Evening', until: 24 },
] as const;

/** Start times split into morning, afternoon and evening (by the hour in the business's time zone). */
function byPartOfDay(slots: Date[], tz: string) {
  return PARTS.map((p, i) => ({
    ...p,
    slots: slots.filter((d) => {
      const h = Number(fmt(d, 'H', tz));
      return h < p.until && (i === 0 || h >= PARTS[i - 1].until);
    }),
  })).filter((p) => p.slots.length > 0);
}

/**
 * The strip of days and the grid of start times, shared by the booking page and the manage page.
 * The month of the chosen day sits above the strip; times are grouped into morning, afternoon
 * and evening.
 */
export function SlotPicker({ days, slotsByDay, day, slot, tz, onDay, onSlot }: {
  days: string[];
  slotsByDay: Map<string, Date[]>;
  day: string | null;
  slot: Date | null;
  tz: string;
  onDay: (d: string) => void;
  onSlot: (d: Date) => void;
}) {
  // Bring the chosen day into view in the strip (centred) when it isn't already, e.g. a booking a
  // fortnight out. Only the strip scrolls: the page itself stays where it is.
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = strip.current;
    const pill = el?.querySelector<HTMLElement>('.date-pill.on');
    if (!el || !pill) return;
    const s = el.getBoundingClientRect(), p = pill.getBoundingClientRect();
    if (p.left >= s.left && p.right <= s.right) return;
    el.scrollLeft += p.left + p.width / 2 - (s.left + s.width / 2);
  }, [day, days]);
  const groupId = useId();
  const monthOf = day ?? days[0];
  const parts = useMemo(() => (day ? byPartOfDay(slotsByDay.get(day) ?? [], tz) : []), [day, slotsByDay, tz]);
  return (
    <>
      {monthOf && (
        <div className="slot-month" aria-hidden="true">
          <span className="slot-month-name">{fmt(monthOf + 'T12:00:00Z', 'MMMM', tz)}</span>
          <span className="slot-month-year">{fmt(monthOf + 'T12:00:00Z', 'yyyy', tz)}</span>
          {days.length > 5 && <span className="slot-month-more">Swipe for more days</span>}
        </div>
      )}
      <div className="date-strip" role="listbox" aria-label="Days" ref={strip}>
        {days.map((d, i) => {
          const newMonth = i > 0 && d.slice(0, 7) !== days[i - 1].slice(0, 7);
          return (
            <button key={d} role="option" aria-selected={d === day} className={`date-pill${d === day ? ' on' : ''}${newMonth ? ' new-month' : ''}`} onClick={() => onDay(d)}>
              <div className="dow">{fmt(d + 'T12:00:00Z', 'EEE', tz)}</div>
              <div className="dom">{Number(d.slice(8))}</div>
              <div className="mon">{fmt(d + 'T12:00:00Z', 'MMM', tz)}</div>
            </button>
          );
        })}
      </div>
      {day && (
        <>
          <div className="sub slot-day">{fmtDayLong(day + 'T12:00:00Z', tz)}</div>
          <div className="slot-parts">
            {parts.map((p) => (
              <div key={p.key} className={`slot-part slot-part--${p.key}`}>
                <div className="slot-part-label" id={`${groupId}-${p.key}`}>{p.label}</div>
                <div className="slot-grid" role="group" aria-labelledby={`${groupId}-${p.key}`}>
                  {p.slots.map((d) => {
                    const on = slot?.getTime() === d.getTime();
                    return <button key={d.toISOString()} className={`slot${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onSlot(d)}>{fmtTime(d, tz)}</button>;
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </>
  );
}
