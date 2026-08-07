// MCP tools `get_networks`, `get_runtime`.
// Mirror GET /api/v1/networks, GET /api/v1/runtime.
//
// DERIVED FROM THE ROUTE, NOT COPIED (#9796). Each output schema below IS the
// route's own ArtifactSchema, so a route field rename is a compile error here
// instead of silent production drift -- which is what the hand-written copies
// this replaces had already accumulated.
//
// Verified against production before the switch, because deriving is a
// TIGHTENING -- the route schema is stricter than the copy was. Every tool in
// this file was called live and its response validated against the schema it
// now publishes.
import { z } from "zod";
import { NetworkCapabilitiesArtifactSchema } from "../routes/network-capabilities.ts";
import { RuntimeVersionsArtifactSchema } from "../routes/runtime-versions.ts";

export const GetRuntimeInputSchema = z.object({}).strict();
export type GetRuntimeInput = z.infer<typeof GetRuntimeInputSchema>;

// objectItems(...) properties, none required at the item level (see
// search-subnets.ts's same note from the pilot batch) -- but unlike most
// other item shapes in this epic, spec_version/block_number are plain
// (non-nullable) integers when present: the hand-written original wraps
// them in bare `{type:"integer"}`, not NULLABLE_INT.
// #8702 upgrade radar. Every field is independently nullable because each
// comes from its own upstream: a testnet RPC outage blanks the testnet reading
// and nothing else. `pending_upgrade` carries "unknown" as a real value rather
// than degrading to "none" -- "no upgrade pending" and "we could not tell" are
// opposite answers, and a consumer must be able to tell them apart.
//
// There is deliberately no ETA/expected-date field anywhere in this shape: the
// foundation publishes no deploy schedule, so any predicted date would be a
// guess presented as data. See src/upgrade-radar.ts.
export const GetRuntimeOutputSchema = RuntimeVersionsArtifactSchema;
export type GetRuntimeOutput = z.infer<typeof GetRuntimeOutputSchema>;

// #8699: the per-network capability matrix, for agents planning cross-network
// work. Mirrors the REST payload exactly.
export const GetNetworksInputSchema = z.object({}).strict();
export type GetNetworksInput = z.infer<typeof GetNetworksInputSchema>;

export const GetNetworksOutputSchema = NetworkCapabilitiesArtifactSchema;
export type GetNetworksOutput = z.infer<typeof GetNetworksOutputSchema>;
