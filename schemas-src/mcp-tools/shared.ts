// Shared building blocks for schemas-src/mcp-tools/*.ts (types-epic E,
// #7863). Every hand-written MCP output schema this epic has converted so
// far leaves nested objects/arrays shallow (bare `{type:"object"}` /
// `{type:"array", items:{type:"object"}}`, no per-field constraints) even on
// tools whose description says they "mirror" a REST route -- reusing a
// deeper schemas-src/routes/ schema for those fields would silently accept
// LESS than the original wire contract did, a regression per #7863's "hard
// wire-compatibility constraint" (see e.g. get-network-health.ts's header
// for the fuller rationale, first established in the pilot batch). These
// two helpers are the Zod equivalent of that same shallow-on-purpose shape.
import { z } from "zod";

// Bare `{type:"object"}` (hand-written, no `properties`/`additionalProperties`
// declared -- JSON Schema's own default for an omitted additionalProperties
// is `true`, i.e. "any object, any keys").
export const OpenObjectSchema = z.object({}).passthrough();

// Bare `{type:"array"}` or `{type:"array", items:{type:"object"}}` (no
// items-shape constraint beyond "each item is some object", or none at all).
export const OpenArraySchema = z.array(z.unknown());
export const OpenObjectArraySchema = z.array(OpenObjectSchema);
