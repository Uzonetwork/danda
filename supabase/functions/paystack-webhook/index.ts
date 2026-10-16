import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { activatePaystackTransaction } from '../_shared/paystackActivation.ts';
import { handleBookingCharge, isBookingCharge } from '../_shared/bookingPayment.ts';

// No CORS headers — this endpoint is never called from a browser, only
// server-to-server by Paystack.
//
// DEPLOY NOTE: this function must be deployed with JWT verification
// disabled. Paystack signs its requests with x-paystack-signature, not a
// Supabase JWT, and the platform-level JWT gate runs before this code
// ever executes — see supabase/config.toml (`verify_jwt = false` for
// this function) and the deploy notes in this branch's SQL/README pointer.

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Constant-time comparison — a signature check that short-circuits on the
// first mismatched character leaks timing information an attacker could
// use to guess the correct signature byte-by-byte.
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function isValidPaystackSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-512' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  return timingSafeEqual(toHex(digest), signatureHeader.toLowerCase());
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const secret = Deno.env.get('PAYSTACK_SECRET_KEY') ?? '';
  if (!secret) {
    console.error('[paystack-webhook] missing PAYSTACK_SECRET_KEY');
    return new Response('Server misconfigured', { status: 500 });
  }

  // Signature is computed over the exact raw bytes Paystack sent — read
  // the body as text before any JSON parsing. Re-serializing a parsed
  // object (different whitespace/key order) would break verification.
  const rawBody = await req.text();
  const signature = req.headers.get('x-paystack-signature');

  // This is the entire authorization boundary for this endpoint — it is
  // public and unauthenticated by design (Paystack has no Supabase
  // session to send). Reject anything that doesn't check out; there is
  // nothing else standing between this endpoint and a forged activation.
  if (!(await isValidPaystackSignature(rawBody, signature, secret))) {
    console.error('[paystack-webhook] signature verification failed');
    return new Response('Invalid signature', { status: 400 });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let event: any;
  try { event = JSON.parse(rawBody); } catch {
    console.error('[paystack-webhook] valid signature but unparsable JSON body');
    return new Response('Invalid payload', { status: 400 });
  }

  // Ack anything we don't act on. Paystack retries non-2xx responses,
  // which would just be noise for event types we're not set up to handle.
  if (event?.event !== 'charge.success') {
    return new Response('ok', { status: 200 });
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) {
    console.error('[paystack-webhook] missing service key');
    return new Response('Server misconfigured', { status: 500 });
  }

  const DB = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Route by charge type BEFORE the subscription path. Booking charges
  // (metadata.type === 'booking' or a DBK_ reference) go to their own handler
  // and return from here — they must never reach activatePaystackTransaction,
  // whose SABI_ reference parsing would otherwise be the only thing standing
  // between a booking payment and a subscription activation.
  if (isBookingCharge(event.data)) {
    const outcome = await handleBookingCharge(DB, event.data, secret);
    console.log('[paystack-webhook] booking charge:', outcome.note);
    // Only transient failures (Paystack/DB unreachable) ask Paystack to retry;
    // permanent conditions are logged and acknowledged.
    return outcome.retry ? new Response('retry', { status: 500 }) : new Response('ok', { status: 200 });
  }

  // Same amount/currency check, idempotency, expiry anchoring, and
  // service-role write as verify-payment — see
  // supabase/functions/_shared/paystackActivation.ts. Trusting event.data
  // here (rather than re-calling Paystack's verify API) is intentional:
  // the signature already proves Paystack itself is asserting this data,
  // which is exactly what a second verify call would otherwise establish.
  const result = await activatePaystackTransaction(DB, event.data);

  if (result.status !== 200) {
    // Logged, not surfaced as a retry-triggering response — an unknown
    // business or amount mismatch is a permanent condition that Paystack
    // retrying won't fix, and this is already visible in function logs
    // for follow-up. Signature failure above is the only case that gets
    // a non-200 response from this endpoint.
    console.error('[paystack-webhook] activation did not succeed:', result.status, JSON.stringify(result.body));
  }

  return new Response('ok', { status: 200 });
});
