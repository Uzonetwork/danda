-- Booking payments (deposit / full prepayment via Paystack subaccounts).
--
-- APPLY ORDER: run this file in the Supabase SQL editor BEFORE deploying any
-- Edge Function or frontend change from feat/booking-payments. It is purely
-- additive and safe to run while the currently-deployed app is live:
--   * every new column is nullable or has a default that reproduces today's
--     behaviour (payment_mode 'pay_at_venue', payment_status 'unpaid', ...);
--   * the existing public booking insert payload still passes the tightened
--     anon policy and triggers unchanged;
--   * businesses_public gains one column appended at the end (CREATE OR
--     REPLACE keeps existing columns, order and grants).
-- Re-running the file is safe (idempotent).
--
-- Written against the LIVE column/policy/trigger/view definitions (not
-- schema.sql). Notable facts relied on:
--   * bookings.status has no CHECK constraint -> 'pending_payment' / 'expired'
--     need no constraint change.
--   * Existing triggers on businesses: lock_subscription_columns() and
--     lock_payout_columns() (first_paid_at / payout_id). They are left
--     untouched; the new bank-details lock is a separately named function.
--   * auth.role() is NULL for the SQL editor / direct DB sessions, so the
--     locks below only block the API roles ('anon', 'authenticated').
--     service_role (Edge Functions) and the SQL editor can write.

-- ─── 1. businesses: payout account columns ───────────────────────────────
alter table businesses add column if not exists paystack_subaccount_code text;
alter table businesses add column if not exists payout_bank_name         text;
-- Paystack bank code (not secret). Needed to pre-select the bank when the
-- owner later updates details, and to PUT the existing subaccount.
alter table businesses add column if not exists payout_bank_code         text;
alter table businesses add column if not exists payout_account_last4     text;
alter table businesses add column if not exists payout_account_name      text;
alter table businesses add column if not exists payouts_enabled          boolean not null default false;

create or replace function lock_payment_account_columns() returns trigger as $$
declare
  changed boolean;
begin
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      changed := new.paystack_subaccount_code is not null
              or new.payout_bank_name         is not null
              or new.payout_bank_code         is not null
              or new.payout_account_last4     is not null
              or new.payout_account_name      is not null
              or new.payouts_enabled;
    else
      changed := new.paystack_subaccount_code is distinct from old.paystack_subaccount_code
              or new.payout_bank_name         is distinct from old.payout_bank_name
              or new.payout_bank_code         is distinct from old.payout_bank_code
              or new.payout_account_last4     is distinct from old.payout_account_last4
              or new.payout_account_name      is distinct from old.payout_account_name
              or new.payouts_enabled          is distinct from old.payouts_enabled;
    end if;
    if changed then
      raise exception 'payout account details can only be set by the payout setup service';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists businesses_lock_payment_account_columns on businesses;
create trigger businesses_lock_payment_account_columns
  before insert or update on businesses
  for each row execute function lock_payment_account_columns();

-- Public read surface: expose only the boolean, never the subaccount code or
-- any bank detail. Definition below is the exact live one plus one appended
-- column. CREATE OR REPLACE (not DROP) keeps grants; re-granted anyway.
create or replace view businesses_public
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
    ) as is_active,
    (payouts_enabled and paystack_subaccount_code is not null) as payouts_enabled
  from businesses;

grant select on businesses_public to anon, authenticated;

-- ─── 2. services: per-service payment settings ───────────────────────────
alter table services add column if not exists payment_mode  text not null default 'pay_at_venue';
alter table services add column if not exists deposit_type  text;
alter table services add column if not exists deposit_value integer;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'services_payment_mode_check') then
    alter table services add constraint services_payment_mode_check
      check (payment_mode in ('pay_at_venue', 'deposit', 'full'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'services_deposit_check') then
    -- Deposit rules only bite when payment_mode = 'deposit'. A fixed deposit
    -- may not exceed the price; a percent must be 1-100. NOTE: because the
    -- fixed rule references price, lowering a service's price below its
    -- fixed deposit is rejected until the deposit is lowered too (the editor
    -- must surface that error).
    alter table services add constraint services_deposit_check
      check (
        payment_mode <> 'deposit'
        or (
          deposit_type in ('fixed', 'percent')
          and deposit_value is not null
          and deposit_value >= 1
          and (
            (deposit_type = 'fixed'   and deposit_value <= price)
            or (deposit_type = 'percent' and deposit_value <= 100)
          )
        )
      );
  end if;
end $$;

-- ─── 3. bookings: payment columns ────────────────────────────────────────
alter table bookings add column if not exists client_email   text;
alter table bookings add column if not exists payment_mode   text    not null default 'pay_at_venue';
alter table bookings add column if not exists amount_due_now integer not null default 0;   -- naira
alter table bookings add column if not exists amount_paid    integer not null default 0;   -- naira
alter table bookings add column if not exists payment_status text    not null default 'unpaid';
alter table bookings add column if not exists paystack_reference text;
alter table bookings add column if not exists hold_expires_at timestamptz;
alter table bookings add column if not exists needs_attention boolean not null default false;
-- Owner-writable: lets the owner dismiss a needs_attention card without
-- flipping needs_attention itself (which would put the row back inside the
-- slot unique index and could collide with whoever took the slot).
alter table bookings add column if not exists attention_resolved_at timestamptz;
-- sha256 hex of the poll token handed to the customer by
-- create-booking-payment; booking-status compares hashes. Never the token.
alter table bookings add column if not exists poll_token_hash text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bookings_paystack_reference_key') then
    alter table bookings add constraint bookings_paystack_reference_key unique (paystack_reference);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_payment_mode_check') then
    alter table bookings add constraint bookings_payment_mode_check
      check (payment_mode in ('pay_at_venue', 'deposit', 'full'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bookings_payment_status_check') then
    alter table bookings add constraint bookings_payment_status_check
      check (payment_status in ('unpaid', 'paid'));
  end if;
end $$;

-- One live paid booking per business per exact start time. Pending holds
-- count (that is what makes the hold a hold); needs_attention rows are
-- excluded so a late payment for an already-taken slot can still be recorded
-- as confirmed instead of being rejected. Pay-at-venue bookings are out of
-- scope, so existing/duplicate rows can never block index creation.
create unique index if not exists bookings_paid_slot_unique
  on bookings (business_id, starts_at)
  where payment_mode in ('deposit', 'full')
    and status in ('confirmed', 'pending_payment')
    and not needs_attention;

-- Lets availability checks and opportunistic hold cleanup find stale holds.
create index if not exists bookings_pending_holds_idx
  on bookings (hold_expires_at)
  where status = 'pending_payment';

-- Per-phone active-hold cap lookups.
create index if not exists bookings_pending_phone_idx
  on bookings (business_id, client_phone)
  where status = 'pending_payment';

-- ─── 4. bookings: write protection (INSERT *and* UPDATE) ─────────────────
-- Only service_role (Edge Functions) / direct DB sessions may set or change
-- the payment columns. Owners keep full ability to change `status`
-- (confirm / cancel / reopen) and reminder_sent_at, as today, with one
-- exception: they cannot move a booking into or out of the system-managed
-- states 'pending_payment' / 'expired'.
create or replace function lock_booking_payment_columns() returns trigger as $$
declare
  bad boolean;
begin
  if auth.role() in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      bad := new.payment_mode      is distinct from 'pay_at_venue'
          or new.payment_status    is distinct from 'unpaid'
          or new.amount_due_now    is distinct from 0
          or new.amount_paid       is distinct from 0
          or new.paystack_reference is not null
          or new.hold_expires_at   is not null
          or new.needs_attention
          or new.poll_token_hash   is not null
          or coalesce(new.status, 'pending') <> 'pending';
    else
      bad := new.payment_mode      is distinct from old.payment_mode
          or new.payment_status    is distinct from old.payment_status
          or new.amount_due_now    is distinct from old.amount_due_now
          or new.amount_paid       is distinct from old.amount_paid
          or new.paystack_reference is distinct from old.paystack_reference
          or new.hold_expires_at   is distinct from old.hold_expires_at
          or new.needs_attention   is distinct from old.needs_attention
          or new.poll_token_hash   is distinct from old.poll_token_hash
          or (new.status is distinct from old.status
              and (new.status in ('pending_payment', 'expired')
                   or old.status in ('pending_payment', 'expired')));
    end if;
    if bad then
      raise exception 'payment fields on a booking can only be set by the payment service';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists bookings_lock_payment_columns on bookings;
create trigger bookings_lock_payment_columns
  before insert or update on bookings
  for each row execute function lock_booking_payment_columns();

-- Public insert (anon + authenticated, so a logged-in owner or customer
-- browsing a booking page isn't blocked): same shape as before, plus status
-- must be 'pending'. The trigger above does the column-level work (a policy
-- can't see defaults uniformly) and applies to both roles. The existing
-- PublicView payload (status:'pending', no payment fields) passes both.
drop policy if exists "Public insert bookings" on bookings;
create policy "Public insert bookings"
  on bookings for insert
  to anon, authenticated
  with check (coalesce(status, 'pending') = 'pending');

-- ─── 5. Realtime ─────────────────────────────────────────────────────────
-- The supabase_realtime publication currently has NO tables, so the owner
-- dashboard's existing postgres_changes subscription has never received an
-- event. Adding bookings fixes that. Realtime delivers a row only if the
-- subscriber's JWT passes that table's SELECT policy, i.e. "Owner select
-- bookings" (auth.uid() = the business's user_id); anon has no SELECT policy
-- on bookings, so no event reaches a visitor.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bookings'
  ) then
    alter publication supabase_realtime add table public.bookings;
  end if;
end $$;

-- ─── VERIFICATION QUERIES (run after applying; read-only) ────────────────
-- 1. New columns exist with expected defaults:
--   select table_name, column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema='public' and (
--     (table_name='bookings'   and column_name in ('client_email','payment_mode','amount_due_now','amount_paid','payment_status','paystack_reference','hold_expires_at','needs_attention','attention_resolved_at','poll_token_hash'))
--  or (table_name='services'   and column_name in ('payment_mode','deposit_type','deposit_value'))
--  or (table_name='businesses' and column_name in ('paystack_subaccount_code','payout_bank_name','payout_bank_code','payout_account_last4','payout_account_name','payouts_enabled')))
--   order by table_name, column_name;
-- 2. Every existing service is pay_at_venue (expect 0 rows):
--   select id from services where payment_mode <> 'pay_at_venue';
-- 3. View still has every old column plus payouts_enabled, and grants held:
--   select column_name from information_schema.columns where table_name='businesses_public' order by ordinal_position;
--   select grantee, privilege_type from information_schema.role_table_grants where table_name='businesses_public' and grantee in ('anon','authenticated');
-- 4. Triggers present (and the two older businesses locks untouched):
--   select tgrelid::regclass, tgname from pg_trigger where not tgisinternal and tgrelid in ('public.bookings'::regclass,'public.businesses'::regclass) order by 1,2;
-- 5. Policy + realtime + index:
--   select policyname, with_check from pg_policies where tablename='bookings' and cmd='INSERT';
--   select * from pg_publication_tables where pubname='supabase_realtime';
--   select indexdef from pg_indexes where indexname in ('bookings_paid_slot_unique','bookings_pending_holds_idx','bookings_pending_phone_idx');
-- 6. Behavioural check as the API roles (SQL editor, one transaction, rolls back):
--   begin;
--   set local role anon;  select set_config('request.jwt.claims','{"role":"anon"}',true);
--   insert into bookings(business_id,client_name,client_phone,service_name,price,status) select id,'t','t','t',0,'pending' from businesses limit 1;  -- expect OK
--   insert into bookings(business_id,client_name,client_phone,service_name,price,status,payment_status) select id,'t','t','t',0,'pending','paid' from businesses limit 1;  -- expect ERROR
--   rollback;
