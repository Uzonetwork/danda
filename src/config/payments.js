// Booking-payment settings. The Edge Functions keep their OWN copy of these
// values in supabase/functions/_shared/bookingConfig.ts (a Deno function
// can't import from the Vite app) — keep the two in sync. The browser
// copy is for display/validation only; the server never trusts amounts or
// percentages sent from the client.

// Danda's cut of each online booking payment. Passed to Paystack as the
// subaccount's percentage_charge (the share Danda keeps; 0 = professional
// receives everything, less Paystack's fee).
export const DANDA_BOOKING_COMMISSION_PERCENT = 0;

// Who pays Paystack's processing fee. 'subaccount' = the professional.
export const PAYSTACK_FEE_BEARER = 'subaccount';

// How long an unpaid slot stays reserved. Generous because bank transfers
// settle slowly.
export const PAYMENT_HOLD_MINUTES = 30;

export const BOOKING_REFERENCE_PREFIX = 'DBK_';

// Smallest amount (naira) charged online. A sanity floor, not a fee issue.
export const MIN_ONLINE_PAYMENT_NAIRA = 1000;
