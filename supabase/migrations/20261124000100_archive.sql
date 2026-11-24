BEGIN;
ALTER TABLE public.businesses
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid,
  ADD CHECK (archived_at IS NULL OR (NOT is_active AND archived_by IS NOT NULL));
ALTER TABLE public.services
  ADD COLUMN archived_at timestamptz,
  ADD COLUMN archived_by uuid,
  ADD CHECK (archived_at IS NULL OR (NOT is_active AND archived_by IS NOT NULL));
COMMIT;
