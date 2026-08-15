-- A compute_spec that declares requirements WITHOUT splitting them by role.
--
-- 0029 modelled a declaration as two optional stanzas, `miner` and `validator`,
-- because that is the shape of the template most subnets fill in. Two of the 18
-- registered surfaces do not use it. SN29 (coldint) and SN108 (talkhead)
-- publish a FLAT spec:
--
--     compute_spec:
--       cpu: {min_cores: 4, ...}
--       gpu: {required: true, min_vram: 24GB, ...}
--       memory: {min_ram: 32GB, ...}
--
-- That is a real declaration -- both of those ask for a GPU -- and it fits
-- neither column. The extractor read it correctly (`parsed !== null`, so
-- `found: true`) and then had nowhere to put it, so the row failed
-- `compute_declarations_finding_needs_a_stanza`, the write threw, the message
-- retried, and it dead-lettered on every pass since 2026-08-13. Neither subnet
-- has ever had a row.
--
-- ## WHY A COLUMN AND NOT A COERCION
--
-- The two available shortcuts are both lies. Writing the flat spec into `miner`
-- AND `validator` asserts a role split the document does not make. Writing
-- `found = false` says "we read it and it declared nothing" about a file that
-- declared a GPU requirement. 0029's own rule is the third option and the right
-- one: "a stanza we have no rule for yet is still preserved, so the fix later
-- is a code change rather than a re-read of a repo that has since moved."
--
-- `unscoped` is that stanza. The name states what is known -- requirements were
-- declared, and the document did not attribute them to a role -- rather than
-- guessing which role was meant. src/cost-to-participate.ts continues to serve
-- `declared_compute.miner` / `.validator` as null for these subnets, which is
-- TRUE of the document; deciding how an unscoped requirement should read on the
-- card is a judgement made on read, exactly where 0029 says judgements belong.
--
-- ## WHAT `found` MEANS, RESTATED
--
-- It means the URL was fetched and carried a parseable `compute_spec` -- what
-- the extractor has always computed. 0029's CHECK made it accidentally mean
-- "...and attributed it to a role", which is a narrower claim than either the
-- code or the header intended. The constraint is widened rather than the
-- meaning changed, so no existing row moves and no reader is re-pointed.
ALTER TABLE compute_declarations
  ADD COLUMN IF NOT EXISTS unscoped JSONB;

-- A finding still needs something found -- `unscoped` is now one of the things
-- that counts.
ALTER TABLE compute_declarations
  DROP CONSTRAINT IF EXISTS compute_declarations_finding_needs_a_stanza;
ALTER TABLE compute_declarations
  ADD CONSTRAINT compute_declarations_finding_needs_a_stanza
    CHECK (
      found = FALSE
      OR miner IS NOT NULL
      OR validator IS NOT NULL
      OR unscoped IS NOT NULL
    );

-- ...and a non-finding still may not carry one. Strictly widened the same way:
-- a `found = false` row declares nothing in ANY of the three columns.
ALTER TABLE compute_declarations
  DROP CONSTRAINT IF EXISTS compute_declarations_nothing_found_declares_nothing;
ALTER TABLE compute_declarations
  ADD CONSTRAINT compute_declarations_nothing_found_declares_nothing
    CHECK (
      found = TRUE
      OR (miner IS NULL AND validator IS NULL AND unscoped IS NULL)
    );

-- A stanza is an object, for the new column on the same reasoning 0029 gives:
-- a YAML list or scalar landing here means the extractor read the wrong node,
-- and every reader would then be indexing into something that cannot answer.
ALTER TABLE compute_declarations
  DROP CONSTRAINT IF EXISTS compute_declarations_stanzas_are_objects;
ALTER TABLE compute_declarations
  ADD CONSTRAINT compute_declarations_stanzas_are_objects
    CHECK (
      (miner IS NULL OR jsonb_typeof(miner) = 'object')
      AND (validator IS NULL OR jsonb_typeof(validator) = 'object')
      AND (unscoped IS NULL OR jsonb_typeof(unscoped) = 'object')
    );
