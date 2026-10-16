-- Rate limit for booking-status's active Paystack verification: at most one
-- transaction/verify call per booking every 10 seconds. booking-status claims
-- the slot atomically with a conditional UPDATE on this column.
-- Written by the service role only. Idempotent.
-- Rollback: alter table bookings drop column if exists last_verify_at;
alter table bookings add column if not exists last_verify_at timestamptz;
