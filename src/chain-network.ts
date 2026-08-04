/**
 * Which chain a live storage read talks to, and where its cache entry lives.
 *
 * Every route in this repo that answers from chain state at request time does
 * the same three things: build a `twox128(pallet) ++ twox128(item)` storage
 * key, POST `state_getStorage` at a node, and cache the decoded answer in
 * `METAGRAPH_CONTROL`. Until #8700 all thirteen of those modules hardcoded the
 * finney URL and an un-namespaced KV key, which is what made them mainnet-only
 * "by construction" rather than by policy.
 *
 * They are mainnet-only by construction no longer. The storage keys are hashes
 * of pallet+item names, so they are chain-agnostic; testnet runs the same
 * runtime (spec 441, same 28 pallets, same storage defaults -- measured
 * 2026-08-04, see #8700); and the public testnet endpoints are full archive
 * nodes. The only thing that was ever mainnet-specific is the URL.
 *
 * This module is deliberately the ONLY place that knows either fact, so a
 * caller cannot half-switch a network -- reading testnet state into a mainnet
 * cache key is the one failure mode here that would be near-invisible, and
 * pairing the two functions in one module is what makes it impossible to do by
 * accident.
 */

/**
 * Networks that have chain state to read.
 *
 * `local` is deliberately absent: it is a per-developer chain metagraphed
 * cannot reach, and `handleNetworkScopedRequest` answers it with the setup
 * pointer long before any loader here is called.
 */
export type ChainNetworkId = "mainnet" | "testnet";

export const DEFAULT_CHAIN_NETWORK: ChainNetworkId = "mainnet";

/**
 * Public RPC per network.
 *
 * Both are Opentensor Foundation endpoints. We do not run nodes, so "is there
 * a public archive for testnet" was the blocking question for #8700; it is
 * answered -- `test.finney.opentensor.ai` serves state at block 1 unpruned,
 * with 186 RPC methods, the same as the finney entrypoint.
 *
 * One URL per network, no failover, matching what the finney path has always
 * done: a failed read is schema-stable (`null` field, 10s negative TTL), not an
 * exception, so a flaky endpoint degrades rather than breaks. The load-balanced
 * multi-endpoint pools are a separate concern -- they back the `/rpc/v1/{network}`
 * passthrough proxy, which is caller-driven traffic, not our own reads.
 */
export const CHAIN_RPC_URLS: Readonly<Record<ChainNetworkId, string>> = {
  mainnet: "https://entrypoint-finney.opentensor.ai:443",
  testnet: "https://test.finney.opentensor.ai:443",
};

/**
 * The RPC endpoint for a network, defaulting to mainnet.
 *
 * The default is what keeps every pre-#8700 call site byte-identical: a loader
 * invoked without a network argument still reads finney, so REST's bare paths,
 * GraphQL and the MCP tools are unchanged until they opt in.
 */
export function rpcUrlForNetwork(
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): string {
  return CHAIN_RPC_URLS[network] ?? CHAIN_RPC_URLS[DEFAULT_CHAIN_NETWORK];
}

/**
 * Namespace a KV cache key to its network.
 *
 * Mainnet returns the key UNCHANGED -- not `mainnet:`-prefixed. That asymmetry
 * is the point: every entry written before #8700 stays readable, and a mainnet
 * request after this change hits exactly the key it hit before, so the testnet
 * lane cannot shift mainnet's cache behaviour even transiently. Testnet gets
 * its own keyspace, so a testnet answer can never be served to a mainnet caller
 * (or the reverse) no matter what a handler does with the value afterwards.
 */
export function networkKvKey(
  baseKey: string,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): string {
  return network === DEFAULT_CHAIN_NETWORK ? baseKey : `${network}:${baseKey}`;
}

/**
 * Iceberg namespace holding a network's decoded chain tables.
 *
 * MUST match `Network::iceberg_namespace` in metagraphed-infra's
 * services/indexer-rs/src/network.rs — that is the writer, this is the reader,
 * and a disagreement is a silent empty result rather than an error: R2 SQL
 * answers `FROM chain_testnet.blocks` against a namespace that does not exist
 * with a failure the cold tier turns into a schema-stable empty, which looks
 * exactly like "this chain has no blocks yet".
 *
 * Mainnet stays `chain`, unprefixed, because every table already written and
 * every existing reader spells it that way.
 */
export const LAKEHOUSE_NAMESPACES: Readonly<Record<ChainNetworkId, string>> = {
  mainnet: "chain",
  testnet: "chain_testnet",
};

/**
 * A fully-qualified lakehouse table for one network, e.g. `chain.blocks` or
 * `chain_testnet.extrinsics`.
 *
 * Every `FROM` clause in the cold tier goes through this rather than embedding
 * the namespace, so a reader cannot be network-aware in its WHERE clause and
 * mainnet-only in its FROM — which would read the wrong chain while looking
 * completely correct.
 */
export function chainTable(
  table: string,
  network: ChainNetworkId = DEFAULT_CHAIN_NETWORK,
): string {
  return `${LAKEHOUSE_NAMESPACES[network] ?? LAKEHOUSE_NAMESPACES[DEFAULT_CHAIN_NETWORK]}.${table}`;
}

/**
 * Narrow a router network id to one that has chain state.
 *
 * `handleNetworkScopedRequest` carries `{ id: "mainnet" | "testnet" | "local" }`.
 * Live-RPC routes are never dispatched for `local`, but the router's type does
 * not know that, so this is the single explicit narrowing point rather than a
 * cast at each of eleven call sites.
 */
export function chainNetworkId(id: string | undefined): ChainNetworkId {
  return id === "testnet" ? "testnet" : DEFAULT_CHAIN_NETWORK;
}

/**
 * Map the MCP/GraphQL `network` vocabulary onto this module's.
 *
 * Those two surfaces publish the CHAIN names (`finney` / `test`, from
 * `McpNetworkSchema`) while REST's path prefix and this module use the NETWORK
 * names (`mainnet` / `testnet`). Both spellings are already public API, so
 * neither can be renamed; this is the one place that reconciles them.
 *
 * Anything unrecognised — including `undefined` and `null` — resolves to
 * mainnet. That is safe here ONLY because both callers validate against their
 * published enum first (`optionalEnum` on the MCP side): this function is the
 * translation, never the gate. Silently defaulting an unvalidated string would
 * reintroduce #8804, where an unrecognised value took the testnet branch.
 */
export function chainNetworkFromChainName(
  chain: string | null | undefined,
): ChainNetworkId {
  return chain === "test" || chain === "testnet"
    ? "testnet"
    : DEFAULT_CHAIN_NETWORK;
}
