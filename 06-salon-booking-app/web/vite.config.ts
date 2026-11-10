import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { tidySupabaseEnv } from './src/lib/env';
import { buildHead, siteAddress, verificationCode, type HeadValues } from './src/lib/head';

type Env = Record<string, string | undefined>;
type LiveDetails = Pick<HeadValues, 'name' | 'tagline' | 'strapline' | 'location'>;

const MARKER = /^([ \t]*)<!-- booking-head -->/m;
const TIMEOUT_MS = 5000;
const isBlank = (v: string | undefined) => !v || !v.trim();
const oneLine = (v: unknown) => String(v).replace(/\s+/g, ' ').trim();

/**
 * The booking page's public business details, read once from the live database as the app is
 * built: the same public_booking_info the page itself loads. Only the name, tagline, strapline and
 * location note are used. Anything wrong (no Supabase details, no answer within 5 seconds, an error
 * or an odd reply) gives one warning and the generic text: it never stops a deploy.
 */
async function liveDetails(env: Env): Promise<LiveDetails> {
  const generic = (why: string): LiveDetails => {
    console.warn(`booking-head: ${why}, so the page head uses the generic title and description.`);
    return {};
  };
  const { url, key, reason } = tidySupabaseEnv(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_ANON_KEY);
  if (!url || !key) return generic('no Supabase address and key to read the business details from');
  if (reason) return generic(`the Supabase address can’t be used (${reason})`);
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${url}/rest/v1/rpc/public_booking_info`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
      signal: stop.signal,
    });
    if (!res.ok) return generic(`Supabase answered ${res.status} when asked for the business details`);
    const info: unknown = await res.json();
    if (!info || typeof info !== 'object' || Array.isArray(info)) return generic('Supabase sent back no business details');
    const text = (k: string) => {
      const v = (info as Record<string, unknown>)[k];
      return typeof v === 'string' ? v : null;
    };
    return { name: text('business_name'), tagline: text('tagline'), strapline: text('strapline'), location: text('location_note') };
  } catch (e) {
    if (stop.signal.aborted) return generic(`Supabase didn’t answer within ${TIMEOUT_MS / 1000} seconds`);
    const err = e as { message?: unknown; cause?: { code?: unknown; message?: unknown } } | null;
    const detail = [err?.message, err?.cause?.code ?? err?.cause?.message].filter(Boolean).map(oneLine).join(', ');
    return generic(`couldn’t read the business details (${detail || 'no reason given'})`);
  } finally {
    clearTimeout(timer);
  }
}

export default defineConfig(async ({ command, mode }) => {
  const env: Env = { ...process.env, ...loadEnv(mode, process.cwd(), 'VITE_') };
  const name = env.VITE_PUBLIC_NAME;
  const description = env.VITE_PUBLIC_DESCRIPTION;

  // The page head: her own words (VITE_PUBLIC_*) first, then what's in Settings (a real build asks
  // the live database), then the generic text. The demo and the dev server never ask the database.
  const ask = command === 'build' && env.VITE_DEMO !== '1' && (isBlank(name) || isBlank(description));
  const live = ask ? await liveDetails(env) : {};
  // The site's address: VITE_SITE_URL, else the one Netlify gives every build (URL).
  const siteUrl = siteAddress(env.VITE_SITE_URL) ?? siteAddress(env.URL);
  if (!isBlank(env.VITE_SITE_URL) && !siteAddress(env.VITE_SITE_URL)) {
    console.warn('booking-head: VITE_SITE_URL isn’t a web address starting https://, so it was left out.');
  }
  if (!isBlank(env.VITE_GOOGLE_SITE_VERIFICATION) && !verificationCode(env.VITE_GOOGLE_SITE_VERIFICATION)) {
    console.warn('booking-head: VITE_GOOGLE_SITE_VERIFICATION should be just the code (letters, digits, - and _), so it was left out.');
  }
  const head = buildHead({
    ...live,
    name: isBlank(name) ? live.name : name,
    description,
    siteUrl,
    verification: env.VITE_GOOGLE_SITE_VERIFICATION,
  });

  // Puts the head where index.html has <!-- booking-head -->, at the marker's indent. 'pre', so it
  // runs before Vite reads the page.
  const bookingHead: Plugin = {
    name: 'booking-head',
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        if (!MARKER.test(html)) {
          console.warn('booking-head: index.html has no <!-- booking-head --> marker, so the page has no title or preview card.');
          return html;
        }
        // A function, so a "$" in her business name is never read as a replacement pattern.
        return html.replace(MARKER, (_marker, indent: string) => indent + head.split('\n').join(`\n${indent}`));
      },
    },
  };

  return {
    plugins: [react(), bookingHead],
    build: { target: 'es2021', sourcemap: false },
    test: { include: ['tests/unit/**/*.test.ts'], environment: 'node' },
  } as never;
});
