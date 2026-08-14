// The A2A paths, in a leaf module so the router can match them without
// loading the handler -- workers/api.ts defers the a2a.ts import for the same
// reason discovery.ts defers src/mcp-server.ts (#10424): the handler pulls in
// the AI stack, and the router must stay cheap for the requests that never
// touch it.

/** The JSON-RPC endpoint the agent card advertises. Version-segmented like
 * /api/v1, so a breaking A2A revision is a new path, not a new meaning. */
export const A2A_ENDPOINT_PATH = "/a2a/v1";
/** A2A 0.3's well-known card location. */
export const A2A_CARD_PATH = "/.well-known/agent-card.json";
