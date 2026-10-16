// Server-side copy of src/config/payments.js — keep in sync. A Deno Edge
// Function can't import from the Vite app, so this is a deliberate
// duplication. Request bodies never override any of these.
export const DANDA_BOOKING_COMMISSION_PERCENT = 0;
export const PAYSTACK_FEE_BEARER = 'subaccount';
export const PAYMENT_HOLD_MINUTES = 30;
export const BOOKING_REFERENCE_PREFIX = 'DBK_';
export const MIN_ONLINE_PAYMENT_NAIRA = 1000;
export const EXPECTED_CURRENCY = 'NGN';

/**
 * Amount (whole naira) due now for a services row. Mirrors
 * computeAmountDue in src/lib/bookingPayment.js. Returns null for a
 * pay_at_venue service or an invalid deposit configuration.
 */
export function amountDueNow(
  svc: { price: number; payment_mode: string; deposit_type: string | null; deposit_value: number | null },
): number | null {
  const price = Number(svc.price) || 0;
  if (svc.payment_mode === 'full') return price;
  if (svc.payment_mode !== 'deposit') return null;
  const v = Number(svc.deposit_value);
  if (!Number.isInteger(v) || v < 1) return null;
  if (svc.deposit_type === 'fixed') return v <= price ? v : null;
  if (svc.deposit_type === 'percent') return v <= 100 ? Math.round((price * v) / 100) : null;
  return null;
}
