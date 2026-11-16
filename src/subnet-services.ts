// The subnet-services serving builders (#13164) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces
// cannot drift. Pure + exported for tests; callers resolve the store (the
// native seam in subnet-services-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The registry's writers -- the engine's
// SubtensorModule.Services decode (events ServiceSet / ServiceRemoved) --
// land separately (#13164 defers them), so an empty result is not "this
// subnet publishes no service URLs": it is "the service capture has not
// run", and `service_count: null` with an empty `services` is how the
// artifact says so.
import { selectedSubnetServicesStore } from "./subnet-services-store.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function nonNegativeInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function formatService(row: Row): Row | null {
  const hotkey = typeof row?.hotkey === "string" ? row.hotkey : "";
  const serviceUrl =
    typeof row?.service_url === "string" ? row.service_url : "";
  // A row without its key or its URL names no service the chain defines;
  // drop it rather than serve a binding that cannot be acted on.
  if (hotkey === "" || serviceUrl === "") return null;
  return {
    hotkey,
    service_url: serviceUrl,
    set_at: nonNegativeInt(row?.set_at),
    captured_at: toIso(row?.captured_at),
  };
}

export function buildSubnetServices(
  rows: readonly Row[] | null,
  netuid: unknown,
): Row {
  const services = (rows ?? [])
    .map((row) => formatService(row))
    .filter((row): row is Row => row !== null);
  // Newest stamp across the rows: the registry is written per hotkey, so one
  // capture stamp per artifact is the honest summary of when it was read.
  let newest: string | null = null;
  for (const service of services) {
    const stamp = service.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    netuid,
    service_count: services.length > 0 ? services.length : null,
    captured_at: newest,
    services,
  };
}

/**
 * One subnet's service rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling subnet routes never have.
 */
export async function loadSubnetServices(
  env: unknown,
  netuid: number,
): Promise<Row[] | null> {
  const store = selectedSubnetServicesStore(env);
  if (!store) return null;
  try {
    return await store.rows(netuid);
  } catch (error) {
    console.error("subnet services store read failed:", error);
    return null;
  }
}
