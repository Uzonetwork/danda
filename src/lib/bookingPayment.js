import { MIN_ONLINE_PAYMENT_NAIRA } from '../config/payments.js';

// Mirrors amountDueNow() in supabase/functions/_shared/bookingConfig.ts.
// Display/validation only — create-booking-payment recomputes the amount
// from the services row and ignores anything the browser sends.

export const PAYMENT_MODES = ['pay_at_venue', 'deposit', 'full'];

/**
 * { dueNow, balance } in whole naira for a service-shaped object
 * ({ price, payment_mode, deposit_type, deposit_value }), or null when the
 * service is pay_at_venue / its deposit settings are invalid.
 */
export function computeAmountDue(svc) {
  const price = Number(svc?.price) || 0;
  const mode = svc?.payment_mode ?? 'pay_at_venue';
  let dueNow = null;
  if (mode === 'full') {
    dueNow = price;
  } else if (mode === 'deposit') {
    const v = Number(svc?.deposit_value);
    if (!Number.isInteger(v) || v < 1) return null;
    if (svc?.deposit_type === 'fixed' && v <= price) dueNow = v;
    else if (svc?.deposit_type === 'percent' && v <= 100) dueNow = Math.round((price * v) / 100);
  }
  if (dueNow === null) return null;
  return { dueNow, balance: Math.max(price - dueNow, 0) };
}

/** Error message for a payment configuration, or null if it is valid. */
export function validatePaymentSettings(settings, price) {
  const mode = settings?.payment_mode ?? 'pay_at_venue';
  if (mode === 'pay_at_venue') return null;
  const due = computeAmountDue({ ...settings, price });
  if (mode === 'deposit') {
    const v = Number(settings?.deposit_value);
    if (settings?.deposit_type !== 'fixed' && settings?.deposit_type !== 'percent') return 'Choose a fixed or percent deposit';
    if (!Number.isInteger(v) || v < 1) return 'Enter a deposit amount';
    if (settings.deposit_type === 'percent' && v > 100) return 'A percent deposit must be between 1 and 100';
    if (settings.deposit_type === 'fixed' && v > price) return 'The deposit cannot be more than the price';
  }
  if (!due || due.dueNow < MIN_ONLINE_PAYMENT_NAIRA) {
    return `The amount paid online must be at least ₦${MIN_ONLINE_PAYMENT_NAIRA.toLocaleString()}`;
  }
  return null;
}

/** Short label for the services table. */
export function describePayment(svc) {
  const mode = svc?.payment_mode ?? 'pay_at_venue';
  if (mode === 'full') return 'Pay in full';
  if (mode === 'deposit') {
    const due = computeAmountDue(svc);
    return due ? `Deposit ₦${due.dueNow.toLocaleString()}` : 'Deposit';
  }
  return 'Pay at venue';
}
