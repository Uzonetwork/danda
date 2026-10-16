// PUBLIC (no owner JWT) — see [functions.create-booking-payment] in
// supabase/config.toml. Everything that matters is decided here, server-side:
// the amount comes from the services row, the destination from the
// business's subaccount, and nothing monetary is read from the request.
//
// Flow: validate → load service + business (service role) → check business
// is active + payouts enabled → compute amount → expire stale holds →
// per-phone hold cap → insert booking as 'pending_payment' with a hold →
// initialize the Paystack transaction (split to the business's subaccount)
// → return the checkout URL + a poll token for booking-status.
//
// The booking only becomes 'confirmed' in paystack-webhook.

import { CORS, jsonResponse, serviceClient, paystack } from '../_shared/http.ts';
import {
  BOOKING_REFERENCE_PREFIX, EXPECTED_CURRENCY, MIN_ONLINE_PAYMENT_NAIRA,
  PAYMENT_HOLD_MINUTES, PAYSTACK_FEE_BEARER, amountDueNow,
} from '../_shared/bookingConfig.ts';
import {
  EMAIL_RE, UUID_RE, buildStartsAtIso, expireStaleHolds, isBookableSlot,
  nationalDigits, randomToken, sha256Hex,
} from '../_shared/bookingUtils.ts';

const MAX_ACTIVE_HOLDS_PER_PHONE = 2;
const MAX_DAYS_AHEAD = 400;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

  const secret = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
  const DB = serviceClient();
  if (!DB || !secret) return jsonResponse({ error: 'Server misconfigured' }, 500);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let body: any;
  try { body = await req.json(); } catch { return jsonResponse({ error: 'Invalid request' }, 400); }

  // ── 1. Validate input ────────────────────────────────────────────────────
  const businessId = String(body?.business_id ?? '');
  const serviceId = String(body?.service_id ?? '');
  const date = String(body?.date ?? '');
  const time = String(body?.time ?? '').trim();
  const ampm = String(body?.ampm ?? '');
  const clientName = String(body?.client_name ?? '').trim();
  const clientPhone = String(body?.client_phone ?? '').trim();
  const clientEmail = String(body?.client_email ?? '').trim().toLowerCase();
  const notes = String(body?.notes ?? '').trim();

  if (!UUID_RE.test(businessId) || !UUID_RE.test(serviceId)) return jsonResponse({ error: 'Invalid request' }, 400);
  if (!clientName || clientName.length > 100) return jsonResponse({ error: 'Enter your full name' }, 400);
  if (!nationalDigits(clientPhone)) return jsonResponse({ error: 'Enter a valid Nigerian phone number' }, 400);
  if (!EMAIL_RE.test(clientEmail) || clientEmail.length > 254) return jsonResponse({ error: 'Enter a valid email address' }, 400);
  if (notes.length > 1000) return jsonResponse({ error: 'Notes are too long' }, 400);
  if (!isBookableSlot(time, ampm)) return jsonResponse({ error: 'Please pick a valid time' }, 400);
  const startsAt = buildStartsAtIso(date, time, ampm);
  if (!startsAt) return jsonResponse({ error: 'Please pick a valid date' }, 400);
  const startsMs = new Date(startsAt).getTime();
  if (startsMs <= Date.now()) return jsonResponse({ error: 'Please pick a time in the future' }, 400);
  if (startsMs > Date.now() + MAX_DAYS_AHEAD * 86400000) return jsonResponse({ error: 'Please pick a nearer date' }, 400);

  // ── 2. Load service + business; the amount is computed from these ────────
  const [{ data: svc }, { data: biz }] = await Promise.all([
    DB.from('services')
      .select('id, business_id, name, price, active, payment_mode, deposit_type, deposit_value')
      .eq('id', serviceId).maybeSingle(),
    DB.from('businesses')
      .select('id, slug, subscription_status, plan_expires_at, payouts_enabled, paystack_subaccount_code')
      .eq('id', businessId).maybeSingle(),
  ]);
  if (!svc || svc.business_id !== businessId || !svc.active) return jsonResponse({ error: 'That service is not available' }, 404);
  if (!biz) return jsonResponse({ error: 'Business not found' }, 404);

  const isActive = biz.subscription_status === 'active' && !!biz.plan_expires_at && new Date(biz.plan_expires_at) > new Date();
  if (!isActive) return jsonResponse({ error: 'This business is not taking bookings right now' }, 403);
  if (!biz.payouts_enabled || !biz.paystack_subaccount_code) {
    return jsonResponse({ error: 'This business does not take online payments yet' }, 422);
  }
  const dueNow = amountDueNow(svc);
  if (dueNow === null) return jsonResponse({ error: 'This service does not take online payment' }, 422);
  if (dueNow < MIN_ONLINE_PAYMENT_NAIRA) {
    return jsonResponse({ error: `Online payments must be at least ₦${MIN_ONLINE_PAYMENT_NAIRA.toLocaleString()}` }, 422);
  }

  // ── 3. Free lapsed holds, then enforce the per-phone cap ─────────────────
  await expireStaleHolds(DB, businessId);
  const { data: holds } = await DB.from('bookings')
    .select('client_phone')
    .eq('business_id', businessId).eq('status', 'pending_payment')
    .gt('hold_expires_at', new Date().toISOString());
  const myDigits = nationalDigits(clientPhone);
  const mine = (holds ?? []).filter((h: { client_phone: string }) => nationalDigits(h.client_phone) === myDigits).length;
  if (mine >= MAX_ACTIVE_HOLDS_PER_PHONE) {
    return jsonResponse({
      error: 'You already have bookings waiting for payment. Complete them, or try again in a few minutes.',
      code: 'too_many_holds',
    }, 429);
  }

  // ── 4. Insert the held booking (the partial unique index is the race-proof
  //        slot check: a confirmed or live-held paid booking at the same
  //        start time makes this fail with 23505) ───────────────────────────
  const bookingId = crypto.randomUUID();
  const reference = `${BOOKING_REFERENCE_PREFIX}${bookingId}_${Date.now()}`;
  const pollToken = randomToken();
  const holdExpiresAt = new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60000).toISOString();

  const { error: insertError } = await DB.from('bookings').insert({
    id: bookingId,
    business_id: businessId,
    client_name: clientName,
    client_phone: clientPhone,
    client_email: clientEmail,
    service_name: svc.name,
    price: svc.price,
    date,
    time,
    ampm,
    notes,
    starts_at: startsAt,
    status: 'pending_payment',
    payment_mode: svc.payment_mode,
    amount_due_now: dueNow,
    amount_paid: 0,
    payment_status: 'unpaid',
    paystack_reference: reference,
    hold_expires_at: holdExpiresAt,
    poll_token_hash: await sha256Hex(pollToken),
  });
  if (insertError) {
    if (insertError.code === '23505') {
      return jsonResponse({ error: 'That time was just taken, please pick another.', code: 'slot_taken' }, 409);
    }
    console.error('[create-booking-payment] insert failed:', insertError);
    return jsonResponse({ error: 'Could not reserve your slot. Please try again.' }, 500);
  }

  // ── 5. Initialize the Paystack transaction ───────────────────────────────
  const appUrl = (Deno.env.get('PUBLIC_APP_URL') ?? 'https://danda.ng').replace(/\/$/, '');
  const returnBase = biz.slug ? `${appUrl}/${biz.slug}` : `${appUrl}/?business=${biz.id}`;
  const callbackUrl = `${returnBase}${returnBase.includes('?') ? '&' : '?'}booking=${bookingId}`;

  const init = await paystack(secret, '/transaction/initialize', {
    method: 'POST',
    body: JSON.stringify({
      email: clientEmail,
      amount: dueNow * 100, // kobo
      currency: EXPECTED_CURRENCY,
      reference,
      callback_url: callbackUrl,
      subaccount: biz.paystack_subaccount_code,
      bearer: PAYSTACK_FEE_BEARER,
      // Top-level keys only: the subscription path reads
      // metadata.custom_fields, which a booking charge must never carry.
      metadata: { type: 'booking', booking_id: bookingId, business_id: businessId },
    }),
  });

  if (!init.ok || !init.json?.data?.authorization_url) {
    console.error('[create-booking-payment] paystack initialize failed:', init.json);
    // Free the slot immediately rather than leaving a dead hold.
    await DB.from('bookings').update({ status: 'expired', hold_expires_at: null }).eq('id', bookingId);
    return jsonResponse({ error: 'Could not start the payment. Please try again.' }, 502);
  }

  return jsonResponse({
    booking_id: bookingId,
    poll_token: pollToken,
    authorization_url: init.json.data.authorization_url,
    reference,
    amount_due_now: dueNow,
    balance: Math.max(Number(svc.price) - dueNow, 0),
    hold_expires_at: holdExpiresAt,
  });
});
