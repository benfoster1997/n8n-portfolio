import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseApi } from '../../src/api/supabaseApi';
import { friendlyError } from '../../src/lib/text';

// The live API (supabaseApi) against stand-in answers from Supabase, including a
// project that hasn't run supabase/updates/2026-11-tax-estimate.sql yet.
type Answer = { status: number; body: unknown };
const MISSING_NOW: Answer = {
  status: 404,
  body: { code: 'PGRST205', details: null, hint: "Perhaps you meant the table 'public.payments'",
    message: "Could not find the table 'public.tax_years' in the schema cache" },
};
const MISSING_OLD: Answer = { status: 404, body: { code: '42P01', details: null, hint: null, message: 'relation "public.tax_years" does not exist' } };

/** Answer requests for the tax_years table with `tax`, and every other table with no rows. */
function serve(tax: { get?: Answer; post?: Answer }) {
  const calls: { url: URL; method: string; headers: Headers; body: unknown }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? 'GET';
    calls.push({ url, method, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
    const answer = url.pathname === '/rest/v1/tax_years' ? (method === 'GET' ? tax.get : tax.post) : { status: 200, body: [] };
    if (!answer) throw new Error(`unexpected ${method} ${url}`);
    return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json' } });
  }));
  return calls;
}
afterEach(() => { vi.unstubAllGlobals(); });

const live = supabaseApi('https://example.supabase.co', 'sb_publishable_test');

describe('the tax estimate’s figures in the live app', () => {
  it('reads a saved tax year', async () => {
    serve({ get: { status: 200, body: [{ start_year: 2026, extra_takings_pence: 123_400, expenses_pence: 56_700, updated_at: '2026-11-04T10:00:00+00:00' }] } });
    expect(await live.getTaxYear(2026)).toEqual({ start_year: 2026, extra_takings_pence: 123_400, expenses_pence: 56_700, updated_at: '2026-11-04T10:00:00.000Z' });
  });

  it('gives zeros for a tax year with nothing saved', async () => {
    serve({ get: { status: 200, body: [] } });
    expect(await live.getTaxYear(2025)).toEqual({ start_year: 2025, extra_takings_pence: 0, expenses_pence: 0, updated_at: null });
  });

  it('saves with an upsert on the tax year', async () => {
    const calls = serve({ post: { status: 201, body: { start_year: 2026, extra_takings_pence: 500, expenses_pence: 0, updated_at: '2026-11-04T10:00:00+00:00' } } });
    const saved = await live.saveTaxYear({ start_year: 2026, extra_takings_pence: 500, expenses_pence: 0 });
    expect(saved.extra_takings_pence).toBe(500);
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url.searchParams.get('on_conflict')).toBe('start_year');
    expect(post.headers.get('prefer')).toMatch(/resolution=merge-duplicates/);
    expect(post.body).toEqual({ start_year: 2026, extra_takings_pence: 500, expenses_pence: 0 });
  });

  for (const [when, missing] of [['now (PGRST205)', MISSING_NOW], ['on older versions (42P01)', MISSING_OLD]] as const) {
    describe(`before the database update has been run, as Supabase says it ${when}`, () => {
      it('reading gives zeros, so the estimate still shows from the takings', async () => {
        serve({ get: missing });
        expect(await live.getTaxYear(2026)).toEqual({ start_year: 2026, extra_takings_pence: 0, expenses_pence: 0, updated_at: null });
      });

      it('saving explains that the update hasn’t been run', async () => {
        serve({ post: missing });
        const e = await live.saveTaxYear({ start_year: 2026, extra_takings_pence: 100, expenses_pence: 0 }).catch((x: unknown) => x);
        expect(e).toBeInstanceOf(Error);
        expect(friendlyError(e)).toMatch(/database update for the tax estimate hasn’t been run/);
      });

      it('a backup still works, with no tax figures in it', async () => {
        serve({ get: missing });
        const all = await live.exportAll();
        expect(all.tax_years).toEqual([]);
        expect(all.payments).toEqual([]);
      });
    });
  }

  describe('other errors aren’t hidden', () => {
    it('reading', async () => {
      serve({ get: { status: 500, body: { code: 'XX000', details: null, hint: null, message: 'something broke' } } });
      await expect(live.getTaxYear(2026)).rejects.toThrow('something broke');
    });

    it('a signed-in session that has run out isn’t taken for the missing table', async () => {
      serve({ get: { status: 401, body: { code: 'PGRST301', details: null, hint: null, message: 'JWT expired' } } });
      await expect(live.getTaxYear(2026)).rejects.toThrow('JWT expired');
    });

    it('saving a value the table refuses says so, not that the update is needed', async () => {
      serve({ post: { status: 400, body: { code: '23514', details: null, hint: null,
        message: 'new row for relation "tax_years" violates check constraint "tax_years_expenses_pence_check"' } } });
      const e = await live.saveTaxYear({ start_year: 2026, extra_takings_pence: 100, expenses_pence: 0 }).catch((x: unknown) => x);
      expect(friendlyError(e)).toBe('That value is out of range — please check it.');
    });

    it('a backup fails rather than quietly leaving her tax figures out', async () => {
      serve({ get: { status: 500, body: { code: 'XX000', details: null, hint: null, message: 'something broke' } } });
      await expect(live.exportAll()).rejects.toThrow('something broke');
    });
  });

  it('a backup includes the saved tax figures', async () => {
    serve({ get: { status: 200, body: [{ start_year: 2026, extra_takings_pence: 1, expenses_pence: 2, updated_at: '2026-11-04T10:00:00+00:00' }] } });
    const all = await live.exportAll();
    expect(all.tax_years).toHaveLength(1);
  });
});
