-- Independent probe families move with their producers and readers (#12158).
-- Epoch milliseconds are exactly representable integers; JSON remains JSON
-- text and nullable booleans preserve the meaning of an absent observation.
CREATE TABLE attribution_candidates (
  netuid INTEGER NOT NULL,
  ss58 TEXT NOT NULL,
  source_url TEXT NOT NULL,
  first_seen INTEGER NOT NULL CHECK (first_seen >= 1000000000000),
  last_seen INTEGER NOT NULL CHECK (last_seen >= 1000000000000),
  PRIMARY KEY (netuid, ss58, source_url)
);
-- statement-breakpoint
CREATE INDEX idx_attribution_candidates_netuid_last ON attribution_candidates (netuid, last_seen DESC);
-- statement-breakpoint
CREATE TABLE attribution_sweeps (
  netuid INTEGER PRIMARY KEY NOT NULL,
  swept_at INTEGER NOT NULL CHECK (swept_at >= 1000000000000),
  sources_checked INTEGER NOT NULL,
  sources_read INTEGER NOT NULL,
  candidates INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('none-published', 'candidates-found', 'unreachable', 'no-sources', 'listings-only')),
  CHECK (sources_checked >= 0 AND sources_read >= 0 AND sources_read <= sources_checked AND candidates >= 0)
);
-- statement-breakpoint
CREATE TABLE origin_reachability (
  origin TEXT PRIMARY KEY NOT NULL,
  checked_at INTEGER NOT NULL CHECK (checked_at >= 1000000000000),
  surface_count INTEGER NOT NULL CHECK (surface_count >= 0),
  samples INTEGER NOT NULL CHECK (samples >= 0),
  verdict TEXT NOT NULL CHECK (verdict IN ('serving', 'unreachable', 'not-routing', 'indeterminate'))
);
-- statement-breakpoint
CREATE INDEX idx_origin_reachability_verdict ON origin_reachability (verdict, checked_at DESC);
-- statement-breakpoint
CREATE TABLE compute_declarations (
  netuid INTEGER NOT NULL,
  source_url TEXT NOT NULL,
  read_at_sha TEXT NOT NULL,
  observed_at INTEGER NOT NULL CHECK (observed_at >= 1000000000000),
  first_seen INTEGER NOT NULL CHECK (first_seen >= 1000000000000),
  found INTEGER NOT NULL CHECK (found IN (0, 1)),
  spec_version TEXT,
  miner TEXT CHECK (miner IS NULL OR (json_valid(miner) AND json_type(miner) = 'object')),
  validator TEXT CHECK (validator IS NULL OR (json_valid(validator) AND json_type(validator) = 'object')),
  unscoped TEXT CHECK (unscoped IS NULL OR (json_valid(unscoped) AND json_type(unscoped) = 'object')),
  PRIMARY KEY (netuid, source_url),
  CHECK (found = 0 OR miner IS NOT NULL OR validator IS NOT NULL OR unscoped IS NOT NULL),
  CHECK (found = 1 OR (miner IS NULL AND validator IS NULL AND unscoped IS NULL))
);
-- statement-breakpoint
CREATE INDEX idx_attribution_candidates_last_seen ON attribution_candidates (last_seen DESC);
-- statement-breakpoint
CREATE INDEX idx_attribution_sweeps_swept_at ON attribution_sweeps (swept_at DESC);
-- statement-breakpoint
CREATE INDEX idx_origin_reachability_checked_at ON origin_reachability (checked_at DESC);
-- statement-breakpoint
CREATE INDEX idx_compute_declarations_observed_at ON compute_declarations (observed_at DESC);
