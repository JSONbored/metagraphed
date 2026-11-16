-- Coldkey-swap v2 announcement plane + key successor lineage (#13166,
-- runtime v490; #13161, epic #13142).
--
-- The v2 coldkey-swap machinery is announce-then-execute: an announcement
-- names the block the swap may run (SubtensorModule.ColdkeySwapAnnouncements,
-- coldkey -> (execute_block, H256 commitment)), reserves its destination in
-- cleartext (ColdkeySwapDestinationReservations / the reverse index
-- ColdkeySwapReservedDestination), can be disputed
-- (ColdkeySwapDisputes, coldkey -> dispute block; 0 means root cleared the
-- dispute but retained the record) and snapshots one announcement-time policy
-- decision (ColdkeySwapV2PolicySnapshots, coldkey -> bool). All five item
-- names and value shapes verified against live Finney v490 metadata
-- (read-only state_getMetadata, 2026-11-14). None of it is read anywhere in
-- this repo today -- events only -- while Taostats serves
-- accounts/pending-coldkey-swaps.
--
-- One row per announcing coldkey: the chain map holds at most one in-flight
-- announcement per coldkey, and the engine rewrites the row as the
-- announcement moves (reannounced, disputed, cleared, executed). Every
-- non-key column is nullable because a capture truthfully carries only what
-- the chain stores at that block: a NULL is "not carried", never a
-- fabricated zero/false.
CREATE TABLE app.coldkey_swap_announcements (
    coldkey text COLLATE "C" PRIMARY KEY CHECK (coldkey <> ''),
    -- ColdkeySwapReservedDestination(coldkey): the reserved destination in
    -- cleartext, NULL when the capture carried no reservation.
    new_coldkey text COLLATE "C" CHECK (new_coldkey IS NULL OR new_coldkey <> ''),
    -- The H256 beside the execute block, 0x-prefixed lowercase hex.
    announcement_hash text COLLATE "C" CHECK (
        announcement_hash IS NULL OR announcement_hash ~ '^0x[0-9a-f]{64}$'
    ),
    -- The block the announcement landed (engine-derived from the
    -- ColdkeySwapAnnounced event), NULL when not carried.
    announced_at bigint CHECK (announced_at IS NULL OR announced_at >= 0),
    -- ColdkeySwapAnnouncements' u32: the block the swap can be performed.
    execute_at bigint CHECK (execute_at IS NULL OR execute_at >= 0),
    -- ColdkeySwapDisputes: NULL = no dispute record; FALSE = root cleared the
    -- dispute but retained the record (the chain's 0); TRUE = disputed.
    disputed boolean,
    -- The dispute block itself when one is recorded (> 0 on the chain).
    disputed_at bigint CHECK (disputed_at IS NULL OR disputed_at >= 0),
    -- ColdkeySwapV2PolicySnapshots: the announcement-time decision on
    -- importing the source auto-stake policy.
    policy_snapshot boolean,
    -- The engine spells the lifecycle state as it reads it (announced /
    -- disputed / executable ...) -- text, not an enum the runtime still
    -- extends.
    status text COLLATE "C" CHECK (status IS NULL OR status <> ''),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000)
);

-- The route lists pending swaps soonest-executable first.
CREATE INDEX idx_coldkey_swap_announcements_execute
    ON app.coldkey_swap_announcements (execute_at, coldkey);

-- The two chain-wide delays beside the announcements: a capture series, one
-- row per capture, newest row wins (same discipline as app.chain_gamma).
-- ColdkeySwapAnnouncementDelay / ColdkeySwapReannouncementDelay are u32 block
-- counts.
CREATE TABLE app.coldkey_swap_policy (
    captured_at bigint PRIMARY KEY CHECK (captured_at >= 1000000000000),
    announcement_delay bigint CHECK (
        announcement_delay IS NULL OR announcement_delay >= 0
    ),
    reannouncement_delay bigint CHECK (
        reannouncement_delay IS NULL OR reannouncement_delay >= 0
    )
);

-- Key successor lineage: written on each successful swap so watchers can
-- follow identity without walking history. HotkeySuccessor / HotkeyRoot are
-- per-subnet ((netuid, hotkey) -> successor / first-in-lineage root);
-- ColdkeySuccessor / ColdkeyRoot are global (coldkey -> successor / root).
-- Item names and key shapes verified against live Finney v490 metadata.
-- kind spells which key plane the row describes; netuid is NULL exactly for
-- the global coldkey-swap lineage (UNIQUE NULLS NOT DISTINCT keys it beside the
-- per-subnet hotkey rows). successor NULL = the key is the newest in its
-- lineage; root NULL = the key is its own root (never swapped into). A row
-- carrying neither names no lineage the chain stores, so at least one is
-- required.
CREATE TABLE app.key_successors (
    key text COLLATE "C" NOT NULL CHECK (key <> ''),
    kind text COLLATE "C" NOT NULL CHECK (kind IN ('coldkey', 'hotkey')),
    netuid bigint CHECK (netuid IS NULL OR netuid BETWEEN 0 AND 65535),
    successor text COLLATE "C" CHECK (successor IS NULL OR successor <> ''),
    root text COLLATE "C" CHECK (root IS NULL OR root <> ''),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    CONSTRAINT key_successors_identity UNIQUE NULLS NOT DISTINCT (kind, key, netuid),
    CONSTRAINT key_successors_plane CHECK ((kind = 'coldkey') = (netuid IS NULL)),
    CONSTRAINT key_successors_lineage CHECK (successor IS NOT NULL OR root IS NOT NULL)
);
