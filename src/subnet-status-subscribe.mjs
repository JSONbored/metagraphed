// Pure helpers for the per-subnet MCP status subscription (#6034).
//
// Complements the chain-firehose path (#4983): `metagraph://chain/stream` is
// network-wide and event-driven from Postgres outbox ingest;
// `metagraph://subnet/{netuid}/status` is scoped to one subnet and event-
// driven from the health prober's write path (diff prior vs next
// health:current, then fan out via SubnetStatusHub → McpSessionHub /notify).
// No per-subnet poll loops — the 15-minute probe sweep is already the clock.
//
// Chain stream URI is the literal string (same value as
// MCP_CHAIN_STREAM_RESOURCE_URI in workers/mcp-session-hub.mjs) — this module
// must not import that file, or it would cycle with McpSessionHub's import of
// parseSubnetStatusResourceUri below.

export const MCP_SUBNET_STATUS_URI_RE = /^metagraph:\/\/subnet\/(\d+)\/status$/;

export function buildSubnetStatusResourceUri(netuid) {
  return `metagraph://subnet/${netuid}/status`;
}

export function parseSubnetStatusResourceUri(uri) {
  if (typeof uri !== "string") return null;
  const match = MCP_SUBNET_STATUS_URI_RE.exec(uri);
  if (!match) return null;
  // Regex admits only digits → Number(match[1]) is always a non-negative integer.
  return Number(match[1]);
}

export function isSubscribableMcpResourceUri(uri) {
  if (uri === "metagraph://chain/stream") return true;
  return parseSubnetStatusResourceUri(uri) != null;
}

export function listSubscribableMcpResourceClasses() {
  return ["metagraph://chain/stream", "metagraph://subnet/{netuid}/status"];
}

// Compact, order-stable fingerprint of one subnet's health tier + surface
// membership/status. Used to decide whether a probe sweep produced a real
// change worth notifying subscribers about.
export function subnetStatusFingerprint(subnetRow, surfacesForNetuid) {
  const status =
    subnetRow && typeof subnetRow.status === "string"
      ? subnetRow.status
      : "unknown";
  const surface_count = Number.isInteger(subnetRow?.surface_count)
    ? subnetRow.surface_count
    : (surfacesForNetuid?.length ?? 0);
  const surfaces = (surfacesForNetuid || [])
    .map((row) => {
      const key = row.surface_key || row.surface_id || "";
      const surfaceStatus =
        typeof row.status === "string" ? row.status : "unknown";
      return `${key}:${surfaceStatus}`;
    })
    .sort();
  return JSON.stringify({ status, surface_count, surfaces });
}

function indexHealthCurrent(snapshot) {
  const byNetuid = new Map();
  if (!snapshot || typeof snapshot !== "object") return byNetuid;
  const surfacesByNetuid = new Map();
  for (const row of snapshot.surfaces || []) {
    if (typeof row?.netuid !== "number") continue;
    const group = surfacesByNetuid.get(row.netuid) || [];
    group.push(row);
    surfacesByNetuid.set(row.netuid, group);
  }
  for (const subnet of snapshot.subnets || []) {
    if (typeof subnet?.netuid !== "number") continue;
    byNetuid.set(
      subnet.netuid,
      subnetStatusFingerprint(subnet, surfacesByNetuid.get(subnet.netuid)),
    );
  }
  // A netuid that only appears in surfaces (no rollup row yet) still needs a
  // fingerprint so membership-only changes are detected.
  for (const [netuid, rows] of surfacesByNetuid) {
    if (byNetuid.has(netuid)) continue;
    byNetuid.set(netuid, subnetStatusFingerprint(null, rows));
  }
  return byNetuid;
}

// Returns sorted unique netuids whose health tier, surface membership, or
// per-surface status changed between two health:current snapshots. A cold
// prior (null/empty) yields every netuid in `next` — first probe after
// deploy is a real "status became known" signal for subscribers.
export function diffChangedSubnetNetuids(prior, next) {
  const priorIndex = indexHealthCurrent(prior);
  const nextIndex = indexHealthCurrent(next);
  const changed = new Set();
  for (const [netuid, fingerprint] of nextIndex) {
    if (priorIndex.get(netuid) !== fingerprint) changed.add(netuid);
  }
  for (const netuid of priorIndex.keys()) {
    if (!nextIndex.has(netuid)) changed.add(netuid);
  }
  return [...changed].sort((a, b) => a - b);
}

// Best-effort fan-out into SubnetStatusHub. Never throws into the probe path —
// a missing binding (local/CI) or a DO failure must not fail the health write.
export async function notifySubnetStatusChanged(env, netuids) {
  if (!env?.SUBNET_STATUS_HUB) {
    return { notified: false, reason: "unbound" };
  }
  const list = Array.isArray(netuids)
    ? netuids.filter((n) => Number.isInteger(n) && n >= 0)
    : [];
  if (list.length === 0) {
    return { notified: false, reason: "no_netuids" };
  }
  try {
    const stub = env.SUBNET_STATUS_HUB.get(
      env.SUBNET_STATUS_HUB.idFromName("global"),
    );
    const upstream = await stub.fetch(
      "https://subnet-status-hub.internal/notify-changed",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ netuids: list }),
      },
    );
    if (!upstream.ok) {
      return { notified: false, reason: `status_${upstream.status}` };
    }
    return { notified: true };
  } catch {
    return { notified: false, reason: "fetch_failed" };
  }
}
