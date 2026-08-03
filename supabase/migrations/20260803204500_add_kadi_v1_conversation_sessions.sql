create table if not exists public.kadi_v1_conversation_sessions (
  session_id text primary key
    check (session_id ~ '^[A-Za-z0-9:_-]{1,200}$'),
  owner_wa_id text not null
    check (owner_wa_id ~ '^[0-9]{8,20}$'),
  document_id text,
  document_version integer,
  document_type text
    check (document_type is null or document_type in ('FACTURE', 'DEVIS', 'RECU', 'DECHARGE')),
  document_state text
    check (
      document_state is null or document_state in (
        'COLLECTING', 'INCOMPLETE', 'READY_FOR_REVIEW', 'VERIFIED',
        'PREVIEW_READY', 'COST_CALCULATED',
        'AWAITING_GENERATION_CONFIRMATION', 'RECHARGE_REQUIRED',
        'GENERATION_IN_PROGRESS', 'GENERATED', 'DELIVERED',
        'RECOVERABLE_FAILURE', 'CANCELLED'
      )
    ),
  expected_flow_key text not null
    check (
      expected_flow_key in (
        'ONBOARDING', 'MENU', 'DOCUMENT_TYPE', 'DOCUMENT_CLIENT',
        'DOCUMENT_CONTENT', 'DOCUMENT_OPTIONS', 'DOCUMENT_REVIEW',
        'EDIT_CLIENT', 'EDIT_CONTENT', 'EDIT_OPTIONS',
        'DOCUMENT_PREVIEW', 'GENERATION_CONFIRMATION', 'RECHARGE',
        'HISTORY_SEARCH', 'DISCHARGE_DETAILS'
      )
    ),
  return_state text
    check (
      return_state is null or return_state in (
        'COLLECTING', 'INCOMPLETE', 'READY_FOR_REVIEW', 'VERIFIED',
        'PREVIEW_READY', 'COST_CALCULATED',
        'AWAITING_GENERATION_CONFIRMATION', 'RECHARGE_REQUIRED',
        'GENERATION_IN_PROGRESS', 'GENERATED', 'DELIVERED',
        'RECOVERABLE_FAILURE', 'CANCELLED'
      )
    ),
  status text not null
    check (status in ('OPEN', 'CONSUMED', 'EXPIRED', 'REVOKED')),
  opened_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz,
  consumed_reply_key text
    check (
      consumed_reply_key is null or
      consumed_reply_key ~ '^[A-Za-z0-9:_.-]{1,200}$'
    ),
  idempotency_key text not null unique
    check (idempotency_key ~ '^[A-Za-z0-9:_.-]{1,200}$'),
  revision integer not null default 1 check (revision >= 1),
  updated_at timestamptz not null default clock_timestamp(),

  constraint kadi_v1_conversation_session_expiry_check
    check (expires_at > opened_at),

  constraint kadi_v1_conversation_session_document_check
    check (
      (
        document_id is null and
        document_version is null and
        document_type is null and
        document_state is null
      )
      or
      (
        document_id is not null and
        document_version is not null and
        document_version >= 1 and
        document_type is not null and
        document_state is not null
      )
    ),

  constraint kadi_v1_conversation_session_consumed_check
    check (
      (
        status = 'CONSUMED' and
        consumed_at is not null and
        consumed_reply_key is not null
      )
      or
      (
        status <> 'CONSUMED' and
        consumed_at is null and
        consumed_reply_key is null
      )
    ),

  constraint kadi_v1_conversation_session_revoked_check
    check (
      (status = 'REVOKED' and revoked_at is not null)
      or
      (status <> 'REVOKED' and revoked_at is null)
    ),

  constraint kadi_v1_conversation_session_document_version_fk
    foreign key (document_id, document_version)
    references public.kadi_v1_document_versions(document_id, version)
);

create index if not exists kadi_v1_conversation_sessions_owner_open_idx
  on public.kadi_v1_conversation_sessions (
    owner_wa_id,
    status,
    opened_at desc
  );

create index if not exists kadi_v1_conversation_sessions_expiry_idx
  on public.kadi_v1_conversation_sessions (expires_at)
  where status = 'OPEN';

create or replace function public.kadi_v1_create_conversation_session(
  p_session jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session public.kadi_v1_conversation_sessions%rowtype;
begin
  if p_session is null or jsonb_typeof(p_session) <> 'object' then
    raise exception 'KADI_V1_SESSION_CREATE_FAILED';
  end if;

  if p_session->>'status' <> 'OPEN' then
    raise exception 'KADI_V1_SESSION_TRANSITION_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'kadi_v1_session_create:' ||
      coalesce(p_session->>'idempotency_key', ''),
      0
    )
  );

  select *
    into v_session
    from public.kadi_v1_conversation_sessions
   where idempotency_key = p_session->>'idempotency_key';

  if found then
    if v_session.owner_wa_id is distinct from p_session->>'owner_wa_id' then
      raise exception 'KADI_V1_SESSION_IDEMPOTENCY_CONFLICT';
    end if;

    return jsonb_build_object(
      'ok', true,
      'duplicate', true,
      'session', to_jsonb(v_session)
    );
  end if;

  begin
    insert into public.kadi_v1_conversation_sessions (
      session_id,
      owner_wa_id,
      document_id,
      document_version,
      document_type,
      document_state,
      expected_flow_key,
      return_state,
      status,
      opened_at,
      expires_at,
      consumed_at,
      revoked_at,
      consumed_reply_key,
      idempotency_key
    ) values (
      p_session->>'session_id',
      p_session->>'owner_wa_id',
      nullif(p_session->>'document_id', ''),
      case
        when p_session->>'document_version' is null then null
        else (p_session->>'document_version')::integer
      end,
      nullif(p_session->>'document_type', ''),
      nullif(p_session->>'document_state', ''),
      p_session->>'expected_flow_key',
      nullif(p_session->>'return_state', ''),
      p_session->>'status',
      (p_session->>'opened_at')::timestamptz,
      (p_session->>'expires_at')::timestamptz,
      null,
      null,
      null,
      p_session->>'idempotency_key'
    )
    returning * into v_session;
  exception
    when unique_violation then
      select *
        into v_session
        from public.kadi_v1_conversation_sessions
       where idempotency_key = p_session->>'idempotency_key';

      if found then
        if v_session.owner_wa_id is distinct from p_session->>'owner_wa_id' then
          raise exception 'KADI_V1_SESSION_IDEMPOTENCY_CONFLICT';
        end if;

        return jsonb_build_object(
          'ok', true,
          'duplicate', true,
          'session', to_jsonb(v_session)
        );
      end if;

      raise exception 'KADI_V1_SESSION_ID_CONFLICT';
  end;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'session', to_jsonb(v_session)
  );
end;
$$;

create or replace function public.kadi_v1_save_conversation_session(
  p_session jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current public.kadi_v1_conversation_sessions%rowtype;
  v_saved public.kadi_v1_conversation_sessions%rowtype;
  v_target_status text;
  v_target_consumed_reply_key text;
begin
  if p_session is null or jsonb_typeof(p_session) <> 'object' then
    raise exception 'KADI_V1_SESSION_SAVE_FAILED';
  end if;

  v_target_status := p_session->>'status';
  v_target_consumed_reply_key :=
    nullif(p_session->>'consumed_reply_key', '');

  if v_target_status not in ('CONSUMED', 'EXPIRED', 'REVOKED') then
    raise exception 'KADI_V1_SESSION_TRANSITION_INVALID';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      'kadi_v1_session_save:' ||
      coalesce(p_session->>'session_id', ''),
      0
    )
  );

  select *
    into v_current
    from public.kadi_v1_conversation_sessions
   where session_id = p_session->>'session_id'
   for update;

  if not found then
    raise exception 'KADI_V1_SESSION_NOT_FOUND';
  end if;

  if v_current.owner_wa_id is distinct from p_session->>'owner_wa_id' then
    raise exception 'KADI_V1_SESSION_OWNER_MISMATCH';
  end if;

  if
    v_current.document_id is distinct from nullif(p_session->>'document_id', '')
    or v_current.document_version is distinct from
      case
        when p_session->>'document_version' is null then null
        else (p_session->>'document_version')::integer
      end
    or v_current.document_type is distinct from nullif(p_session->>'document_type', '')
    or v_current.document_state is distinct from nullif(p_session->>'document_state', '')
    or v_current.expected_flow_key is distinct from p_session->>'expected_flow_key'
    or v_current.return_state is distinct from nullif(p_session->>'return_state', '')
    or v_current.opened_at is distinct from (p_session->>'opened_at')::timestamptz
    or v_current.expires_at is distinct from (p_session->>'expires_at')::timestamptz
    or v_current.idempotency_key is distinct from p_session->>'idempotency_key'
  then
    raise exception 'KADI_V1_SESSION_IMMUTABLE_FIELD_CONFLICT';
  end if;

  if v_current.status <> 'OPEN' then
    if
      v_current.status = v_target_status
      and (
        v_target_status <> 'CONSUMED'
        or v_current.consumed_reply_key is not distinct from
          v_target_consumed_reply_key
      )
    then
      return jsonb_build_object(
        'ok', true,
        'duplicate', true,
        'session', to_jsonb(v_current)
      );
    end if;

    raise exception 'KADI_V1_SESSION_NOT_OPEN';
  end if;

  update public.kadi_v1_conversation_sessions
     set status = v_target_status,
         consumed_at = case
           when v_target_status = 'CONSUMED'
             then (p_session->>'consumed_at')::timestamptz
           else null
         end,
         consumed_reply_key = case
           when v_target_status = 'CONSUMED'
             then v_target_consumed_reply_key
           else null
         end,
         revoked_at = case
           when v_target_status = 'REVOKED'
             then (p_session->>'revoked_at')::timestamptz
           else null
         end,
         revision = revision + 1,
         updated_at = clock_timestamp()
   where session_id = v_current.session_id
     and status = 'OPEN'
  returning * into v_saved;

  if not found then
    raise exception 'KADI_V1_SESSION_NOT_OPEN';
  end if;

  return jsonb_build_object(
    'ok', true,
    'duplicate', false,
    'session', to_jsonb(v_saved)
  );
end;
$$;

alter table public.kadi_v1_conversation_sessions
  enable row level security;

revoke all on table public.kadi_v1_conversation_sessions from public;
revoke all on table public.kadi_v1_conversation_sessions from anon;
revoke all on table public.kadi_v1_conversation_sessions from authenticated;
grant select, insert, update on table public.kadi_v1_conversation_sessions
  to service_role;

-- KADI_V1_SERVICE_ROLE_ONLY_BEGIN
revoke all on function public.kadi_v1_create_conversation_session(jsonb)
  from public;
revoke all on function public.kadi_v1_create_conversation_session(jsonb)
  from anon;
revoke all on function public.kadi_v1_create_conversation_session(jsonb)
  from authenticated;
grant execute on function public.kadi_v1_create_conversation_session(jsonb)
  to service_role;

revoke all on function public.kadi_v1_save_conversation_session(jsonb)
  from public;
revoke all on function public.kadi_v1_save_conversation_session(jsonb)
  from anon;
revoke all on function public.kadi_v1_save_conversation_session(jsonb)
  from authenticated;
grant execute on function public.kadi_v1_save_conversation_session(jsonb)
  to service_role;
-- KADI_V1_SERVICE_ROLE_ONLY_END
