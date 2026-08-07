-- fix/kadi-v1-delivery-retry-and-final-filenames-r0 (final-review follow-up)
-- — kadi_v1_delivery_attempts.status was only ever allowed to be 'PENDING',
-- 'DELIVERED' or 'RECOVERABLE_FAILURE' in the database, but the application
-- layer (kadiV1DeliveryService.js claim()) already attempts to persist an
-- 'IN_PROGRESS' status before calling the WhatsApp provider, so a real claim
-- against this table fails with a check_violation (23514) and never reaches
-- the provider at all. The in-memory test repository silently allowed the
-- extra value, which is why this gap was not caught until a schema-level
-- review against the real migration file.
--
-- Forward-only fix: widen the status CHECK constraint to also allow
-- 'IN_PROGRESS'. No data is rewritten and no existing row's status changes
-- meaning; this only permits a new value going forward.

alter table public.kadi_v1_delivery_attempts
  drop constraint if exists kadi_v1_delivery_attempts_status_check;

alter table public.kadi_v1_delivery_attempts
  add constraint kadi_v1_delivery_attempts_status_check
  check (status in ('PENDING', 'IN_PROGRESS', 'DELIVERED', 'RECOVERABLE_FAILURE'));
