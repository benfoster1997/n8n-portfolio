// Pieces shared by the client pages (booking and manage-your-booking): the step
// indicator, the chosen-treatment summary, the appointment "ticket", the policy
// card, the celebration picture and the loading/problem states.
// Styles are in styles/public.css. Decorative SVG is aria-hidden throughout.
import { forwardRef, useId, type ReactNode } from 'react';
import { Blossom, BrandIcon, Heart, Lemon, LemonSlice, PolishBottle, ScriptTitle, Sprig } from '../brand';
import { fmt, minutesLabel } from '../../lib/time';
import { money } from '../../lib/text';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/* ------------------------------------------------------------- the steps */

/** "Treatment · Time · Details": done steps get a tick, the current one is pink. */
export function Steps({ labels, current }: { labels: string[]; current: number }) {
  return (
    <ol className="pub-steps" aria-label="Booking steps">
      {labels.map((label, i) => (
        <li key={label} className={i < current ? 'done' : i === current ? 'now' : undefined} aria-current={i === current ? 'step' : undefined}>
          <span className="pub-steps-dot" aria-hidden="true">
            {i < current
              ? <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round"><path d="M5.5 12.8l4.2 4.1 8.8-9.6" /></svg>
              : i + 1}
          </span>
          <span className="pub-steps-label">{label}</span>
        </li>
      ))}
    </ol>
  );
}

/* ------------------------------------------------ the chosen treatment */

/** The treatment they picked, with a control to go back and choose again. */
export function ChosenTreatment({ name, durationMin, pricePence, onChange }: {
  name: string; durationMin: number; pricePence: number; onChange: () => void;
}) {
  return (
    <div className="chosen">
      <span className="chosen-art" aria-hidden="true"><PolishBottle size={46} tilt={10} /></span>
      <div className="chosen-body">
        <span className="pub-kicker">Your treatment</span>
        <span className="chosen-name">{name}</span>
        <span className="chosen-meta">{minutesLabel(durationMin)} <span aria-hidden="true">·</span> <b className="chosen-price">{money(pricePence)}</b></span>
      </div>
      <button type="button" className="btn small chosen-change" onClick={onChange}>
        Change<span className="visually-hidden"> treatment</span>
      </button>
    </div>
  );
}

/** The main action of a step, kept within thumb's reach at the bottom of the screen. */
export function StickyAction({ children, when, tz }: { children: ReactNode; when?: Date | null; tz?: string }) {
  return (
    <div className={cx('pub-sticky', when !== undefined && 'pub-sticky--note')}>
      {when !== undefined && (
        <div className={cx('pub-sticky-note', !when && 'empty')}>
          {when && tz ? <><b>{fmt(when, 'HH:mm', tz)}</b><span>{fmt(when, 'EEE d MMM', tz)}</span></> : <span>Choose a time</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/** The arrow on a "Continue" button. */
export function NextArrow() {
  return (
    <svg className="pub-next-arrow" aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h13M13 6l6 6-6 6" />
    </svg>
  );
}

/* ------------------------------------------------------- the ticket */

/** A little calendar leaf: day, date and month. Decorative; the date is also written out in words. */
export function DateTile({ iso, tz, muted }: { iso: string | Date; tz: string; muted?: boolean }) {
  return (
    <span className={cx('date-tile', muted && 'muted')} aria-hidden="true">
      <span className="date-tile-dow">{fmt(iso, 'EEE', tz)}</span>
      <span className="date-tile-dom">{fmt(iso, 'd', tz)}</span>
      <span className="date-tile-mon">{fmt(iso, 'MMM', tz)}</span>
    </span>
  );
}

/**
 * An appointment card shaped like a ticket: a date leaf and the details on top, then a
 * perforation and a stub (the reference, or whatever `stub` holds). One `.card` element.
 */
export function Ticket({ iso, tz, muted, kicker, aside, title, titleAs: T = 'div', titleRef, titleFocusable, price, lines, stub, className, children }: {
  iso: string | Date; tz: string; muted?: boolean;
  kicker?: ReactNode; aside?: ReactNode;
  title: ReactNode; titleAs?: 'div' | 'h2' | 'h3'; titleRef?: (el: HTMLElement | null) => void; titleFocusable?: boolean;
  price?: string; lines?: ReactNode[]; stub?: ReactNode; className?: string; children?: ReactNode;
}) {
  return (
    <div className={cx('card ticket', muted && 'ticket--muted', className)}>
      <span className="ticket-slice" aria-hidden="true"><LemonSlice size={72} /></span>
      <div className="ticket-main">
        <DateTile iso={iso} tz={tz} muted={muted} />
        <div className="ticket-body">
          {(kicker || aside) && (
            <div className="ticket-top">
              {kicker && <span className="pub-kicker">{kicker}</span>}
              {aside}
            </div>
          )}
          <T className="ticket-title" ref={titleRef as never} tabIndex={titleFocusable ? -1 : undefined}>
            <span className="ticket-name">{title}</span>
            {price && <span className="ticket-tail"><span className="ticket-sep"> · </span><span className="ticket-price">{price}</span></span>}
          </T>
          {lines?.map((l, i) => <div key={i} className={i === 0 ? 'ticket-when' : 'ticket-line'}>{l}</div>)}
        </div>
      </div>
      {(stub || children) && <div className="ticket-perf" aria-hidden="true" />}
      {children}
      {stub && <div className="ticket-stub">{stub}</div>}
    </div>
  );
}

/** The reference, as the torn-off part of a ticket. */
export function RefStub({ reference, note }: { reference: string; note?: ReactNode }) {
  return (
    <>
      <span className="ticket-stub-label">Reference</span>
      <b className="mono ticket-ref">{reference}</b>
      {note && <span className="ticket-stub-note">{note}</span>}
    </>
  );
}

/* ------------------------------------------------------- the policy */

/** The cancellation policy as a calm note card. `note` makes it a labelled landmark for screen readers. */
export function PolicyCard({ title = 'Cancellation policy', titleAs: T = 'h2', note, late, className, children }: {
  title?: string; titleAs?: 'h2' | 'h3'; note?: boolean; late?: boolean; className?: string; children: ReactNode;
}) {
  const label = note ? { role: 'note', 'aria-label': 'Cancellation policy' } : {};
  return (
    <div className={cx('card policy policy-card', late && 'late', className)} {...label}>
      <span className="policy-ring" aria-hidden="true"><BrandIcon name="clock" size={20} strokeWidth={2} /></span>
      <div className="policy-body">
        <T className="policy-title">{title}</T>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------ section headings */

const GROUP_ICONS = {
  user: <><circle cx="12" cy="8.2" r="3.7" /><path d="M4.8 20.2c.9-3.9 3.7-6 7.2-6s6.3 2.1 7.2 6" /></>,
  sparkle: <path d="M12 3.6l1.7 4.9 4.9 1.7-4.9 1.7L12 16.8l-1.7-4.9-4.9-1.7 4.9-1.7ZM18.4 15.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7Z" />,
  shield: <><path d="M12 2.9l7.4 2.8v5.5c0 4.6-3 8.3-7.4 10-4.4-1.7-7.4-5.4-7.4-10V5.7Z" /><path d="M12 15.7c-2-1.5-3.5-2.8-3.5-4.4 0-1.1.8-1.9 1.8-1.9.7 0 1.4.4 1.7 1.1.3-.7 1-1.1 1.7-1.1 1 0 1.8.8 1.8 1.9 0 1.6-1.5 2.9-3.5 4.4Z" /></>,
  bank: <><path d="M3.5 9.2L12 4.2l8.5 5" /><path d="M5.5 10v7.2M10 10v7.2M14 10v7.2M18.5 10v7.2M3.5 20h17" /></>,
  card: <><rect x="3" y="5.5" width="18" height="13" rx="2.6" /><circle cx="8.6" cy="11" r="2" /><path d="M5.8 15.6c.5-1.3 1.6-2 2.8-2s2.3.7 2.8 2M14 10h4M14 13.5h3" /></>,
  mail: <><rect x="3" y="5" width="18" height="14" rx="2.6" /><path d="M3.6 6.6l8.4 6.4 8.4-6.4" /></>,
  calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 9.8h17M8.2 2.8v4M15.8 2.8v4" /><path d="M9 15l2 2 4-4.2" /></>,
  form: <><rect x="5" y="3.8" width="14" height="17" rx="2.6" /><path d="M9 3.8V3h6v.8M8.6 10h6.8M8.6 13.6h6.8M8.6 17.2h4" /></>,
} as const;
export type GroupIconName = keyof typeof GROUP_ICONS;

export function GroupIcon({ name, size = 18 }: { name: GroupIconName; size?: number }) {
  return (
    <span className="group-ring" aria-hidden="true">
      <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        {GROUP_ICONS[name]}
      </svg>
    </span>
  );
}

/** A form section's heading: a pink icon ring and the title. */
export const GroupHead = forwardRef<HTMLHeadingElement, { icon: GroupIconName; as?: 'h2' | 'h3'; id?: string; children: ReactNode }>(
  function GroupHead({ icon, as: T = 'h2', id, children }, ref) {
    return (
      <div className="group-head">
        <GroupIcon name={icon} />
        <T id={id} ref={ref}>{children}</T>
      </div>
    );
  });

/* ---------------------------------------------------- the celebration */

/** A glossy pink heart with a tick, lemons and blossoms around it; they settle in on arrival. */
export function Celebration({ small }: { small?: boolean }) {
  const id = 'cel' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  return (
    <div className={cx('celebrate', small && 'celebrate--small')} aria-hidden="true">
      <span className="celebrate-halo" />
      <Lemon className="celebrate-lemon" size={84} />
      <LemonSlice className="celebrate-slice" size={56} />
      <Blossom className="celebrate-bloom celebrate-bloom--a" size={26} />
      <Blossom className="celebrate-bloom celebrate-bloom--b" size={20} />
      <Blossom className="celebrate-bloom celebrate-bloom--c" size={16} />
      <Heart className="celebrate-dot celebrate-dot--a" size={14} />
      <Heart className="celebrate-dot celebrate-dot--b" size={11} filled />
      <Heart className="celebrate-dot celebrate-dot--c" size={12} />
      <svg className="celebrate-heart" viewBox="0 0 120 110" width="118" height="108">
        <defs>
          <linearGradient id={`${id}-g`} x1="0.15" y1="0" x2="0.85" y2="1">
            <stop offset="0" stopColor="#ff7ab6" />
            <stop offset="0.55" stopColor="#e8197f" />
            <stop offset="1" stopColor="#c2185b" />
          </linearGradient>
          <radialGradient id={`${id}-s`} cx="0.32" cy="0.26" r="0.5">
            <stop offset="0" stopColor="#fff" stopOpacity="0.75" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
        </defs>
        <path d="M60 104C47 94 8 70 4.6 41.6 2.2 21 15.6 6 33.4 6c11.4 0 20 6.4 26.6 16.2C66.6 12.4 75.2 6 86.6 6c17.8 0 31.2 15 28.8 35.6C112 70 73 94 60 104Z"
          fill={`url(#${id}-g)`} />
        <path d="M60 104C47 94 8 70 4.6 41.6 2.2 21 15.6 6 33.4 6c11.4 0 20 6.4 26.6 16.2C66.6 12.4 75.2 6 86.6 6c17.8 0 31.2 15 28.8 35.6C112 70 73 94 60 104Z"
          fill={`url(#${id}-s)`} />
        <path className="celebrate-tick" d="M38 52.5l14.5 14L83 36.5" fill="none" stroke="#fff" strokeWidth={9} strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

/* --------------------------------------------- loading and problems */

/** While the page loads: a slowly turning lemon slice. */
export function PublicLoading() {
  return (
    <div className="pub-loading" role="status" aria-label="Loading">
      <LemonSlice size={60} className="pub-loading-slice" />
      <span className="pub-loading-dots" aria-hidden="true"><i /><i /><i /></span>
    </div>
  );
}

/** A gentle page for when something can't be shown: lemons in the corners, a script title and the message. */
export function PublicProblem({ title, titleAs = 'h1', children }: { title: string; titleAs?: 'h1' | 'h2'; children: ReactNode }) {
  return (
    <div className="page page-public stack pub-problem">
      <div className="pub-problem-card card">
        <Sprig corner="tl" size={110} className="pub-problem-sprig" />
        <Sprig corner="br" variant="slice" size={110} className="pub-problem-sprig" />
        <ScriptTitle as={titleAs} className="pub-problem-title">{title}</ScriptTitle>
        <div className="stack pub-problem-body">{children}</div>
      </div>
    </div>
  );
}
