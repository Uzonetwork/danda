import { supabase } from './supabase';

/**
 * Invokes an Edge Function and returns { data, error } where error is a
 * human-readable string. supabase.functions.invoke hides the JSON body of a
 * non-2xx response inside error.context; the functions here put their
 * user-facing message in { error } so surface that when present.
 */
export async function callFunction(name, body) {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error && !data?.error) return { data, error: null };
  let message = data?.error || null;
  if (!message && error?.context && typeof error.context.json === 'function') {
    try { message = (await error.context.json())?.error ?? null; } catch { /* not JSON */ }
  }
  return { data: null, error: message || 'Something went wrong. Please try again.' };
}
