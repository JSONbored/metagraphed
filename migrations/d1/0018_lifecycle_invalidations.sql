-- Keep incorrect derived events and their correction evidence in place.
-- Serving, lifecycle comparison, and archive export ignore invalidated rows.
ALTER TABLE subnet_lifecycle ADD COLUMN _invalidated_at INTEGER;
-- statement-breakpoint
ALTER TABLE subnet_lifecycle ADD COLUMN _invalidation_reason TEXT;
