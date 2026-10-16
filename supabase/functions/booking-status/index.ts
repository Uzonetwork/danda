// PUBLIC (no owner JWT) — see supabase/config.toml. Lets the customer's
// browser poll a booking it just created, without opening SELECT on the
// bookings table (which holds other customers' names and phone numbers).
//
// Authorised by the random poll token create-booking-payment returned: only
// its SHA-256 is stored, and it is compared in constant time. Returns
// nothing but the booking's payment state. Any failure looks identical
// (404) so ids can't be probed.

import { CORS, jsonResponse, serviceClient } from '../_shared/http.ts';
import { UUID_RE, expireStaleHolds, sha256Hex, timingSafeEqual } from '../_shared/bookingUtils.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const DB = serviceClient();
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
    .select('id, business_id, status, payment_status, amount_due_now, amount_paid, hold_expires_at, poll_token_hash')
    .eq('id', bookingId).maybeSingle();
  if (!b || !b.poll_token_hash || !timingSafeEqual(b.poll_token_hash, await sha256Hex(token))) {
    return jsonResponse({ error: 'Not found' }, 404);
  }

  let status = b.status;
  if (status === 'pending_payment' && b.hold_expires_at && new Date(b.hold_expires_at) < new Date()) {
    // Opportunistic cleanup (no cron). The webhook can still confirm an
    // 'expired' booking if the payment lands late.
    await expireStaleHolds(DB, b.business_id);
    status = 'expired';
  }

  return jsonResponse({
    status,
    payment_status: b.payment_status,
    amount_due_now: b.amount_due_now,
    amount_paid: b.amount_paid,
  });
});
