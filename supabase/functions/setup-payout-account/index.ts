// Owner-only payout setup. Actions (body.action):
//   banks   → Paystack's Nigerian bank list
//   resolve → account name for bank_code + account_number (owner confirms it)
//   save    → re-resolves server-side, then creates (or updates) the
//             business's Paystack subaccount and stores the display details.
//
// The full account number is sent to Paystack and never stored by Danda —
// only the last 4 digits, bank and account name are kept on the business.
// Requires the owner's Supabase JWT (default platform JWT gate is ON for
// this function; it is intentionally absent from supabase/config.toml).

import { CORS, jsonResponse, serviceClient, paystack } from '../_shared/http.ts';
import { DANDA_BOOKING_COMMISSION_PERCENT } from '../_shared/bookingConfig.ts';

const ACCOUNT_RE = /^\d{10}$/;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) return jsonResponse({ error: 'Missing authorization token' }, 401);

  const secret = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
  const DB = serviceClient();
  if (!DB || !secret) return jsonResponse({ error: 'Server misconfigured' }, 500);

  const { data: { user }, error: authError } = await DB.auth.getUser(token);
  if (authError || !user) return jsonResponse({ error: 'Invalid or expired session' }, 401);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid JSON body' }, 400); }
  const action = body?.action;

  async function fetchBanks(): Promise<{ name: string; code: string }[] | null> {
    const r = await paystack(secret, '/bank?country=nigeria&currency=NGN&perPage=200&use_cursor=false');
    if (!r.ok) { console.error('[setup-payout-account] bank list failed:', r.json); return null; }
    const seen = new Set<string>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (r.json.data as any[])
      .filter((b) => b?.name && b?.code && b.active !== false && !seen.has(b.code) && seen.add(b.code))
      .map((b) => ({ name: b.name as string, code: String(b.code) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  if (action === 'banks') {
    const banks = await fetchBanks();
    if (!banks) return jsonResponse({ error: 'Could not load banks. Please try again.' }, 502);
    return jsonResponse({ banks });
  }

  const bankCode = String(body?.bank_code ?? '');
  const accountNumber = String(body?.account_number ?? '');
  if (!/^\d{2,6}$/.test(bankCode) || !ACCOUNT_RE.test(accountNumber)) {
    return jsonResponse({ error: 'Choose a bank and enter a 10-digit account number' }, 400);
  }

  async function resolveName(): Promise<{ name?: string; error?: string }> {
    const r = await paystack(secret, `/bank/resolve?account_number=${accountNumber}&bank_code=${encodeURIComponent(bankCode)}`);
    if (!r.ok || !r.json?.data?.account_name) {
      console.error('[setup-payout-account] resolve failed:', r.json?.message);
      return { error: 'We could not verify that account. Check the bank and account number.' };
    }
    return { name: String(r.json.data.account_name) };
  }

  if (action === 'resolve') {
    const r = await resolveName();
    if (r.error) return jsonResponse({ error: r.error }, 422);
    return jsonResponse({ account_name: r.name });
  }

  if (action === 'save') {
    const businessId = body?.business_id;
    if (!businessId) return jsonResponse({ error: 'business_id is required' }, 400);

    const { data: biz, error: bizError } = await DB
      .from('businesses')
      .select('id, user_id, name, paystack_subaccount_code')
      .eq('id', businessId)
      .maybeSingle();
    if (bizError || !biz) return jsonResponse({ error: 'Business not found' }, 404);
    if (biz.user_id !== user.id) return jsonResponse({ error: 'Forbidden — not your business' }, 403);

    // Never trust a client-supplied account name or bank name: re-resolve
    // and re-read the bank list here.
    const resolved = await resolveName();
    if (resolved.error) return jsonResponse({ error: resolved.error }, 422);
    if (body?.confirm_name && String(body.confirm_name) !== resolved.name) {
      return jsonResponse({ error: 'Account details changed. Please verify again.' }, 409);
    }
    const banks = await fetchBanks();
    const bankName = banks?.find((b) => b.code === bankCode)?.name;
    if (!bankName) return jsonResponse({ error: 'Unknown bank' }, 400);

    const payload = {
      business_name: biz.name,
      settlement_bank: bankCode,
      account_number: accountNumber,
      percentage_charge: DANDA_BOOKING_COMMISSION_PERCENT,
    };
    // Update the existing subaccount rather than creating a second one.
    const r = biz.paystack_subaccount_code
      ? await paystack(secret, `/subaccount/${encodeURIComponent(biz.paystack_subaccount_code)}`, { method: 'PUT', body: JSON.stringify(payload) })
      : await paystack(secret, '/subaccount', { method: 'POST', body: JSON.stringify(payload) });
    if (!r.ok) {
      console.error('[setup-payout-account] subaccount write failed:', r.json);
      return jsonResponse({ error: 'Could not set up your payout account. Please try again.' }, 502);
    }
    const code = biz.paystack_subaccount_code ?? r.json?.data?.subaccount_code;
    if (!code) {
      console.error('[setup-payout-account] no subaccount_code in response:', r.json);
      return jsonResponse({ error: 'Could not set up your payout account. Please try again.' }, 502);
    }

    const stored = {
      paystack_subaccount_code: code,
      payout_bank_name: bankName,
      payout_bank_code: bankCode,
      payout_account_last4: accountNumber.slice(-4),
      payout_account_name: resolved.name,
      payouts_enabled: true,
    };
    // Permitted only because this runs as service_role — see
    // lock_payment_account_columns() in supabase/add_booking_payments.sql.
    const { error: updateError } = await DB.from('businesses').update(stored).eq('id', biz.id);
    if (updateError) {
      console.error('[setup-payout-account] business update failed:', updateError);
      return jsonResponse({ error: 'Saved with Paystack but not on your profile. Please try again.' }, 500);
    }
    return jsonResponse({
      success: true,
      payout: {
        bank_name: bankName, bank_code: bankCode,
        account_last4: stored.payout_account_last4, account_name: resolved.name, enabled: true,
      },
    });
  }

  return jsonResponse({ error: 'Unknown action' }, 400);
});
