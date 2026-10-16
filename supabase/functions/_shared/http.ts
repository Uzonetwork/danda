import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

/** Service-role client, or null if the function is misconfigured. */
export function serviceClient() {
  const url = Deno.env.get('SUPABASE_URL') ?? '';
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export const PAYSTACK_API = 'https://api.paystack.co';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function paystack(secret: string, path: string, init: RequestInit = {}): Promise<{ ok: boolean; json: any }> {
  const res = await fetch(`${PAYSTACK_API}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON error body */ }
  return { ok: res.ok && !!json?.status, json };
}
