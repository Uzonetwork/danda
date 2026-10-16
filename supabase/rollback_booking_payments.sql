-- ROLLBACK for supabase/add_booking_payments.sql. DESTRUCTIVE.
--
-- Drops every object that migration added and restores the previous
-- businesses_public definition and "Public insert bookings" policy.
--
-- DATA LOSS: dropping the columns permanently deletes all booking payment
-- records (amount_paid, paystack_reference, payment_status, ...), every
-- services.payment_mode / deposit setting, and every saved payout account
-- (paystack_subaccount_code, bank name/code, last4, account name,
-- payouts_enabled). Paystack-side subaccounts are NOT deleted. If any real
-- payments have been taken, export bookings first, e.g.
--   select * from bookings where payment_mode <> 'pay_at_venue';
--
-- APPLY ORDER: undeploy the feat/booking-payments frontend and Edge
-- Functions FIRST (they select/insert the dropped columns and will 400),
-- then run this file. Re-running is safe (idempotent).
--
-- Left untouched on purpose: lock_subscription_columns(), lock_payout_columns()
-- and their triggers (not created by the migration).

-- ─── 1. Realtime: remove bookings from the publication ───────────────────
-- (The publication was empty before the migration.)
do $$
begin
  if exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
  ) then
    alter publication supabase_realtime drop table public.bookings;
  end if;
end $$;

-- ─── 2. bookings: policy, trigger, function, indexes, constraints, columns
drop policy if exists "Public insert bookings" on bookings;
create policy "Public insert bookings"
  on bookings for insert
  to anon
  with check (true);

drop trigger if exists bookings_lock_payment_columns on bookings;
drop function if exists lock_booking_payment_columns();

drop index if exists bookings_paid_slot_unique;
drop index if exists bookings_pending_holds_idx;
drop index if exists bookings_pending_phone_idx;

alter table bookings drop constraint if exists bookings_paystack_reference_key;
alter table bookings drop constraint if exists bookings_payment_mode_check;
alter table bookings drop constraint if exists bookings_payment_status_check;

alter table bookings drop column if exists client_email;
alter table bookings drop column if exists payment_mode;
alter table bookings drop column if exists amount_due_now;
alter table bookings drop column if exists amount_paid;
alter table bookings drop column if exists payment_status;
alter table bookings drop column if exists paystack_reference;
alter table bookings drop column if exists hold_expires_at;
alter table bookings drop column if exists needs_attention;
alter table bookings drop column if exists attention_resolved_at;
alter table bookings drop column if exists poll_token_hash;

-- Any rows left in the migration's states have no meaning without the
-- payment columns; return them to a state the old app understands.
update bookings set status = 'cancelled' where status in ('pending_payment', 'expired');

-- ─── 3. services ─────────────────────────────────────────────────────────
alter table services drop constraint if exists services_deposit_check;
alter table services drop constraint if exists services_payment_mode_check;
alter table services drop column if exists payment_mode;
alter table services drop column if exists deposit_type;
alter table services drop column if exists deposit_value;

-- ─── 4. businesses_public back to its previous definition ────────────────
-- Must happen BEFORE dropping businesses.payouts_enabled (the view depends
-- on it). CREATE OR REPLACE cannot remove a column, so drop and recreate,
-- then re-grant (dropping a view drops its grants).
drop view if exists businesses_public;
create view businesses_public
  with (security_invoker = false)
  as
  select
    id,
    name,
    owner_name,
    tagline,
    business_type,
    custom_business_type,
    avatar_url,
    whatsapp,
    city,
    state,
    slug,
    avg_rating,
    rating_count,
    created_at,
    (
      (subscription_status = 'active'::text)
      and (plan_expires_at is not null)
      and (plan_expires_at > now())
    ) as is_active
  from businesses;

grant select on businesses_public to anon, authenticated;

-- ─── 5. businesses ───────────────────────────────────────────────────────
drop trigger if exists businesses_lock_payment_account_columns on businesses;
drop function if exists lock_payment_account_columns();

alter table businesses drop column if exists paystack_subaccount_code;
alter table businesses drop column if exists payout_bank_name;
alter table businesses drop column if exists payout_bank_code;
alter table businesses drop column if exists payout_account_last4;
alter table businesses drop column if exists payout_account_name;
alter table businesses drop column if exists payouts_enabled;

-- ─── VERIFICATION QUERIES (read-only) ────────────────────────────────────
-- Expect zero rows from each:
--   select column_name from information_schema.columns where table_schema='public' and (
--     (table_name='bookings'   and column_name in ('client_email','payment_mode','amount_due_now','amount_paid','payment_status','paystack_reference','hold_expires_at','needs_attention','attention_resolved_at','poll_token_hash'))
--  or (table_name='services'   and column_name in ('payment_mode','deposit_type','deposit_value'))
--  or (table_name='businesses' and column_name in ('paystack_subaccount_code','payout_bank_name','payout_bank_code','payout_account_last4','payout_account_name','payouts_enabled'))
--  or (table_name='businesses_public' and column_name='payouts_enabled'));
--   select * from pg_publication_tables where pubname='supabase_realtime' and tablename='bookings';
--   select tgname from pg_trigger where tgname in ('bookings_lock_payment_columns','businesses_lock_payment_account_columns');
-- Expect: one INSERT policy, roles {anon}, with_check = true:
--   select policyname, roles, with_check from pg_policies where tablename='bookings' and cmd='INSERT';
-- Expect the old triggers still present:
--   select tgname from pg_trigger where tgname in ('businesses_lock_payout_columns','businesses_lock_subscription_columns');
