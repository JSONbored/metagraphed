-- Proxies + multisigs (#13166, runtime v490; #13161, epic #13142).
--
-- The Proxy and Multisig pallets are served by Taostats and read nowhere in
-- this repo. Proxy.Proxies maps a delegating account to
-- (Vec<ProxyDefinition{ delegate, proxyType, delay }>, deposit); the
-- proxyType enum has 23 variants on v490 (Any .. GammaSpend) and keeps
-- growing, so proxy_type is text spelled as the chain spells it, never a
-- pinned enum. Multisig.Multisigs keys OPEN OPERATIONS by (multisig account,
-- call hash); the composition of a multisig account -- its signatories and
-- threshold -- is derivable only from the as_multi call decode, which is what
-- the engine writes here. All names and shapes verified against live Finney
-- v490 metadata (read-only state_getMetadata, 2026-11-14). The writers --
-- the engine's Proxy.Proxies state decode and the Multisig call/event decode
-- -- land with the engine.
--
-- One row per (delegator, delegate, proxy_type, delay) proxy definition;
-- deposit is the delegator-level reserve (the tuple's u64), repeated on each
-- of the delegator's rows because the chain stores it once per vector.
CREATE TABLE app.proxies (
    delegator text COLLATE "C" NOT NULL CHECK (delegator <> ''),
    delegate text COLLATE "C" NOT NULL CHECK (delegate <> ''),
    proxy_type text COLLATE "C" NOT NULL CHECK (proxy_type <> ''),
    delay bigint NOT NULL CHECK (delay >= 0),
    deposit text COLLATE "C" CHECK (
        deposit IS NULL OR ((deposit = '0' OR deposit ~ '^[1-9][0-9]*$')
            AND (length(deposit), deposit) <= (20, '18446744073709551615'))
    ),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (delegator, delegate, proxy_type, delay)
);

-- One row per multisig account the engine has resolved: its signatory set
-- (a JSONB array of ss58 strings, NULL when the capture has not resolved the
-- composition) and approval threshold.
CREATE TABLE app.multisigs (
    multisig text COLLATE "C" PRIMARY KEY CHECK (multisig <> ''),
    threshold bigint CHECK (threshold IS NULL OR threshold >= 1),
    signatories jsonb CHECK (
        signatories IS NULL OR jsonb_typeof(signatories) = 'array'
    ),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000)
);

-- The route reads by membership: the multisig account itself, or any
-- signatory inside the JSONB array.
CREATE INDEX idx_multisigs_signatories
    ON app.multisigs USING gin (signatories jsonb_path_ops);
