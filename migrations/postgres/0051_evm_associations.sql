-- EVM key associations (#13165, runtime v490; #13161, epic #13142).
--
-- /evm/address/{h160} answers today with a live AddressMapping-precompile
-- eth_call: a pure function of the H160, correct but storage-blind. The
-- chain ALSO stores explicit associations --
-- SubtensorModule.AssociatedEvmAddress ((netuid, uid) -> (H160, block)),
-- SubtensorModule.AssociatedUidsByEvmAddress, event EvmKeyAssociated -- and
-- none of it is read anywhere. This migration gives that state its keyed
-- history table. The writers -- the engine's AssociatedEvmAddress decode and
-- the EvmKeyAssociated event decode -- land with the engine; until they do,
-- the table is empty and the route keeps its precompile answer while the
-- association block declines schema-stably (NULL count, never a fabricated
-- zero).
--
-- A history: one row per (netuid, uid, captured_at), because an EVM key can
-- be re-associated and the previous binding is exactly what an auditor asks
-- for. The newest row per (netuid, uid) is the current state. h160 is the
-- chain's H160 as 0x-prefixed lowercase hex; ss58 is the owning hotkey the
-- engine resolves for the (netuid, uid) at capture time, NULL when the
-- capture did not carry it. associated_at is the chain's association block
-- (the u64 beside the H160 in storage), NULL when not carried -- never
-- fabricated as 0, which would claim an association at genesis.
-- captured_at is epoch-ms, same floor as the neuron document stamps.
-- Mainnet-only, like every table without a network column.
CREATE TABLE app.evm_associations (
    h160 text COLLATE "C" NOT NULL CHECK (h160 ~ '^0x[0-9a-f]{40}$'),
    ss58 text COLLATE "C" CHECK (ss58 IS NULL OR ss58 <> ''),
    netuid bigint NOT NULL CHECK (netuid BETWEEN 0 AND 65535),
    uid bigint NOT NULL CHECK (uid BETWEEN 0 AND 65535),
    associated_at bigint CHECK (associated_at IS NULL OR associated_at >= 0),
    captured_at bigint NOT NULL CHECK (captured_at >= 1000000000000),
    PRIMARY KEY (netuid, uid, captured_at)
);

-- The route reads by H160, newest capture first.
CREATE INDEX idx_evm_associations_h160
    ON app.evm_associations (h160, captured_at DESC);
