// Shared between verify-payment (client-initiated, the instant path for
// card payments) and paystack-webhook (server-initiated, catches bank
// transfers and any case where the browser closed before the client call
// could run). Whichever arrives second for a given reference is a safe
// no-op — see the idempotency check below.
//
// This file's name does not start with an underscore-prefixed folder by
// accident: Supabase Edge Functions treats a `_shared` directory as
// importable code, not a function to deploy — see
// https://supabase.com/docs/guides/functions/import-maps#sharing-code.

// Keep in sync with src/config/pricing.js PRICING.promoPriceKobo / currency
// — a Deno Edge Function can't import from the Vite app, so this is a
// deliberate duplication, not an oversight.
export const EXPECTED_AMOUNT_KOBO = 1440000;
export const EXPECTED_CURRENCY = 'NGN';

// PaystackPayment.jsx mints references as SABI_<business-uuid>_<timestamp>.
const REFERENCE_BUSINESS_ID_RE = /^SABI_([0-9a-fA-F-]{36})_\d+$/;

/**
 * Resolves the business a Paystack transaction belongs to. Tries
 * metadata.custom_fields first (set at checkout in PaystackPayment.jsx),
 * then falls back to parsing it out of the reference itself. Deliberately
 * doesn't depend on metadata alone surviving the round trip — that path
 * had never been exercised end-to-end when the webhook was added.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function extractBusinessId(paystackData: any): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const metaId = paystackData?.metadata?.custom_fields?.find(
    (f: any) => f.variable_name === 'business_id',
  )?.value;
  if (metaId) return metaId;
  const match = REFERENCE_BUSINESS_ID_RE.exec(paystackData?.reference ?? '');
  return match ? match[1] : null;
}

/**
 * Given a Paystack transaction object (from either the verify API's
 * `data` or a charge.success webhook's `data` — both share the same
 * shape), validates it and activates the corresponding business.
 * Self-contained: derives the business id from paystackData itself
 * rather than trusting any caller-supplied value, so both callers are
 * forced through the same trust boundary regardless of how each
 * authenticates its own caller.
 */
export async function activatePaystackTransaction(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DB: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  paystackData: any,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> {
  // Booking payments (DBK_ references / metadata.type 'booking') are handled
  // by _shared/bookingPayment.ts. paystack-webhook routes them away before
  // this function; this is the second line of defence so a booking charge can
  // never extend a subscription, whichever caller got it here.
  if (String(paystackData?.reference ?? '').startsWith('DBK_') || paystackData?.metadata?.type === 'booking') {
    return { status: 422, body: { error: 'Not a subscription payment' } };
  }
  if (paystackData?.status !== 'success') {
    return { status: 422, body: { error: 'Payment was not successful' } };
  }
  if (paystackData?.amount !== EXPECTED_AMOUNT_KOBO || paystackData?.currency !== EXPECTED_CURRENCY) {
    console.error('[paystackActivation] amount/currency mismatch:', paystackData?.amount, paystackData?.currency);
    return { status: 422, body: { error: 'Payment amount does not match the expected plan price' } };
  }

  const businessId = extractBusinessId(paystackData);
  const reference = paystackData?.reference;
  if (!businessId || !reference) {
    console.error('[paystackActivation] could not resolve business id or reference from payload');
    return { status: 422, body: { error: 'Payment payload is missing required fields' } };
  }

  const { data: business, error: bizError } = await DB
    .from('businesses')
    .select('id, plan_expires_at, paystack_reference, first_paid_at')
    .eq('id', businessId)
    .maybeSingle();

  if (bizError || !business) {
    console.error('[paystackActivation] business not found:', businessId);
    return { status: 404, body: { error: 'Business not found' } };
  }

  // Idempotent — whichever of verify-payment / paystack-webhook arrives
  // second for this reference is a no-op, not a duplicate activation.
  if (business.paystack_reference === reference) {
    return { status: 200, body: { success: true, plan_expires_at: business.plan_expires_at, alreadyProcessed: true } };
  }

  // Reject if this reference is already attached to a DIFFERENT business
  // (belt-and-suspenders alongside the DB-level unique constraint).
  const { data: conflictRow } = await DB
    .from('businesses')
    .select('id')
    .eq('paystack_reference', reference)
    .neq('id', businessId)
    .maybeSingle();

  if (conflictRow) {
    return { status: 409, body: { error: 'This payment reference has already been used' } };
  }

  // Extend from whichever is later: now, or the business's current
  // (possibly still-future) expiry — renewing early never costs the
  // owner the remaining days on their current plan.
  const now = new Date();
  const currentExpiry = business.plan_expires_at ? new Date(business.plan_expires_at) : null;
  const anchor = currentExpiry && currentExpiry > now ? currentExpiry : now;
  const newExpiry = new Date(anchor);
  newExpiry.setFullYear(newExpiry.getFullYear() + 1);

  // This write is only permitted because it runs as service_role; see
  // lock_subscription_columns() in supabase/fix_payment_verification.sql
  // and lock_payout_columns() in supabase/add_affiliate_payouts.sql.
  //
  // first_paid_at is stamped only the first time a business ever
  // activates — COALESCE, never overwritten on a renewal — since it's
  // the anchor for the affiliate commission's 7-day payable window
  // (see add_affiliate_payouts.sql section 3 for why this can't be
  // derived from plan_expires_at instead).
  const { error: updateError } = await DB
    .from('businesses')
    .update({
      subscription_status: 'active',
      plan_expires_at: newExpiry.toISOString(),
      paystack_reference: reference,
      first_paid_at: business.first_paid_at ?? now.toISOString(),
    })
    .eq('id', businessId);

  if (updateError) {
    console.error('[paystackActivation] activation write failed:', updateError);
    return { status: 500, body: { error: 'Failed to activate subscription' } };
  }

  return { status: 200, body: { success: true, plan_expires_at: newExpiry.toISOString() } };
}
