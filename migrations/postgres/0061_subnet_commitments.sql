-- Every hotkey's commitment on every subnet (Commitments.CommitmentOf and
-- Commitments.RevealedCommitments, runtime spec 497; MET-7365, ADR 0029
-- phase 2): what each subnet's miners and validators publish on chain --
-- model revisions, peer ids, endpoints, content hashes, timelocked payloads
-- -- and the reveals the chain made of them. On finney at block 9,604,440
-- that was 29,461 commitments (3.0 MB of SCALE) and 17,695 reveal lists
-- (6.2 MB).
--
-- Validity ranges like the rest of the state schema (0060): a row holds what
-- a capture observed for one (netuid, hotkey) from `valid_from` on, and
-- closes at the first capture that observed something else, or nothing, for
-- it. The capture is hourly, so a change happened somewhere in (the previous
-- observation, valid_from], about 300 blocks; `committed_block` is the
-- block the chain itself stamped the commitment with.

-- One row per (netuid, hotkey) and change. `hotkey` is the 32-byte public
-- key (ADR 0029 §2: keys are bytes, rendered as SS58 by the reader). The
-- commitment's own columns are NULL when the hotkey holds reveals but no
-- current commitment; `reveals` is empty when it holds a commitment but no
-- reveals.
--
-- `fields` is the decoded CommitmentInfo, one element per Data field:
-- {"kind": "raw" | "big_raw" | "sha256" | "blake2_256" | "keccak256" |
-- "sha3_256" | "timelock" | "timelock_failed" | "reset_bonds" | "none",
-- "hex": the bytes, "text": the bytes as UTF-8 where they are printable,
-- "reveal_round": a timelock's drand round}. `reveals` is
-- [{"block": <reveal block>, "hex": ..., "text": ...}] in the chain's order.
--
-- `digest` is SHA-256 over the chain's own SCALE bytes for the pair (see
-- src/commitments-capture.ts `commitmentDigest`), so a capture tells a
-- change by the chain's bytes rather than by this decoding of them, and
-- reads 32 bytes a row back instead of the decoded values.
CREATE TABLE state.commitments (
    netuid integer NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    hotkey bytea NOT NULL CHECK (octet_length(hotkey) = 32),
    valid_from bigint NOT NULL CHECK (valid_from >= 0),
    valid_to bigint CHECK (valid_to IS NULL OR valid_to > valid_from),
    -- Registration.block: the block the commitment was set at.
    committed_block bigint CHECK (committed_block IS NULL OR committed_block >= 0),
    -- Registration.deposit, in rao: a u64, which a bigint cannot hold whole.
    deposit numeric(20, 0)
        CHECK (deposit IS NULL OR deposit BETWEEN 0 AND 18446744073709551615),
    fields jsonb CHECK (fields IS NULL OR jsonb_typeof(fields) = 'array'),
    reveals jsonb NOT NULL CHECK (jsonb_typeof(reveals) = 'array'),
    digest bytea NOT NULL CHECK (octet_length(digest) = 32),
    -- A commitment is whole or absent: its block, deposit and fields together.
    CHECK ((committed_block IS NULL) = (fields IS NULL) AND (deposit IS NULL) = (fields IS NULL)),
    -- A row records something the chain holds.
    CHECK (fields IS NOT NULL OR jsonb_array_length(reveals) > 0),
    PRIMARY KEY (netuid, hotkey, valid_from)
);
CREATE UNIQUE INDEX commitments_current
    ON state.commitments (netuid, hotkey) WHERE valid_to IS NULL;

-- The commitments family's watermark lives beside the emission families'.
ALTER TABLE state.observations DROP CONSTRAINT observations_family_check;
ALTER TABLE state.observations ADD CONSTRAINT observations_family_check CHECK (
    family IN ('subnet_emission_splits', 'subnet_lifecycle_states', 'commitments')
);
