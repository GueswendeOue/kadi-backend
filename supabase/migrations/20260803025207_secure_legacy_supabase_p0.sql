-- P0 Supabase hardening for the active legacy Kadi runtime.

alter function public.kadi_add_credits(text, integer, text)
  set search_path = public, pg_temp;
alter function public.kadi_consume_credits(text, integer, text)
  set search_path = public, pg_temp;
alter function public.kadi_get_stats(integer, integer)
  set search_path = public, pg_temp;
alter function public.kadi_next_counter(text)
  set search_path = public, pg_temp;
alter function public.kadi_redeem_code(text, text)
  set search_path = public, pg_temp;

revoke all on function public.kadi_add_credits(text, integer, text)
  from public, anon, authenticated;
revoke all on function public.kadi_consume_credits(text, integer, text)
  from public, anon, authenticated;
revoke all on function public.kadi_get_stats(integer, integer)
  from public, anon, authenticated;
revoke all on function public.kadi_next_counter(text)
  from public, anon, authenticated;
revoke all on function public.kadi_redeem_code(text, text)
  from public, anon, authenticated;

grant execute on function public.kadi_add_credits(text, integer, text)
  to service_role;
grant execute on function public.kadi_consume_credits(text, integer, text)
  to service_role;
grant execute on function public.kadi_get_stats(integer, integer)
  to service_role;
grant execute on function public.kadi_next_counter(text)
  to service_role;
grant execute on function public.kadi_redeem_code(text, text)
  to service_role;

alter table public.kadi_beta_credit_cleanup_targets enable row level security;
alter table public.kadi_certified_invoices enable row level security;
alter table public.kadi_certified_invoice_items enable row level security;
alter table public.kadi_certified_invoice_events enable row level security;
alter table public.kadi_certified_invoice_versions enable row level security;
alter table public.kadi_certified_invoice_sequences enable row level security;
alter table public.kadi_conversion_events enable row level security;
alter table public.kadi_reengagement_log enable row level security;
alter table public.kadi_scheduler_guard enable row level security;

revoke all on table public.kadi_beta_credit_cleanup_targets
  from public, anon, authenticated;
revoke all on table public.kadi_certified_invoices
  from public, anon, authenticated;
revoke all on table public.kadi_certified_invoice_items
  from public, anon, authenticated;
revoke all on table public.kadi_certified_invoice_events
  from public, anon, authenticated;
revoke all on table public.kadi_certified_invoice_versions
  from public, anon, authenticated;
revoke all on table public.kadi_certified_invoice_sequences
  from public, anon, authenticated;
revoke all on table public.kadi_conversion_events
  from public, anon, authenticated;
revoke all on table public.kadi_reengagement_log
  from public, anon, authenticated;
revoke all on table public.kadi_scheduler_guard
  from public, anon, authenticated;

grant all on table public.kadi_beta_credit_cleanup_targets to service_role;
grant all on table public.kadi_certified_invoices to service_role;
grant all on table public.kadi_certified_invoice_items to service_role;
grant all on table public.kadi_certified_invoice_events to service_role;
grant all on table public.kadi_certified_invoice_versions to service_role;
grant all on table public.kadi_certified_invoice_sequences to service_role;
grant all on table public.kadi_conversion_events to service_role;
grant all on table public.kadi_reengagement_log to service_role;
grant all on table public.kadi_scheduler_guard to service_role;

drop policy if exists "Allow delete logos" on storage.objects;
drop policy if exists "Allow read logos" on storage.objects;
drop policy if exists "Allow uploads to logos" on storage.objects;
