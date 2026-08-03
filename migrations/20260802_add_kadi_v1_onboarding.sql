alter table public.business_profiles
  add column if not exists phone_normalized text,
  add column if not exists onboarding_status text,
  add column if not exists welcome_credits_eligibility text,
  add column if not exists voice_response_mode text,
  add column if not exists locale text,
  add column if not exists v1_created_at timestamptz,
  add column if not exists v1_updated_at timestamptz,
  add column if not exists onboarding_started_at timestamptz,
  add column if not exists onboarding_completed_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'business_profiles_v1_onboarding_status_check') then
    alter table public.business_profiles
      add constraint business_profiles_v1_onboarding_status_check
      check (onboarding_status is null or onboarding_status in ('IN_PROGRESS', 'COMPLETED', 'HISTORICAL_UNKNOWN')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_profiles_v1_welcome_eligibility_check') then
    alter table public.business_profiles
      add constraint business_profiles_v1_welcome_eligibility_check
      check (welcome_credits_eligibility is null or welcome_credits_eligibility in ('ELIGIBLE', 'GRANTED', 'HISTORICAL_UNKNOWN')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_profiles_v1_voice_mode_check') then
    alter table public.business_profiles
      add constraint business_profiles_v1_voice_mode_check
      check (voice_response_mode is null or voice_response_mode in ('TEXT_ONLY', 'TEXT_AND_VOICE', 'VOICE_WHEN_HELPFUL')) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'business_profiles_v1_locale_check') then
    alter table public.business_profiles
      add constraint business_profiles_v1_locale_check
      check (locale is null or locale ~ '^[a-z]{2}(-[A-Z]{2})?$') not valid;
  end if;
end $$;

create table if not exists public.kadi_v1_onboarding_events (
  event_id bigint generated always as identity primary key,
  wa_id text not null,
  event_type text not null,
  idempotency_key text not null unique,
  status text not null default 'SUCCEEDED',
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint kadi_v1_onboarding_events_type_check check (
    event_type in (
      'USER_PROFILE_CREATED', 'WELCOME_CREDITS_GRANTED', 'WELCOME_TEXT_READY',
      'WELCOME_VOICE_REQUESTED', 'WELCOME_VOICE_FAILED', 'ONBOARDING_STARTED',
      'ONBOARDING_RESUMED', 'ONBOARDING_COMPLETED', 'USER_REACTIVATED'
    )
  ),
  constraint kadi_v1_onboarding_events_status_check check (status in ('SUCCEEDED', 'FAILED', 'REQUESTED')),
  constraint kadi_v1_onboarding_events_key_check check (
    length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9:_.-]+$'
  ),
  constraint kadi_v1_onboarding_events_metadata_check check (jsonb_typeof(metadata) = 'object')
);

create index if not exists kadi_v1_onboarding_events_wa_time_idx
  on public.kadi_v1_onboarding_events (wa_id, occurred_at desc);

create or replace function public.kadi_v1_create_or_get_minimal_profile(
  p_wa_id text,
  p_phone_normalized text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.business_profiles%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_wa_id is null or p_wa_id !~ '^\d{8,20}$' then
    raise exception 'KADI_V1_WA_ID_INVALID';
  end if;
  if p_phone_normalized is not null and p_phone_normalized !~ '^\d{8,20}$' then
    raise exception 'KADI_V1_PHONE_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_profile:' || p_wa_id, 0));

  select * into v_profile from public.business_profiles where wa_id = p_wa_id for update;
  if found then
    return jsonb_build_object('ok', true, 'created', false, 'profile', to_jsonb(v_profile));
  end if;

  insert into public.business_profiles (
    wa_id, phone_normalized, welcome_credits_granted, onboarding_done, onboarding_version,
    onboarding_status, welcome_credits_eligibility, voice_response_mode, locale,
    v1_created_at, v1_updated_at
  ) values (
    p_wa_id, p_phone_normalized, false, false, 1,
    'IN_PROGRESS', 'ELIGIBLE', 'VOICE_WHEN_HELPFUL', 'fr-BF', v_now, v_now
  ) returning * into v_profile;

  insert into public.kadi_v1_onboarding_events (wa_id, event_type, idempotency_key)
  values (p_wa_id, 'USER_PROFILE_CREATED', 'user_profile:' || p_wa_id)
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object('ok', true, 'created', true, 'profile', to_jsonb(v_profile));
end;
$$;

create or replace function public.kadi_v1_grant_welcome_credits(
  p_wa_id text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.business_profiles%rowtype;
  v_credit_result jsonb;
  v_now timestamptz := clock_timestamp();
begin
  if p_wa_id is null or p_idempotency_key <> ('welcome_credits:' || p_wa_id) then
    raise exception 'KADI_V1_WELCOME_KEY_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_welcome:' || p_wa_id, 0));
  select * into v_profile from public.business_profiles where wa_id = p_wa_id for update;
  if not found then
    raise exception 'KADI_V1_PROFILE_NOT_FOUND';
  end if;

  if v_profile.welcome_credits_granted is true or v_profile.welcome_credits_eligibility = 'GRANTED' then
    return jsonb_build_object('ok', true, 'granted_now', false, 'duplicate', true);
  end if;
  if v_profile.welcome_credits_eligibility is distinct from 'ELIGIBLE' then
    return jsonb_build_object('ok', false, 'error', 'WELCOME_CREDITS_ELIGIBILITY_UNKNOWN');
  end if;

  select public.kadi_add_credits_v2(
    p_wa_id => p_wa_id,
    p_bsuid => null,
    p_username => null,
    p_parent_bsuid => null,
    p_profile_name => null,
    p_amount => 5,
    p_reason => 'WELCOME_CREDITS',
    p_operation_key => p_idempotency_key,
    p_meta => jsonb_build_object('ledger_type', 'WELCOME_CREDITS', 'source', 'kadi_v1_onboarding')
  ) into v_credit_result;
  if coalesce((v_credit_result->>'ok')::boolean, false) is not true then
    raise exception 'KADI_V1_WELCOME_CREDIT_FAILED';
  end if;

  update public.business_profiles
  set welcome_credits_granted = true,
      welcome_credits_eligibility = 'GRANTED',
      v1_updated_at = v_now
  where wa_id = p_wa_id
  returning * into v_profile;

  insert into public.kadi_v1_onboarding_events (wa_id, event_type, idempotency_key)
  values (p_wa_id, 'WELCOME_CREDITS_GRANTED', p_idempotency_key)
  on conflict (idempotency_key) do nothing;

  return jsonb_build_object(
    'ok', true,
    'granted_now', true,
    'duplicate', false,
    'balance', v_credit_result->'balance'
  );
end;
$$;

create or replace function public.kadi_v1_record_onboarding_event(
  p_wa_id text,
  p_event_type text,
  p_idempotency_key text,
  p_status text default 'SUCCEEDED'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.kadi_v1_onboarding_events%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_event:' || p_idempotency_key, 0));
  if not exists (select 1 from public.business_profiles where wa_id = p_wa_id) then
    raise exception 'KADI_V1_PROFILE_NOT_FOUND';
  end if;
  select * into v_existing from public.kadi_v1_onboarding_events
  where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.wa_id <> p_wa_id or v_existing.event_type <> p_event_type then
      raise exception 'KADI_V1_ONBOARDING_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  insert into public.kadi_v1_onboarding_events (wa_id, event_type, idempotency_key, status)
  values (p_wa_id, p_event_type, p_idempotency_key, p_status);
  return jsonb_build_object('ok', true, 'duplicate', false);
end;
$$;

create or replace function public.kadi_v1_set_onboarding_status(
  p_wa_id text,
  p_status text,
  p_event_type text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_profile public.business_profiles%rowtype;
  v_existing public.kadi_v1_onboarding_events%rowtype;
  v_now timestamptz := clock_timestamp();
begin
  if p_status not in ('IN_PROGRESS', 'COMPLETED') then
    raise exception 'KADI_V1_ONBOARDING_STATUS_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('kadi_v1_onboarding:' || p_wa_id, 0));
  select * into v_profile from public.business_profiles where wa_id = p_wa_id for update;
  if not found then raise exception 'KADI_V1_PROFILE_NOT_FOUND'; end if;

  select * into v_existing from public.kadi_v1_onboarding_events where idempotency_key = p_idempotency_key;
  if found then
    if v_existing.wa_id <> p_wa_id or v_existing.event_type <> p_event_type then
      raise exception 'KADI_V1_ONBOARDING_IDEMPOTENCY_CONFLICT';
    end if;
    return jsonb_build_object('ok', true, 'duplicate', true, 'profile', to_jsonb(v_profile));
  end if;

  update public.business_profiles
  set onboarding_status = p_status,
      onboarding_started_at = case when p_event_type in ('ONBOARDING_STARTED', 'ONBOARDING_RESUMED') then coalesce(onboarding_started_at, v_now) else onboarding_started_at end,
      onboarding_completed_at = case when p_event_type = 'ONBOARDING_COMPLETED' then v_now else onboarding_completed_at end,
      onboarding_done = (p_status = 'COMPLETED'),
      v1_updated_at = v_now
  where wa_id = p_wa_id
  returning * into v_profile;

  insert into public.kadi_v1_onboarding_events (wa_id, event_type, idempotency_key)
  values (p_wa_id, p_event_type, p_idempotency_key);
  return jsonb_build_object('ok', true, 'duplicate', false, 'profile', to_jsonb(v_profile));
end;
$$;

alter table public.kadi_v1_onboarding_events enable row level security;

revoke all on function public.kadi_v1_create_or_get_minimal_profile(text, text) from public;
revoke all on function public.kadi_v1_grant_welcome_credits(text, text) from public;
revoke all on function public.kadi_v1_record_onboarding_event(text, text, text, text) from public;
revoke all on function public.kadi_v1_set_onboarding_status(text, text, text, text) from public;
grant execute on function public.kadi_v1_create_or_get_minimal_profile(text, text) to service_role;
grant execute on function public.kadi_v1_grant_welcome_credits(text, text) to service_role;
grant execute on function public.kadi_v1_record_onboarding_event(text, text, text, text) to service_role;
grant execute on function public.kadi_v1_set_onboarding_status(text, text, text, text) to service_role;

-- KADI_V1_SERVICE_ROLE_ONLY_BEGIN
revoke all on function public.kadi_v1_create_or_get_minimal_profile(text, text) from public;
revoke all on function public.kadi_v1_create_or_get_minimal_profile(text, text) from anon;
revoke all on function public.kadi_v1_create_or_get_minimal_profile(text, text) from authenticated;
grant execute on function public.kadi_v1_create_or_get_minimal_profile(text, text) to service_role;
revoke all on function public.kadi_v1_grant_welcome_credits(text, text) from public;
revoke all on function public.kadi_v1_grant_welcome_credits(text, text) from anon;
revoke all on function public.kadi_v1_grant_welcome_credits(text, text) from authenticated;
grant execute on function public.kadi_v1_grant_welcome_credits(text, text) to service_role;
revoke all on function public.kadi_v1_record_onboarding_event(text, text, text, text) from public;
revoke all on function public.kadi_v1_record_onboarding_event(text, text, text, text) from anon;
revoke all on function public.kadi_v1_record_onboarding_event(text, text, text, text) from authenticated;
grant execute on function public.kadi_v1_record_onboarding_event(text, text, text, text) to service_role;
revoke all on function public.kadi_v1_set_onboarding_status(text, text, text, text) from public;
revoke all on function public.kadi_v1_set_onboarding_status(text, text, text, text) from anon;
revoke all on function public.kadi_v1_set_onboarding_status(text, text, text, text) from authenticated;
grant execute on function public.kadi_v1_set_onboarding_status(text, text, text, text) to service_role;
-- KADI_V1_SERVICE_ROLE_ONLY_END
