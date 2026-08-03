-- P1 Supabase hardening for analytics views and active V2 RPCs.

alter view public.kadi_credit_events_unified
  set (security_invoker = true);
alter view public.kadi_dashboard_stats_v1
  set (security_invoker = true);
alter view public.kadi_metrics_daily_v1
  set (security_invoker = true);
alter view public.kadi_conversion_pipeline_v1
  set (security_invoker = true);

revoke all on table public.kadi_credit_events_unified
  from public, anon, authenticated;
revoke all on table public.kadi_dashboard_stats_v1
  from public, anon, authenticated;
revoke all on table public.kadi_metrics_daily_v1
  from public, anon, authenticated;
revoke all on table public.kadi_conversion_pipeline_v1
  from public, anon, authenticated;

grant select on table public.kadi_credit_events_unified to service_role;
grant select on table public.kadi_dashboard_stats_v1 to service_role;
grant select on table public.kadi_metrics_daily_v1 to service_role;
grant select on table public.kadi_conversion_pipeline_v1 to service_role;

alter function public.kadi_resolve_profile_v2(
  text, text, text, text, text
) set search_path = public, pg_temp;

alter function public.kadi_add_credits_v2(
  text, text, text, text, text, integer, text, text, jsonb
) set search_path = public, pg_temp;

alter function public.kadi_consume_credits_v2(
  text, text, text, text, text, integer, text, text, jsonb
) set search_path = public, pg_temp;

alter function public.kadi_redeem_code_v2(
  text, text, text, text, text, text
) set search_path = public, pg_temp;

alter function public.kadi_record_activity(text)
  set search_path = public, pg_temp;

revoke all on function public.kadi_resolve_profile_v2(
  text, text, text, text, text
) from public, anon, authenticated;

revoke all on function public.kadi_add_credits_v2(
  text, text, text, text, text, integer, text, text, jsonb
) from public, anon, authenticated;

revoke all on function public.kadi_consume_credits_v2(
  text, text, text, text, text, integer, text, text, jsonb
) from public, anon, authenticated;

revoke all on function public.kadi_redeem_code_v2(
  text, text, text, text, text, text
) from public, anon, authenticated;

revoke all on function public.kadi_record_activity(text)
  from public, anon, authenticated;

grant execute on function public.kadi_resolve_profile_v2(
  text, text, text, text, text
) to service_role;

grant execute on function public.kadi_add_credits_v2(
  text, text, text, text, text, integer, text, text, jsonb
) to service_role;

grant execute on function public.kadi_consume_credits_v2(
  text, text, text, text, text, integer, text, text, jsonb
) to service_role;

grant execute on function public.kadi_redeem_code_v2(
  text, text, text, text, text, text
) to service_role;

grant execute on function public.kadi_record_activity(text)
  to service_role;
