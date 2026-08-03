-- P3: restrict remaining statistical views to service_role.

revoke select on public.kadi_active_users_30d from public, anon, authenticated;
revoke select on public.kadi_all_known_users from public, anon, authenticated;
revoke select on public.kadi_stats_adoption_kpis from public, anon, authenticated;
revoke select on public.kadi_stats_by_sector from public, anon, authenticated;
revoke select on public.kadi_stats_codes from public, anon, authenticated;
revoke select on public.kadi_stats_credits_daily_30d from public, anon, authenticated;
revoke select on public.kadi_stats_credits_kpis from public, anon, authenticated;
revoke select on public.kadi_stats_docs_by_type from public, anon, authenticated;
revoke select on public.kadi_stats_docs_daily_30d from public, anon, authenticated;
revoke select on public.kadi_stats_facture_kinds from public, anon, authenticated;
revoke select on public.kadi_stats_retention_weekly from public, anon, authenticated;
revoke select on public.kadi_stats_revenue_estimate from public, anon, authenticated;
revoke select on public.kadi_stats_top_consumers from public, anon, authenticated;

grant select on public.kadi_active_users_30d to service_role;
grant select on public.kadi_all_known_users to service_role;
grant select on public.kadi_stats_adoption_kpis to service_role;
grant select on public.kadi_stats_by_sector to service_role;
grant select on public.kadi_stats_codes to service_role;
grant select on public.kadi_stats_credits_daily_30d to service_role;
grant select on public.kadi_stats_credits_kpis to service_role;
grant select on public.kadi_stats_docs_by_type to service_role;
grant select on public.kadi_stats_docs_daily_30d to service_role;
grant select on public.kadi_stats_facture_kinds to service_role;
grant select on public.kadi_stats_retention_weekly to service_role;
grant select on public.kadi_stats_revenue_estimate to service_role;
grant select on public.kadi_stats_top_consumers to service_role;
