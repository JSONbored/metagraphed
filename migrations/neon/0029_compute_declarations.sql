-- #10932 phase 1: what a subnet's own min_compute declaration says it takes to
-- run a miner or a validator there.
--
-- WHY THIS IS A TABLE AND NOT A REGISTRY FILE. The same layer split as
-- 0028_treasury_readings.sql: the registry holds what a subnet DECLARES (the
-- `data-artifact` surface pointing at its min_compute.yml, contributed and
-- reviewed like every other), and this holds what we OBSERVED when we read
-- that file at a commit on a date. The reading re-runs whenever the file moves;
-- committing one per read would put a git commit and a gate review in front of
-- every measurement.
--
-- THE DECLARED VALUES ARE STORED RAW, AND THE JUDGEMENT IS MADE ON READ. The
-- two stanzas land here as JSONB exactly as the file spells them -- including
-- the self-contradicting ones -- and every derived answer (the GPU tri-state
-- most of all) is computed by src/cost-to-participate.ts at serving time.
-- That is deliberate and it is the opposite of the treasury table, where the
-- finding is settled before it is stored:
--
--   * the extraction is MECHANICAL. "What does this YAML say" needs no review,
--     unlike "is this line a treasury cut", so there is no review_state here.
--   * the INTERPRETATION is ours and it will change. Reading `required: False`
--     beside `min_vram: 8` as "declared inconsistently" is a rule we can
--     improve without re-fetching 17 files, and improving it must not require
--     a backfill.
--   * a stanza we have no rule for yet is still preserved, so the fix later is
--     a code change rather than a re-read of a repo that has since moved.
--
-- WHAT `found = false` MEANS, and it is not "no requirements". It means the URL
-- was fetched and carried no parseable compute_spec -- evidence, and distinct
-- from the 111 of 128 subnets that register no min_compute surface at all and
-- so have NO ROW here. A card must be able to tell "declared nothing" from
-- "nobody has looked", exactly as the treasury card does.
CREATE TABLE IF NOT EXISTS compute_declarations (
  netuid        INTEGER NOT NULL,
  -- The registered surface that was read. Part of the key because a subnet can
  -- register more than one (validator and miner repos are sometimes split) and
  -- they can disagree, which is worth seeing rather than collapsing to
  -- whichever was read last.
  source_url    TEXT    NOT NULL,
  -- HEAD at read time. THE CITATION: 14 of the 17 registered surfaces point at
  -- `main`, which moves under a claim, so what makes a reading checkable is the
  -- commit that was HEAD when it was taken -- recorded per reading, never on
  -- the surface (#11007).
  read_at_sha   TEXT    NOT NULL,
  observed_at   BIGINT  NOT NULL,
  -- Preserved across re-reads, like treasury_readings.first_seen.
  first_seen    BIGINT  NOT NULL,
  -- Did the fetch yield a parseable compute_spec? FALSE is a measurement.
  found         BOOLEAN NOT NULL,
  -- The file's own `version:` key, when it has one. Reported beside the spec
  -- because a subnet that bumps it has revisited the file, and one that has
  -- never touched the template's default has not.
  spec_version  TEXT,
  -- The two stanzas, raw. NOT normalised, NOT unit-converted, NOT coerced --
  -- see the header. Null when `found` is false, and independently null when a
  -- file declares only one of the two roles.
  miner         JSONB,
  validator     JSONB,
  PRIMARY KEY (netuid, source_url),
  CONSTRAINT compute_declarations_observed_at_is_millis
    CHECK (observed_at >= 1000000000000),
  CONSTRAINT compute_declarations_first_seen_is_millis
    CHECK (first_seen >= 1000000000000),
  -- A finding needs something found. Enforced here as well as in the schema
  -- because the extractor writes directly, with no route in front of it to
  -- validate against Zod.
  CONSTRAINT compute_declarations_finding_needs_a_stanza
    CHECK (found = FALSE OR miner IS NOT NULL OR validator IS NOT NULL),
  -- ...and a non-finding may not carry one.
  CONSTRAINT compute_declarations_nothing_found_declares_nothing
    CHECK (found = TRUE OR (miner IS NULL AND validator IS NULL)),
  -- A stanza is an object. A YAML list or scalar reaching this column means the
  -- extractor read the wrong node, and every reader below would then be
  -- indexing into something that cannot answer.
  CONSTRAINT compute_declarations_stanzas_are_objects
    CHECK (
      (miner IS NULL OR jsonb_typeof(miner) = 'object')
      AND (validator IS NULL OR jsonb_typeof(validator) = 'object')
    )
);

-- The serving read is "every declaration for this subnet".
CREATE INDEX IF NOT EXISTS idx_compute_declarations_netuid
  ON compute_declarations (netuid);
