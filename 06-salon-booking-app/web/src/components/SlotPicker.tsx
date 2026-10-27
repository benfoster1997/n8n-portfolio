import { useEffect, useMemo, useRef } from 'react';
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

/** The strip of days and the grid of start times, shared by the booking page and the manage page. */
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
  return (
    <>
      <div className="date-strip" role="listbox" aria-label="Days" ref={strip}>
        {days.map((d) => (
          <button key={d} role="option" aria-selected={d === day} className={`date-pill${d === day ? ' on' : ''}`} onClick={() => onDay(d)}>
            <div className="dow">{fmt(d + 'T12:00:00Z', 'EEE', tz)}</div>
            <div className="dom">{Number(d.slice(8))}</div>
            <div className="mon">{fmt(d + 'T12:00:00Z', 'MMM', tz)}</div>
          </button>
        ))}
      </div>
      {day && (
        <>
          <div className="sub">{fmtDayLong(day + 'T12:00:00Z', tz)}</div>
          <div className="slot-grid">
            {(slotsByDay.get(day) ?? []).map((d) => {
              const on = slot?.getTime() === d.getTime();
              return <button key={d.toISOString()} className={`slot${on ? ' on' : ''}`} aria-pressed={on} onClick={() => onSlot(d)}>{fmtTime(d, tz)}</button>;
            })}
          </div>
        </>
      )}
    </>
  );
}
