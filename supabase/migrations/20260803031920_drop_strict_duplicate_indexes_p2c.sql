-- P2C: remove strictly duplicated indexes.

drop index if exists public.business_profiles_wa_id_uq;
drop index if exists public.business_profiles_user_id_idx;
drop index if exists public.idx_business_profiles_wa_id;

drop index if exists public.kadi_doc_counters_uq;
drop index if exists public.kadi_doc_counters_wa_prefix_uq;

drop index if exists public.kadi_documents_wa_id_idx;
