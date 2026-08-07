-- T6/BALANCE-001 (BILL-001 confirmed): kadi_v1_get_wallet_balance previously
-- returned only the raw kadi_wallets.balance, ignoring live credit holds in
-- kadi_v1_wallet_reservations. kadi_v1_reserve_generation_credits already
-- computes spendability as balance minus the sum of amounts where
-- kadi_v1_wallet_reservations.status = 'RESERVED' — the exact same live
-- semantics are reused here, in the same single database call, so the
-- balance/reservation snapshot cannot be read as two separate,
-- race-prone application-side queries. Forward-only: this replaces the
-- function body of the existing kadi_v1_get_wallet_balance(text) in place
-- (same name, same signature, same security/grants), never touching the
-- original migration file. `balance` is preserved unchanged for the one
-- existing caller that still reads it as a raw number
-- (kadiV1RechargeService.js's resumePendingGeneration, via
-- kadiV1RechargeRepository.js's getBalance — deliberately not touched by
-- this mission); `total_credits`, `reserved_credits` and
-- `available_credits` are additive fields for the new
-- getAvailableBalance() repository method.
create or replace function public.kadi_v1_get_wallet_balance(p_owner_wa_id text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_profile jsonb;
  v_profile_id text;
  v_balance integer;
  v_held integer;
begin
  select public.kadi_resolve_profile_v2(p_owner_wa_id, null, null, null, null) into v_profile;
  v_profile_id := v_profile->>'profile_id';
  -- `for share`: read-only, but locks the wallet row against a concurrent
  -- writer (kadi_v1_reserve_generation_credits takes `for update` on the
  -- same row; kadi_consume_credits_v2, called from
  -- kadi_v1_capture_generation_reservation, updates the same row as part
  -- of the same transaction that also flips the reservation to CAPTURED)
  -- so the balance and the RESERVED sum read below are never observed as
  -- torn relative to a reservation that is concurrently being created or
  -- captured.
  select balance into v_balance from public.kadi_wallets
    where profile_id::text = v_profile_id for share;
  v_balance := coalesce(v_balance, 0);
  select coalesce(sum(amount), 0) into v_held from public.kadi_v1_wallet_reservations
    where owner_wa_id = p_owner_wa_id and status = 'RESERVED';
  return jsonb_build_object(
    'balance', v_balance,
    'total_credits', v_balance,
    'reserved_credits', v_held,
    'available_credits', v_balance - v_held
  );
end $$;

-- KADI_V1_SERVICE_ROLE_ONLY_BEGIN
revoke all on function public.kadi_v1_get_wallet_balance(text) from public;
revoke all on function public.kadi_v1_get_wallet_balance(text) from anon;
revoke all on function public.kadi_v1_get_wallet_balance(text) from authenticated;
grant execute on function public.kadi_v1_get_wallet_balance(text) to service_role;
-- KADI_V1_SERVICE_ROLE_ONLY_END
