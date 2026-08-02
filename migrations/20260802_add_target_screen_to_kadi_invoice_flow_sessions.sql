alter table public.kadi_invoice_flow_sessions
  add column if not exists target_screen text;

alter table public.kadi_invoice_flow_sessions
  add column if not exists return_to_review boolean not null default false;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'kadi_invoice_flow_sessions_target_screen_check'
      and conrelid = 'public.kadi_invoice_flow_sessions'::regclass
  ) then
    alter table public.kadi_invoice_flow_sessions
      add constraint kadi_invoice_flow_sessions_target_screen_check
      check (
        target_screen is null or target_screen in (
          'CLIENT',
          'ARTICLE_ENTRY',
          'OPTIONS',
          'REVIEW_INVOICE_DRAFT',
          'EDIT_CLIENT',
          'EDIT_ITEMS',
          'EDIT_OPTIONS'
        )
      );
  end if;
end $$;
