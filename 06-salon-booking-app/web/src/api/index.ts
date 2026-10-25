import type { Api } from './api';
import { demoApi } from './demoApi';
import { supabaseApi } from './supabaseApi';

const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined)?.trim();
const key = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined)?.trim();
const forceDemo = import.meta.env.VITE_DEMO === '1';

/** Live when a Supabase project is configured; otherwise the built-in demo. */
export const api: Api = !forceDemo && url && key ? supabaseApi(url, key) : demoApi();

export type { Api } from './api';
