// Read-only RPC safety policy for the WSS load balancer — a SELF-CONTAINED copy
// of the policy in workers/config.mjs (the CF HTTP proxy uses the same allowlist).
//
// Why a copy and not an import: the wss-lb deploys as a standalone Railway service
// whose container only contains `deploy/wss-lb` (the Dockerfile COPYs `src` only).
// Importing `../../../workers/config.mjs` resolves in the repo but NOT in the
// image — it crashed every deploy with ERR_MODULE_NOT_FOUND before the server
// could listen, so the healthcheck failed.
//
// KEEP IN SYNC with workers/config.mjs — tests/wss-lb-rpc-policy-sync.test.mjs
// fails CI if these drift.
export const SAFE_RPC_METHODS = new Set([
  "chain_getBlock",
  "chain_getBlockHash",
  "chain_getFinalizedHead",
  "chain_getHeader",
  "rpc_methods",
  "state_getRuntimeVersion",
  "system_chain",
  "system_health",
  "system_name",
  "system_properties",
  "system_version",
]);
// Read-only WebSocket subscriptions — WSS-ONLY (no HTTP equivalent). KEEP IN SYNC
// with workers/config.mjs (tests/wss-lb-rpc-policy-sync.test.mjs guards drift).
// Deliberately excludes persistent storage subscriptions, which can create
// unbounded upstream watcher state for arbitrary keys.
export const SAFE_RPC_SUBSCRIPTIONS = new Set([
  "chain_subscribeNewHeads",
  "chain_subscribeNewHead",
  "chain_unsubscribeNewHeads",
  "chain_subscribeFinalizedHeads",
  "chain_subscribeFinalisedHeads",
  "chain_unsubscribeFinalizedHeads",
  "chain_unsubscribeFinalisedHeads",
  "chain_subscribeAllHeads",
  "chain_unsubscribeAllHeads",
  "state_subscribeRuntimeVersion",
  "state_unsubscribeRuntimeVersion",
]);
export const DENIED_RPC_PREFIXES = [
  "author_",
  "state_call",
  "sudo_",
  "payment_",
  "contracts_",
];
export const MAX_RPC_BODY_BYTES = 65536;
