begin;

create or replace function public.kadi_v1_complete_onboarding_profile(
  p_wa_id text,
  p_owner_name text,
  p_business_name text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_owner_name text := btrim(coalesce(p_owner_name, ''));
  v_business_name text := nullif(btrim(coalesce(p_business_name, '')), '');
  v_existing public.kadi_v1_onboarding_events%rowtype;
  v_profile public.business_profiles%rowtype;
begin
  if p_wa_id is null or p_wa_id !~ '^[0-9]{8,20}$' then
    raise exception 'V1_PROFILE_WA_ID_INVALID';
  end if;

  if length(v_owner_name) < 2 or length(v_owner_name) > 80 then
    raise exception 'KADI_V1_ONBOARDING_OWNER_NAME_INVALID';
  end if;

  if v_business_name is not null and (
    length(v_business_name) < 2 or
    length(v_business_name) > 120
  ) then
    raise exception 'KADI_V1_ONBOARDING_BUSINESS_NAME_INVALID';
  end if;

  if p_idempotency_key is null or
     length(p_idempotency_key) not between 1 and 200 or
     p_idempotency_key !~ '^[A-Za-z0-9:_.-]+$' then
    raise exception 'ONBOARDING_IDEMPOTENCY_KEY_INVALID';
  end if;

  select *
  into v_existing
  from public.kadi_v1_onboarding_events
  where idempotency_key = p_idempotency_key;

  if found then
    if v_existing.wa_id <> p_wa_id or
       v_existing.event_type <> 'ONBOARDING_COMPLETED' then
      raise exception 'KADI_V1_ONBOARDING_IDEMPOTENCY_CONFLICT';
    end if;

    select *
    into v_profile
    from public.business_profiles
    where wa_id = p_wa_id;

    if not found then
      raise exception 'V1_PROFILE_NOT_FOUND';
    end if;

    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'profile', to_jsonb(v_profile)
    );
  end if;

  update public.business_profiles
  set owner_name = v_owner_name,
      business_name = coalesce(v_business_name, business_name),
      onboarding_status = 'COMPLETED',
      onboarding_started_at = coalesce(onboarding_started_at, v_now),
      onboarding_completed_at = v_now,
      onboarding_done = true,
      v1_updated_at = v_now
  where wa_id = p_wa_id
  returning * into v_profile;

  if not found then
    raise exception 'V1_PROFILE_NOT_FOUND';
  end if;

  insert into public.kadi_v1_onboarding_events (
    wa_id,
    event_type,
    idempotency_key,
    status
  )
  values (
    p_wa_id,
    'ONBOARDING_COMPLETED',
    p_idempotency_key,
    'SUCCEEDED'
  );

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'profile', to_jsonb(v_profile)
  );
end;
$$;

revoke all on function public.kadi_v1_complete_onboarding_profile(
  text,
  text,
  text,
  text
) from public;

grant execute on function public.kadi_v1_complete_onboarding_profile(
  text,
  text,
  text,
  text
) to service_role;

commit;
