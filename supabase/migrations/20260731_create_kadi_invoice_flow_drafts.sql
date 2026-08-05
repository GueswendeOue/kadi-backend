create table if not exists public.kadi_invoice_flow_drafts (
  draft_id uuid primary key,
  flow_token_ref text not null,
  owner_ref text not null,
  status text not null check (status in (
    'collecting_client', 'collecting_items', 'collecting_options', 'ready_for_quote',
    'quoted', 'confirmed', 'cancelled', 'expired'
  )),
  client jsonb,
  items jsonb not null default '[]'::jsonb,
  options jsonb,
  processed_action_keys jsonb not null default '[]'::jsonb,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  expires_at timestamptz not null,
  version integer not null default 1
);
create index if not exists kadi_invoice_flow_drafts_owner_expiry_idx
  on public.kadi_invoice_flow_drafts (owner_ref, expires_at);
create unique index if not exists kadi_invoice_flow_drafts_owner_token_uidx
  on public.kadi_invoice_flow_drafts (owner_ref, flow_token_ref);
alter table public.kadi_invoice_flow_drafts enable row level security;
