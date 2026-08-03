-- P2A: harden remaining legacy functions.

alter function public.kadi_apply_voucher(text, text)
  set search_path = public, pg_temp;
alter function public.kadi_decrement_credit(text)
  set search_path = public, pg_temp;
alter function public.kadi_next_doc_number(text, text)
  set search_path = public, pg_temp;
alter function public.kadi_stats(integer, integer)
  set search_path = public, pg_temp;
alter function public.kadi_stats_snapshot()
  set search_path = public, pg_temp;
alter function public.kadi_top_clients(integer, integer)
  set search_path = public, pg_temp;
alter function public.kadi_touch_user(text, text)
  set search_path = public, pg_temp;
alter function public.kadi_wallet_touch()
  set search_path = public, pg_temp;
alter function public.prevent_update_certified_invoice()
  set search_path = public, pg_temp;
alter function public.prevent_delete_certified_invoice()
  set search_path = public, pg_temp;
alter function public.set_updated_at()
  set search_path = public, pg_temp;
alter function public.update_timestamp()
  set search_path = public, pg_temp;

revoke all on function public.kadi_apply_voucher(text, text)
  from public, anon, authenticated;
revoke all on function public.kadi_decrement_credit(text)
  from public, anon, authenticated;
revoke all on function public.kadi_next_doc_number(text, text)
  from public, anon, authenticated;
revoke all on function public.kadi_stats(integer, integer)
  from public, anon, authenticated;
revoke all on function public.kadi_stats_snapshot()
  from public, anon, authenticated;
revoke all on function public.kadi_top_clients(integer, integer)
  from public, anon, authenticated;
revoke all on function public.kadi_touch_user(text, text)
  from public, anon, authenticated;
revoke all on function public.kadi_wallet_touch()
  from public, anon, authenticated;
revoke all on function public.prevent_update_certified_invoice()
  from public, anon, authenticated;
revoke all on function public.prevent_delete_certified_invoice()
  from public, anon, authenticated;
revoke all on function public.set_updated_at()
  from public, anon, authenticated;
revoke all on function public.update_timestamp()
  from public, anon, authenticated;

grant execute on function public.kadi_apply_voucher(text, text)
  to service_role;
grant execute on function public.kadi_decrement_credit(text)
  to service_role;
grant execute on function public.kadi_next_doc_number(text, text)
  to service_role;
grant execute on function public.kadi_stats(integer, integer)
  to service_role;
grant execute on function public.kadi_stats_snapshot()
  to service_role;
grant execute on function public.kadi_top_clients(integer, integer)
  to service_role;
grant execute on function public.kadi_touch_user(text, text)
  to service_role;
grant execute on function public.kadi_wallet_touch()
  to service_role;
grant execute on function public.prevent_update_certified_invoice()
  to service_role;
grant execute on function public.prevent_delete_certified_invoice()
  to service_role;
grant execute on function public.set_updated_at()
  to service_role;
grant execute on function public.update_timestamp()
  to service_role;
