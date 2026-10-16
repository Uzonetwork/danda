// Booking-payment side of paystack-webhook. Paystack sends EVERY charge for
// the account to the one webhook URL, so paystack-webhook routes here by
// metadata.type / reference prefix before the subscription path ever sees
// the event. A DBK_ charge must never reach activatePaystackTransaction.
//
// The webhook is the source of truth for "this booking is paid": the browser
// return/poll is only a convenience. Idempotent on the booking's
// paystack_reference — a repeated webhook is a no-op.

import { paystack } from './http.ts';
import { BOOKING_REFERENCE_PREFIX, EXPECTED_CURRENCY } from './bookingConfig.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function isBookingCharge(data: any): boolean {
  return data?.metadata?.type === 'booking' || String(data?.reference ?? '').startsWith(BOOKING_REFERENCE_PREFIX);
}

export interface BookingChargeResult {
  /** true = transient failure; the webhook should answer non-2xx so Paystack retries. */
  retry: boolean;
  note: string;
}

export async function handleBookingCharge(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  DB: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  data: any,
  secret: string,
): Promise<BookingChargeResult> {
  const reference = String(data?.reference ?? '');
  if (!reference.startsWith(BOOKING_REFERENCE_PREFIX)) {
    console.error('[bookingPayment] booking charge with a non-booking reference:', reference);
    return { retry: false, note: 'bad reference' };
  }

  const { data: booking, error: lookupError } = await DB
    .from('bookings')
    .select('id, business_id, client_name, client_phone, service_name, date, status, payment_status, amount_due_now')
    .eq('paystack_reference', reference)
    .maybeSingle();
  if (lookupError) {
    console.error('[bookingPayment] booking lookup failed:', lookupError);
    return { retry: true, note: 'lookup failed' };
  }
  if (!booking) {
    console.error('[bookingPayment] no booking for reference:', reference);
    return { retry: false, note: 'unknown reference' };
  }
  if (booking.payment_status === 'paid') return { retry: false, note: 'already processed' };

  // Never trust the webhook body for money decisions — re-verify with Paystack.
  const verified = await paystack(secret, `/transaction/verify/${encodeURIComponent(reference)}`);
  if (!verified.ok) {
    console.error('[bookingPayment] verify call failed:', verified.json);
    return { retry: true, note: 'verify failed' };
  }
  const tx = verified.json.data;

  const { data: biz, error: bizError } = await DB
    .from('businesses')
    .select('id, paystack_subaccount_code')
    .eq('id', booking.business_id)
    .maybeSingle();
  if (bizError) return { retry: true, note: 'business lookup failed' };

  const expectedKobo = Number(booking.amount_due_now) * 100;
  const problems: string[] = [];
  if (tx?.status !== 'success') problems.push(`status=${tx?.status}`);
  if (tx?.currency !== EXPECTED_CURRENCY) problems.push(`currency=${tx?.currency}`);
  if (tx?.amount !== expectedKobo) problems.push(`amount=${tx?.amount} expected=${expectedKobo}`);
  if (!biz?.paystack_subaccount_code || tx?.subaccount?.subaccount_code !== biz.paystack_subaccount_code) {
    problems.push('subaccount mismatch');
  }
  if (tx?.metadata?.booking_id !== booking.id) problems.push('booking_id mismatch');
  if (problems.length > 0) {
    // Permanent condition — retrying won't fix it. Left unconfirmed on purpose.
    console.error('[bookingPayment] verification mismatch for', reference, problems.join('; '));
    return { retry: false, note: 'verification mismatch' };
  }

  const paid = {
    payment_status: 'paid',
    amount_paid: booking.amount_due_now,
    status: 'confirmed',
    hold_expires_at: null,
  };
  // The `payment_status = 'unpaid'` guard makes this the single atomic
  // idempotency point: of two concurrent deliveries only one updates a row.
  let result = await DB.from('bookings').update(paid).eq('id', booking.id).eq('payment_status', 'unpaid').select('id');

  if (result.error?.code === '23505') {
    // Paid after the hold lapsed AND the slot has since been taken. The money
    // has already reached the professional, so record it as confirmed but
    // flagged — the slot unique index excludes needs_attention rows — and the
    // dashboard surfaces it so the owner can sort it out with the customer.
    console.error('[bookingPayment] slot clash for paid booking', booking.id);
    result = await DB.from('bookings').update({ ...paid, needs_attention: true }).eq('id', booking.id).eq('payment_status', 'unpaid').select('id');
  }
  if (result.error) {
    console.error('[bookingPayment] confirm update failed:', result.error);
    return { retry: true, note: 'update failed' };
  }
  if (!result.data?.length) return { retry: false, note: 'already processed' };

  await upsertClient(DB, booking);
  return { retry: false, note: 'confirmed' };
}

// Mirrors the client upsert OwnerDashboard.setBookingStatus does when an
// owner confirms by hand, so webhook-confirmed bookings appear in Clients too.
// Best-effort: a failure here must not undo or retry a recorded payment.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function upsertClient(DB: any, booking: any) {
  try {
    const { data: existing } = await DB.from('clients')
      .select('id, visit_count')
      .eq('business_id', booking.business_id).eq('name', booking.client_name).eq('phone', booking.client_phone)
      .maybeSingle();
    if (existing) {
      await DB.from('clients').update({
        visit_count: (existing.visit_count || 1) + 1,
        last_service: booking.service_name,
        last_visit: booking.date,
      }).eq('id', existing.id);
    } else {
      const initials = String(booking.client_name ?? '').trim().split(/\s+/).slice(0, 2)
        .map((w: string) => w[0]?.toUpperCase() ?? '').join('');
      await DB.from('clients').insert({
        business_id: booking.business_id, name: booking.client_name, phone: booking.client_phone,
        initials, visit_count: 1, last_service: booking.service_name, last_visit: booking.date,
      });
    }
  } catch (err) {
    console.error('[bookingPayment] client upsert failed:', err);
  }
}
