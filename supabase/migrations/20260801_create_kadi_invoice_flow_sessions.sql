create table if not exists public.kadi_invoice_flow_sessions (
  flow_token_hash text primary key,
  owner_ref text not null,
  draft_id uuid not null references public.kadi_invoice_flow_drafts(draft_id),
  status text not null default 'active' check (status in ('active', 'revoked', 'consumed')),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  revoked_at timestamptz
);
create index if not exists kadi_invoice_flow_sessions_owner_idx
  on public.kadi_invoice_flow_sessions (owner_ref, expires_at);
alter table public.kadi_invoice_flow_sessions enable row level security;
