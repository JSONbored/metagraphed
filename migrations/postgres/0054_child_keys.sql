-- Child-key detail (#13166, runtime v490; #13161, epic #13142).
--
-- The /accounts/{ss58}/children and /parents routes read the live
-- SubtensorModule.ChildKeys / ParentKeys maps over RPC and nothing else: the
-- per-hotkey take (ChildkeyTake, DMAP (hot, netuid) -> PerU16), the pending
-- relation queue (PendingChildKeys, DMAP (netuid, parent) ->
-- (Vec<(proportion, child)>, cool_down_block)), the threshold bookkeeping
-- (ChildkeyThresholdChecks / ChildkeyThresholdSuspended, MAP parent -> ())
-- and any history are unserved. All item names and shapes verified against
-- live Finney v490 metadata (read-only state_getMetadata, 2026-11-14). This
-- migration gives that state its keyed places to land; the writers -- the
-- engine's child-key decode -- land with the engine.
--
-- The take a child hotkey charges on a subnet, in PerU16 parts of 65535.
CREATE TABLE app.childkey_takes (
    hotkey text COLLATE "C" NOT NULL CHECK (hotkey <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    take bigint NOT NULL CHECK (take BETWEEN 0 AND 65535),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (hotkey, netuid)
);

-- One row per pending (netuid, parent, child) relation; cool_down_block is
-- the tuple's u64, repeated on each child row of the same (netuid, parent)
-- because the chain stores it once per pending vector.
CREATE TABLE app.pending_child_keys (
    parent text COLLATE "C" NOT NULL CHECK (parent <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    child text COLLATE "C" NOT NULL CHECK (child <> ''),
    proportion text COLLATE "C" NOT NULL CHECK (
        (proportion = '0' OR proportion ~ '^[1-9][0-9]*$')
            AND (length(proportion), proportion) <= (20, '18446744073709551615')
    ),
    cool_down_block bigint CHECK (cool_down_block IS NULL OR cool_down_block >= 0),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (parent, netuid, child)
);

-- The parent-keyed threshold bookkeeping: pending_check mirrors membership in
-- ChildkeyThresholdChecks (stake changed, re-check queued), suspended mirrors
-- ChildkeyThresholdSuspended (below StakeThreshold; relations stored but
-- inert). NULL means the capture did not carry that map's answer -- never a
-- fabricated false.
CREATE TABLE app.childkey_thresholds (
    parent text COLLATE "C" PRIMARY KEY CHECK (parent <> ''),
    pending_check boolean,
    suspended boolean,
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000)
);

-- The ChildKeys capture history, so the live-RPC-only reads gain history: one
-- row per (parent, netuid, child, captured_at) relation observation.
CREATE TABLE app.child_keys_history (
    parent text COLLATE "C" NOT NULL CHECK (parent <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    child text COLLATE "C" NOT NULL CHECK (child <> ''),
    proportion text COLLATE "C" NOT NULL CHECK (
        (proportion = '0' OR proportion ~ '^[1-9][0-9]*$')
            AND (length(proportion), proportion) <= (20, '18446744073709551615')
    ),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (parent, netuid, child, captured_at)
);

-- The /parents view reads the same history by child.
CREATE INDEX idx_child_keys_history_child
    ON app.child_keys_history (child, captured_at DESC);
