-- The LimitOrders pallet (#13165, runtime v490; #13161, epic #13142).
--
-- LimitOrders is call-decoded only today (src/indexer-rs-ethereum-decode.ts
-- handles LimitOrders.execute_batched_orders) -- no state is stored and no
-- surface serves it, and its nine event kinds land raw-only in
-- chain_detail_chain_events. This migration gives the v490 LimitOrders state
-- (Orders, ApprovedOrders, LinkedOutputs) and the structured event ingest
-- their keyed places to land. The writers -- the engine's LimitOrders
-- order-book decode and the structured LimitOrders event decode -- land with
-- the engine; until they do, both tables below are empty and the serving
-- tier declines schema-stably (NULL counts, never fabricated zeros).
--
-- Quantities are u64 atomic units as canonical decimal text (same discipline
-- as app.swap_balancer); captured_at/occurred_at are epoch-ms, same floor as
-- the neuron document stamps. Mainnet-only, like every table without a
-- network column.

-- One row per order_id: the order book the engine fills from
-- LimitOrders.Orders / LimitOrders.ApprovedOrders. order_id is the chain's
-- H256 order key as 0x-prefixed lowercase hex. kind spells the chain's
-- OrderType variant as the chain spells it rather than pinning an enum the
-- runtime still extends; status spells the Orders enum state the same way
-- (Fulfilled / PartiallyFilled / Cancelled today), NULL while the capture
-- did not carry one -- never a fabricated "open". price is the chain's raw
-- price encoding crossed verbatim as canonical decimal text (u128-bounded)
-- -- the engine's decode owns the scaling, and re-deriving it here would
-- invent precision.
CREATE TABLE app.limit_orders (
    order_id text COLLATE "C" NOT NULL CHECK (order_id ~ '^0x[0-9a-f]{64}$'),
    owner text COLLATE "C" NOT NULL CHECK (owner <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    kind text COLLATE "C" NOT NULL CHECK (kind <> ''),
    amount text COLLATE "C" CHECK (
        amount IS NULL OR ((amount = '0' OR amount ~ '^[1-9][0-9]*$')
            AND (length(amount), amount) <= (20, '18446744073709551615'))
    ),
    price text COLLATE "C" CHECK (
        price IS NULL OR ((price = '0' OR price ~ '^[1-9][0-9]*$')
            AND (length(price), price) <= (39, '340282366920938463463374607431768211455'))
    ),
    status text COLLATE "C" CHECK (status IS NULL OR status <> ''),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (order_id)
);

-- The per-subnet card reads newest-first; the primary key already serves the
-- per-order lookup.
CREATE INDEX idx_limit_orders_netuid
    ON app.limit_orders (netuid, captured_at DESC);

-- One row per (block_number, event_index): the structured ingest of the nine
-- LimitOrders event kinds (OrderExecuted / OrderSkipped / OrderCancelled /
-- OrderApproved / GroupExecutionSummary / LimitOrdersPalletStatusChanged /
-- LinkedOutputRecorded / LinkedOutputConsumed / LinkedOutputPruned) that
-- land raw-only in chain_detail_chain_events today. kind spells the event as
-- the chain spells it (same reasoning as app.gamma_events.kind). The
-- identity and amount columns are nullable because the kinds carry different
-- shapes: a NULL is "this event does not carry that field", never an erased
-- value.
CREATE TABLE app.limit_order_events (
    block_number bigint NOT NULL CHECK (block_number >= 0),
    event_index integer NOT NULL CHECK (event_index >= 0),
    kind text COLLATE "C" NOT NULL CHECK (kind <> ''),
    order_id text COLLATE "C" CHECK (order_id IS NULL OR order_id ~ '^0x[0-9a-f]{64}$'),
    signer text COLLATE "C" CHECK (signer IS NULL OR signer <> ''),
    netuid bigint CHECK (netuid IS NULL OR netuid BETWEEN 0 AND 65535),
    amount_in text COLLATE "C" CHECK (
        amount_in IS NULL OR ((amount_in = '0' OR amount_in ~ '^[1-9][0-9]*$')
            AND (length(amount_in), amount_in) <= (20, '18446744073709551615'))
    ),
    amount_out text COLLATE "C" CHECK (
        amount_out IS NULL OR ((amount_out = '0' OR amount_out ~ '^[1-9][0-9]*$')
            AND (length(amount_out), amount_out) <= (20, '18446744073709551615'))
    ),
    occurred_at bigint NOT NULL CHECK (occurred_at >= 1000000000000),
    PRIMARY KEY (block_number, event_index)
);

-- Event-kind timelines scan by kind, newest block first; per-order timelines
-- scan by order_id.
CREATE INDEX idx_limit_order_events_kind
    ON app.limit_order_events (kind, block_number DESC);
CREATE INDEX idx_limit_order_events_order
    ON app.limit_order_events (order_id, block_number DESC)
    WHERE order_id IS NOT NULL;
