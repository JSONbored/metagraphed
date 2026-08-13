-- #10933: what a subnet's own published source says it allocates to a treasury.
--
-- WHY THIS IS A TABLE AND NOT A REGISTRY FILE. Same split as
-- 0018_attribution_sweeps.sql, and it was got wrong once during design before
-- being corrected: a subnet DECLARING its own policy is a contribution and
-- belongs in registry/subnets/<slug>.json as an `operator-attested` surface,
-- reviewed like every other. This table is the other half -- the OBSERVATION
-- that we read a public repo at a commit on a date and found an allocation (or
-- found none). That is machine-produced and timestamped, it re-reads whenever
-- the repo moves, and committing a file per reading would put a git commit and
-- a gate review in front of every measurement.
--
-- THE CITATION LIVES ON THE READING, NOT ON THE SURFACE. A `source-repo`
-- surface's `source_url` points at a branch, correctly: a human clicks it and
-- wants the current code. But a branch moves under a claim, so the evidence for
-- a finding is the SHA that was HEAD WHEN WE READ IT -- recorded here, per
-- reading. All 142 source-repo surfaces are unpinned today and none of them
-- need to be: a repo nobody has read has no citation to check.
--
-- THE NEGATIVE IS THE POINT, again. Most subnets take no treasury cut, and a
-- disclosed cut in a public repo is a business model rather than a finding. So
-- `found = false` is a real row -- "read at this commit, on this date, nothing
-- allocated" -- and it must never be confused with a repo nobody has opened.
-- The first is evidence; the second is silence, and silence is absence of a
-- record here rather than a `false`.
CREATE TABLE IF NOT EXISTS treasury_readings (
  netuid           INTEGER NOT NULL,
  -- The repo surface that was read. Part of the key because a subnet can
  -- register more than one source-repo (validator and miner are often split),
  -- and they can disagree -- which is itself worth seeing rather than
  -- collapsing to whichever was read last.
  source_url       TEXT    NOT NULL,
  -- HEAD at read time. THIS IS THE CITATION: it is what makes the finding
  -- re-derivable by someone who does not trust us, and what a re-read diffs
  -- against to know the repo moved.
  read_at_sha      TEXT    NOT NULL,
  observed_at      BIGINT  NOT NULL,
  -- Preserved across re-reads, like attribution_candidates' own first_seen, so
  -- "we have been watching this since" survives a repo that moves weekly.
  first_seen       BIGINT  NOT NULL,
  -- Did the read find an allocation? FALSE is a measurement -- read, found
  -- nothing -- and is the expected answer for most subnets.
  found            BOOLEAN NOT NULL,
  -- The finding itself. All null when `found` is false. `declared_share` is a
  -- fraction (0..1), never a percentage, matching every other share in this
  -- schema.
  declared_share   DOUBLE PRECISION,
  treasury_address TEXT,
  -- What the allocation is taken from: miner-emission | payout | fee. Free text
  -- rather than an enum at the DB level because the vocabulary is owned by
  -- schemas-src and a CHECK here would be a second copy of it.
  applies_to       TEXT,
  -- Where in the repo, so a reviewer opens the right file rather than the repo.
  evidence_path    TEXT,
  -- THE HUMAN GATE, as a column rather than a PR. A deterministic extractor
  -- writes `candidate`; a maintainer promotes to `reviewed` or `rejected` from
  -- metagraphed-infra against DATABASE_URL. Deliberately NOT the registry's
  -- community-submitted/maintainer-reviewed/rejected vocabulary: that axis is
  -- about a contribution someone offered, this one is about a machine reading
  -- nobody offered, and sharing the words would imply a shared workflow.
  review_state     TEXT    NOT NULL DEFAULT 'candidate',
  reviewed_at      BIGINT,
  PRIMARY KEY (netuid, source_url),
  CONSTRAINT treasury_readings_observed_at_is_millis
    CHECK (observed_at >= 1000000000000),
  CONSTRAINT treasury_readings_first_seen_is_millis
    CHECK (first_seen >= 1000000000000),
  CONSTRAINT treasury_readings_review_state_known
    CHECK (review_state IN ('candidate', 'reviewed', 'rejected')),
  -- A share is a fraction. 10 here would be a 1000% treasury cut, which is the
  -- shape a percentage-vs-fraction mix-up takes.
  CONSTRAINT treasury_readings_share_is_a_fraction
    CHECK (declared_share IS NULL OR (declared_share >= 0 AND declared_share <= 1)),
  -- A finding needs something found. Enforced here as well as in the schema
  -- because the extractor writes directly, with no route in front of it to
  -- validate against Zod.
  CONSTRAINT treasury_readings_finding_needs_a_share
    CHECK (found = FALSE OR declared_share IS NOT NULL OR treasury_address IS NOT NULL),
  -- ...and a non-finding may not carry one.
  CONSTRAINT treasury_readings_nothing_found_declares_nothing
    CHECK (found = TRUE OR (declared_share IS NULL AND treasury_address IS NULL))
);

-- The serving read is "every reviewed reading for this subnet"; the extractor's
-- is "what did I last see for this repo".
CREATE INDEX IF NOT EXISTS idx_treasury_readings_netuid_state
  ON treasury_readings (netuid, review_state);
