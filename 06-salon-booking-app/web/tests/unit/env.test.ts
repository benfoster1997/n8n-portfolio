import { describe, expect, it } from 'vitest';
import { tidySupabaseEnv } from '../../src/lib/env';

const ADDR = 'https://abcdefghijklmnop.supabase.co';
const KEY = 'sb_publishable_AbCdEf123_xyz';
const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.abc';
const ok = { url: ADDR, key: KEY, reason: null };

describe('tidySupabaseEnv (the two Supabase values from Netlify)', () => {
  it('leaves correct values alone, with a publishable or a legacy anon key', () => {
    expect(tidySupabaseEnv(ADDR, KEY)).toEqual(ok);
    expect(tidySupabaseEnv(ADDR, JWT)).toEqual({ url: ADDR, key: JWT, reason: null });
    expect(tidySupabaseEnv('http://127.0.0.1:54321', KEY)).toEqual({ url: 'http://127.0.0.1:54321', key: KEY, reason: null });
  });

  it('trims spaces and line breaks around both', () => {
    expect(tidySupabaseEnv(`  ${ADDR}\n`, ` ${KEY} `)).toEqual(ok);
  });

  it('adds https:// to a bare project address', () => {
    expect(tidySupabaseEnv('abcdefghijklmnop.supabase.co', KEY)).toEqual(ok);
    expect(tidySupabaseEnv('http://abcdefghijklmnop.supabase.co', KEY)).toEqual(ok);
  });

  it('drops the NAME= of a whole line pasted from Supabase’s Connect panel', () => {
    expect(tidySupabaseEnv(`NEXT_PUBLIC_SUPABASE_URL=${ADDR}`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}`)).toEqual(ok);
    expect(tidySupabaseEnv(`VITE_SUPABASE_URL = ${ADDR}`, `VITE_SUPABASE_ANON_KEY=${JWT}`)).toEqual({ url: ADDR, key: JWT, reason: null });
    expect(tidySupabaseEnv(`NEXT_PUBLIC_SUPABASE_URL="${ADDR}"`, `"NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}"`)).toEqual(ok);
  });

  it('drops quote marks and backticks, straight or curly', () => {
    expect(tidySupabaseEnv(`"${ADDR}"`, `"${KEY}"`)).toEqual(ok);
    expect(tidySupabaseEnv(`'${ADDR}'`, `\`${KEY}\``)).toEqual(ok);
    expect(tidySupabaseEnv(`“${ADDR}”`, `‘${KEY}’`)).toEqual(ok);
  });

  it('swaps the two when they were pasted the wrong way round', () => {
    expect(tidySupabaseEnv(KEY, ADDR)).toEqual(ok);
    expect(tidySupabaseEnv(JWT, ADDR)).toEqual({ url: ADDR, key: JWT, reason: null });
    expect(tidySupabaseEnv(`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}`, 'abcdefghijklmnop.supabase.co')).toEqual(ok);
    // Only when the key really looks like an address.
    expect(tidySupabaseEnv(KEY, KEY).key).toBe(KEY);
  });

  it('turns a dashboard address into the project address', () => {
    expect(tidySupabaseEnv('https://supabase.com/dashboard/project/abcdefghijklmnop', KEY)).toEqual(ok);
    expect(tidySupabaseEnv('https://supabase.com/dashboard/project/abcdefghijklmnop/settings/api', KEY)).toEqual(ok);
    expect(tidySupabaseEnv('supabase.com/dashboard/project/abcdefghijklmnop', KEY)).toEqual(ok);
  });

  it('keeps only the start of the address, so /rest/v1 or a trailing slash goes', () => {
    expect(tidySupabaseEnv(`${ADDR}/rest/v1`, KEY)).toEqual(ok);
    expect(tidySupabaseEnv(`${ADDR}/rest/v1/`, KEY)).toEqual(ok);
    expect(tidySupabaseEnv(`${ADDR}/`, KEY)).toEqual(ok);
    expect(tidySupabaseEnv('HTTPS://ABCDEFGHIJKLMNOP.SUPABASE.CO/', KEY)).toEqual(ok);
  });

  it('gives a reason when the address still can’t be used', () => {
    for (const bad of [
      'my supabase address',
      'abcdefghijklmnop',
      'ftp://abcdefghijklmnop.supabase.co',
      'https://',
      'https://supabase.com/dashboard/project/_/settings/api',
      'https://supabase.com/dashboard/projects',
      `${ADDR}\nNEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${KEY}`,
      KEY, // the key in both
    ]) {
      expect(tidySupabaseEnv(bad, KEY).reason, bad).toEqual(expect.any(String));
    }
  });

  it('treats missing or empty values as missing, not as a bad address', () => {
    expect(tidySupabaseEnv(undefined, undefined)).toEqual({ url: '', key: '', reason: null });
    expect(tidySupabaseEnv('""', 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=')).toEqual({ url: '', key: '', reason: null });
    expect(tidySupabaseEnv(ADDR, '')).toEqual({ url: ADDR, key: '', reason: null });
  });
});
