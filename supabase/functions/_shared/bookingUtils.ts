// Small helpers shared by the public booking-payment functions. Several of
// these deliberately duplicate browser code (a Deno function can't import
// from the Vite app): normalizeNationalDigits ↔ src/lib/phone.js,
// buildStartsAtIso ↔ buildStartsAtIso in src/views/PublicView.jsx,
// BOOKABLE_SLOTS ↔ TIME_SLOTS in the same file.

/** 10-digit Nigerian national number from any common input shape, or null. */
export function nationalDigits(raw: unknown): string | null {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('234')) return digits.slice(3);
  if (digits.length === 11 && digits.startsWith('0')) return digits.slice(1);
  if (digits.length === 10) return digits;
  return null;
}

// The only start times the public booking form offers.
const BOOKABLE_SLOTS = new Set([
  '8:00 AM', '9:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '1:00 PM',
  '2:00 PM', '3:00 PM', '4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM',
]);

export function isBookableSlot(time: string, ampm: string): boolean {
  return BOOKABLE_SLOTS.has(`${time} ${ampm}`);
}

/** Africa/Lagos is a fixed UTC+1 (no DST), so the offset can be hard-coded. */
export function buildStartsAtIso(dateStr: string, timeStr: string, ampm: string): string | null {
  const [hStr, mStr] = timeStr.split(':');
  let hour = parseInt(hStr, 10);
  const minute = parseInt(mStr, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || Number.isNaN(hour) || Number.isNaN(minute)) return null;
  if (ampm === 'PM' && hour !== 12) hour += 12;
  if (ampm === 'AM' && hour === 12) hour = 0;
  const iso = `${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+01:00`;
  return Number.isNaN(new Date(iso).getTime()) ? null : iso;
}

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Marks this business's lapsed holds 'expired' (opportunistic cleanup —
 * there is no cron). Safe to call from any request; the slot unique index
 * only frees up once the row leaves 'pending_payment'.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function expireStaleHolds(DB: any, businessId?: string) {
  let q = DB.from('bookings')
    .update({ status: 'expired', hold_expires_at: null })
    .eq('status', 'pending_payment')
    .lt('hold_expires_at', new Date().toISOString());
  if (businessId) q = q.eq('business_id', businessId);
  const { error } = await q;
  if (error) console.error('[bookingUtils] expireStaleHolds failed:', error);
}
