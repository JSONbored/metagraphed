-- #10845: give nominator_positions a prune DOMAIN, so two producers can share
-- it without one deleting the other's rows (metagraphed-infra#473).
--
-- THE TABLE IS ABOUT TO HAVE A SECOND WRITER. `validator-nominators` scans
-- SubtensorModule::Alpha; `self-stake` exists precisely for the pairs that scan
-- MISSES -- an owner's own stake on their own hotkey frequently has no Alpha
-- entry at all (`{bits: 0}` on ~91% of one hotkey's registered pairs, measured
-- by the Python script the lane replaced), even when the runtime-computed stake
-- is large. A validator's own stake is often its largest position, so the eight
-- surfaces that read this table are wrong without it.
--
-- WHY CO-TENANCY IS UNSAFE WITHOUT THIS COLUMN. The lane prunes PER COLDKEY:
-- every row for a posted `coldkey` older than that `coldkey`'s newest captured_at
-- in the request is deleted. That contract works for `validator-nominators`
-- because `pack_coldkey_chunks` never splits a `coldkey` across requests. It
-- cannot work for `self-stake`, whose rows are absent from the Alpha scan BY
-- CONSTRUCTION: any owner who also nominates elsewhere appears in a
-- validator-nominators pass, and that pass's prune then deletes their
-- self-stake row. Written weekly, deleted within a day -- and partial,
-- unpredictable survival is worse than either extreme.
--
-- A SEPARATE TABLE WAS THE OTHER OPTION AND IS WORSE. subnet-holders,
-- top-holders-holdings, validator-nominator-positions, both serving tiers, the
-- staleness watchdogs and hotkey-alpha-completeness all read
-- `nominator_positions`. Splitting the rows means a UNION in every one of them,
-- and the first reader anybody forgot would under-report silently.
--
-- So each producer prunes only what it wrote:
--
--   validator-nominators   writes source='alpha'        prunes ... AND source='alpha'
--   self-stake             writes source='self-stake'   prunes ... AND source='self-stake'
--
-- DEFAULT 'alpha' IS WHAT MAKES THIS A NO-OP TODAY. All 123,057 existing rows
-- become 'alpha', which is what wrote them, so the scoped prune deletes exactly
-- what the unscoped one did. The new clause is strictly NARROWER -- it cannot
-- delete anything the current prune keeps -- which is the direction a change to
-- a delete should always run.
--
-- NOT NULL with a constant default does not rewrite the table on PG11+, so this
-- is a catalog update on a 123k-row table rather than a copy.
ALTER TABLE nominator_positions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'alpha';

-- The prune's own predicate: (coldkey, source) with captured_at, so the delete
-- reads one index rather than filtering a coldkey's whole row set. The existing
-- primary key (coldkey, hotkey, netuid) does not serve this -- it has no
-- captured_at and no source.
CREATE INDEX IF NOT EXISTS nominator_positions_coldkey_source_captured_idx
  ON nominator_positions (coldkey, source, captured_at);
