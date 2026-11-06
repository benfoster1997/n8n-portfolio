import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { TaxCard } from '../../src/pages/admin/Money';

// The "Tax to put aside" card (TaxCard) as loading her figures goes, with useLoad stood in
// for (vi.mock runs before the imports): whatever TaxCard does with the load, a failed one
// must never give an estimate from zeros, or turn Edit on (blank boxes saved over her
// figures would wipe them).
vi.mock('../../src/api', () => ({ api: {} }));
const load = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('../../src/components/ui', async (orig) => ({
  ...(await orig<typeof import('../../src/components/ui')>()),
  useLoad: () => ({ setData() {}, reload() {}, ...load.current }),
}));

const render = () => renderToStaticMarkup(createElement(TaxCard, {
  startYear: 2026, rangeLabel: '6 Apr 2026 – 5 Apr 2027', today: '2026-11-05', takingsPence: 1_900_000, hasTakings: true,
}));
const EDIT_OFF = /<button class="btn small od-taxcard-edit" disabled="">/;
const ESTIMATE = 'od-taxcard-value';

describe('the card while her figures load', () => {
  it('a failed load: no estimate, Edit off, and Try again', () => {
    load.current = { data: undefined, error: new Error('Failed to fetch'), loading: false };
    const html = render();
    expect(html).toMatch(EDIT_OFF);
    expect(html).not.toContain(ESTIMATE);
    expect(html).toContain('Try again');
    expect(html).not.toContain('Failed to fetch');
  });

  it('another year’s figures still loaded when this year’s fail: still no estimate and Edit off', () => {
    load.current = {
      data: { year: 2025, row: { start_year: 2025, extra_takings_pence: 1_640_000, expenses_pence: 0, updated_at: '2026-11-01T12:00:00.000Z' } },
      error: new Error('Failed to fetch'), loading: false,
    };
    const html = render();
    expect(html).toMatch(EDIT_OFF);
    expect(html).not.toContain(ESTIMATE);
  });

  it('still loading: a spinner, and Edit off', () => {
    load.current = { data: undefined, error: null, loading: true };
    const html = render();
    expect(html).toMatch(EDIT_OFF);
    expect(html).not.toContain(ESTIMATE);
    expect(html).not.toContain('Try again');
  });

  it('loaded: the estimate, and Edit on', () => {
    load.current = { data: { year: 2026, row: { start_year: 2026, extra_takings_pence: 0, expenses_pence: 0, updated_at: null } }, error: null, loading: false };
    const html = render();
    expect(html).toMatch(/<button class="btn small od-taxcard-edit">/);
    expect(html).toContain(ESTIMATE);
    expect(html).toContain('£1,412');
  });
});
