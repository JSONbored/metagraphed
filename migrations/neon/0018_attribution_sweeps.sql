-- #10489-#10509: the attribution sweep's store.
--
-- WHY THIS IS A TABLE AND NOT A REGISTRY FILE. The attribution itself -- this
-- address belongs to that team, here is the evidence -- is a curated human
-- claim and lives in registry/entities/<ss58>.json, reviewed like every other
-- registry contribution. This table is the other half: the OBSERVATION that we
-- looked at a subnet's published surfaces on a date and found nothing (or found
-- candidates). That is machine-produced and timestamped, exactly like
-- surface_checks or revenue_probe_failures, and committing one file per sweep
-- run would put a git commit in front of every measurement.
--
-- THE NEGATIVE IS THE POINT. Most subnets publish no address, and the issues
-- driving this say so: "no declared treasury as of <date>" is evidence, an
-- undated silence is not. A wallets response that says nothing about whether
-- anyone looked is indistinguishable from one where nobody has -- the same
-- confusion #10566 let sit for two months.
CREATE TABLE IF NOT EXISTS attribution_sweeps (
  netuid          INTEGER NOT NULL,
  -- One row per subnet, overwritten each pass: the question is "what is the
  -- current state of our search", not "how many times have we searched".
  -- History of the finding lives in the candidates, which carry their own
  -- first_seen.
  swept_at        BIGINT  NOT NULL,
  -- How many public URLs from this subnet's own registry record were fetched.
  -- Zero is a real and important value: a subnet that publishes no surface at
  -- all has not been searched, and must not read as "searched, found nothing".
  sources_checked INTEGER NOT NULL,
  -- How many of those actually answered. sources_checked minus this is the
  -- reach we did not have, and a sweep that reached nothing is `unreachable`.
  sources_read    INTEGER NOT NULL,
  -- Checksum-valid ss58 strings found in the fetched bytes. A CANDIDATE, never
  -- an attribution: appearing on a team's page does not make an address theirs
  -- (a validator hotkey in an API response is the common false positive), and
  -- the evidence bar in docs/nametag-evidence-bar.md is cleared by a human.
  candidates      INTEGER NOT NULL,
  verdict         TEXT    NOT NULL,
  PRIMARY KEY (netuid),
  CONSTRAINT attribution_sweeps_swept_at_is_millis
    CHECK (swept_at >= 1000000000000),
  CONSTRAINT attribution_sweeps_counts_are_sane
    CHECK (
      sources_checked >= 0
      AND sources_read >= 0
      AND sources_read <= sources_checked
      AND candidates >= 0
    ),
  -- `none-published` is the expected majority answer and is NOT a failure.
  -- `unreachable` is separate on purpose: it means we could not look, which is
  -- a statement about us, and collapsing it into `none-published` would turn
  -- our own outage into a finding about a subnet.
  CONSTRAINT attribution_sweeps_verdict_is_known
    CHECK (verdict IN ('none-published', 'candidates-found', 'unreachable', 'no-sources'))
);

-- One row per candidate, kept across passes so a candidate that later
-- disappears from a page still has a dated record -- the same retention
-- argument revenue_observations' response_hash makes.
CREATE TABLE IF NOT EXISTS attribution_candidates (
  netuid       INTEGER NOT NULL,
  ss58         TEXT    NOT NULL,
  -- The URL the string was found in, so a reviewer can check the claim against
  -- its source without re-running the sweep.
  source_url   TEXT    NOT NULL,
  first_seen   BIGINT  NOT NULL,
  last_seen    BIGINT  NOT NULL,
  PRIMARY KEY (netuid, ss58, source_url),
  CONSTRAINT attribution_candidates_first_seen_is_millis
    CHECK (first_seen >= 1000000000000),
  CONSTRAINT attribution_candidates_last_seen_is_millis
    CHECK (last_seen >= 1000000000000)
);

CREATE INDEX IF NOT EXISTS attribution_candidates_by_netuid
  ON attribution_candidates (netuid, last_seen DESC);
