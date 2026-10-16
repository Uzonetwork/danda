// PUBLIC (no owner JWT) — see supabase/config.toml. Lets the customer's
// browser poll a booking it just created, without opening SELECT on the
// bookings table (which holds other customers' names and phone numbers).
//
// Authorised by the random poll token create-booking-payment returned: only
// its SHA-256 is stored, and it is compared in constant time. Returns
// nothing but the booking's payment state. Any failure looks identical
// (404) so ids can't be probed.
//
// Active verification: while a booking is still pending_payment this also asks
// Paystack (server-side, secret key) whether the transaction succeeded, at
// most once per VERIFY_MIN_INTERVAL_MS per booking, so the customer gets an
// answer without waiting for the webhook. A success runs the same confirm logic
// as the webhook (_shared/bookingPayment.ts); whichever arrives first wins.
//
// Response `status`: confirmed | pending | not_paid | expired | cancelled.

import { CORS, jsonResponse, serviceClient } from '../_shared/http.ts';
import { verifyAndConfirmBooking } from '../_shared/bookingPayment.ts';
import { UUID_RE, expireStaleHolds, sha256Hex, timingSafeEqual } from '../_shared/bookingUtils.ts';

const VERIFY_MIN_INTERVAL_MS = 10_000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const DB = serviceClient();
  const secret = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
  if (!DB) return jsonResponse({ error: 'Server misconfigured' }, 500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }
  const bookingId = String(body?.booking_id ?? '');
  const token = String(body?.poll_token ?? '');
  if (!UUID_RE.test(bookingId) || token.length < 16 || token.length > 200) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  const { data: b } = await DB.from('bookings')
    .select('id, business_id, status, payment_status, amount_due_now, amount_paid, hold_expires_at, poll_token_hash, paystack_reference')
    .eq('id', bookingId).maybeSingle();
  if (!b || !b.poll_token_hash || !timingSafeEqual(b.poll_token_hash, await sha256Hex(token))) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  let status: string = b.status;
  let paymentStatus = b.payment_status;
  let amountPaid = b.amount_paid;

  if (status === 'pending_payment') {
    // Verify even if the hold has just lapsed: the row stays pending_payment
    // until cleanup, and a last-second payment should still win.
    let outcome: 'confirmed' | 'not_paid' | 'pending' = 'pending';
    if (secret && await claimVerifySlot(DB, b.id)) {
      outcome = await verifyAndConfirmBooking(DB, b, secret);
    }
    if (outcome === 'confirmed') {
      status = 'confirmed';
      paymentStatus = 'paid';
      amountPaid = b.amount_due_now;
    } else if (b.hold_expires_at && new Date(b.hold_expires_at) < new Date()) {
      // Opportunistic cleanup (no cron). The webhook can still confirm an
      // 'expired' booking if the payment lands late.
      await expireStaleHolds(DB, b.business_id);
      status = 'expired';
    } else {
      status = outcome; // 'pending' | 'not_paid'
    }
  }

  return jsonResponse({
    status,
    payment_status: paymentStatus,
    amount_due_now: b.amount_due_now,
    amount_paid: amountPaid,
  });
});

// Atomic per-booking throttle: only the caller whose conditional UPDATE matches
// a row gets to call Paystack. Fails closed (no verify) if the column is missing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function claimVerifySlot(DB: any, bookingId: string): Promise<boolean> {
  const now = new Date();
  const cutoff = new Date(now.getTime() - VERIFY_MIN_INTERVAL_MS).toISOString();
  const { data, error } = await DB.from('bookings')
    .update({ last_verify_at: now.toISOString() })
    .eq('id', bookingId)
    .or(`last_verify_at.is.null,last_verify_at.lt.${cutoff}`)
    .select('id');
  if (error) { console.error('[booking-status] throttle claim failed:', error); return false; }
  return !!data?.length;
}
