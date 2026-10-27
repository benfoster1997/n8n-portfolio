// The treatment menu, styled like her printed price list: script headings over a
// brush swatch, a dotted leader to a hot-pink price, the length and description
// in muted text beneath. Shared by the booking page and the manage page's change
// flow so both look exactly the same. Styles are in styles/public.css.
import { forwardRef, type ReactNode } from 'react';
import { Badge, BrandIcon, Heart, PolishBottle, ScriptTitle } from '../brand';
import { minutesLabel } from '../../lib/time';
import { money, parseMenu } from '../../lib/text';

/** The card that holds the treatments: a script heading, an optional hint, then the rows. */
export const TreatmentMenu = forwardRef<HTMLHeadingElement, {
  title?: string; hint?: ReactNode; children: ReactNode; focusable?: boolean;
}>(function TreatmentMenu({ title = 'Choose a treatment', hint, children, focusable }, ref) {
  return (
    <section className="card menu-card">
      <ScriptTitle ref={ref} tabIndex={focusable ? -1 : undefined} className="menu-title">{title}</ScriptTitle>
      {hint && <p className="menu-hint">{hint}</p>}
      <ul className="menu-list" role="list">{children}</ul>
    </section>
  );
});

/**
 * One treatment: a `button.service` whose accessible name starts with the treatment's name
 * (or "Your current treatment", on the manage page), then the price, length and description.
 */
export function TreatmentRow({ name, durationMin, pricePence, description, on, current, onClick }: {
  name: string; durationMin: number; pricePence: number; description?: string | null;
  on?: boolean; current?: boolean; onClick: () => void;
}) {
  return (
    <li className="menu-item">
      <button type="button" className={`service menu-row${on ? ' on' : ''}${current ? ' current' : ''}`} onClick={onClick}>
        {current && <span className="chip accent menu-current">Your current treatment</span>}
        <span className="menu-line">
          <span className="menu-name">{name}</span>
          <span className="menu-leader" aria-hidden="true" />
          <span className="menu-price">{money(pricePence)}</span>
          <span className="menu-go" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round"><path d="M9.5 5.5l6.5 6.5-6.5 6.5" /></svg>
          </span>
        </span>
        <span className="menu-meta">
          <span className="menu-time"><BrandIcon name="clock" size={14} strokeWidth={2.1} />{minutesLabel(durationMin)}</span>
          {description && <span className="menu-desc">{description}</span>}
        </span>
      </button>
    </li>
  );
}

/**
 * The add-ons price list (settings.extras_menu): one card per section, the polish bottle on
 * the first. For information only: add-ons are chosen and paid for on the day.
 */
export function AddOnsMenu({ text }: { text: string | null | undefined }) {
  const sections = parseMenu(text).filter((s) => s.items.length || s.notes.length);
  if (!sections.length) return null;
  return (
    <div className="addons">
      <p className="addons-intro">
        <BrandIcon name="sparkle" size={18} className="addons-intro-icon" />
        <span>Add-ons are chosen and paid for on the day.</span>
      </p>
      {sections.map((s, i) => (
        <section key={i} className={`card addon-card${i === 0 ? ' addon-card--bottle' : ''}`}>
          <ScriptTitle className="addon-title">{s.title ?? 'Add-ons'}</ScriptTitle>
          {s.items.length > 0 && (
            <ul className="addon-list" role="list">
              {s.items.map((it, j) => (
                <li key={j} className="menu-line addon-row">
                  <span className="menu-name">{it.name}</span>
                  {it.price && <><span className="menu-leader" aria-hidden="true" /><span className="menu-price">{it.price}</span></>}
                </li>
              ))}
            </ul>
          )}
          {(s.notes.length > 0 || i === 0) && (
            <div className="addon-foot">
              {s.notes.map((n, j) => <p key={j} className="addon-note">{n}</p>)}
              {i === 0 && <PolishBottle className="addon-bottle" size={88} />}
            </div>
          )}
          {i === sections.length - 1 && <Heart className="addon-heart" size={14} />}
        </section>
      ))}
    </div>
  );
}

/** The PPE/safety and location badges from her price list; each only when it has something to say. */
export function InfoBadges({ safety, location }: { safety?: string | null; location?: string | null }) {
  const s = safety?.trim(), l = location?.trim();
  if (!s && !l) return null;
  return (
    <div className="info-badges">
      {s && <Badge icon="shield-heart" title="PPE & safety" titleAs="h2"><p>{s}</p></Badge>}
      {l && <Badge icon="pin" title="Location" titleAs="h2"><p>{l}</p></Badge>}
    </div>
  );
}
