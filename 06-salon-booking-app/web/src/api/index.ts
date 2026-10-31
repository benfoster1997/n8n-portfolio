import type { Api } from './api';
import { demoApi } from './demoApi';
import { supabaseApi } from './supabaseApi';
import { tidySupabaseEnv } from '../lib/env';

const { url, key, reason } = tidySupabaseEnv(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY);
const forceDemo = import.meta.env.VITE_DEMO === '1';
const configured = !forceDemo && !!(url && key);

/**
 * A production build with no Supabase settings is a deployment mistake, not a
 * demo: clients would "book" into their own browser and nobody would know.
 * The demo only runs in development, or when VITE_DEMO=1 is set on purpose.
 */
export const configMissing = import.meta.env.PROD && !forceDemo && !(url && key);

/**
 * Both settings are there but the address still isn't one Supabase can use
 * (it would throw here, before anything is drawn, leaving a blank page).
 */
export const configBadUrl = configured && reason !== null;

/** The tidied settings, for the email script's set-up screen. */
export const supabaseUrl = url;
export const supabaseKey = key;

/** Live when a Supabase project is configured; otherwise the built-in demo. */
export const api: Api = configured && reason === null ? supabaseApi(url, key) : demoApi();

export type { Api } from './api';
