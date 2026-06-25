-- Add spec_version to blocks for runtime version context (#1817)
ALTER TABLE blocks ADD COLUMN spec_version INTEGER;
