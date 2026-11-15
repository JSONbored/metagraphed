// The account-proxies serving builders (#13166) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces
// cannot drift. Pure + exported for tests; callers resolve the store (the
// native seam in account-proxies-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The delegation state's writers -- the
// engine's Proxy.Proxies decode -- land separately (#13166 defers them), so
// an empty result is not "this account delegates to nobody": it is "the
// proxy capture has not run", and `proxy_count: null` with an empty
// `proxies` is how the artifact says so.
import { selectedAccountProxiesStore } from "./account-proxies-store.ts";
import { u64TextOrNull } from "./subnet-alpha-dividends.ts";

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

function formatProxy(row: Row): Row | null {
  const delegate = typeof row?.delegate === "string" ? row.delegate : "";
  const proxyType = typeof row?.proxy_type === "string" ? row.proxy_type : "";
  const delay = nonNegativeInt(row?.delay);
  // A row missing its delegate, variant or delay names no proxy the chain
  // defines; drop it rather than serve a delegation that cannot be acted on.
  if (delegate === "" || proxyType === "" || delay === null) return null;
  return {
    delegate,
    proxy_type: proxyType,
    delay,
    captured_at: toIso(row?.captured_at),
  };
}

export function buildAccountProxies(
  rows: readonly Row[] | null,
  ss58: unknown,
): Row {
  const proxies = (rows ?? [])
    .map((row) => formatProxy(row))
    .filter((row): row is Row => row !== null);
  // The chain stores one reserve per delegating account (the vector's u64);
  // the engine repeats it per row, so the first formatted row's source
  // carries it. Null when no row does -- never a fabricated zero reserve.
  let deposit: string | null = null;
  for (const row of rows ?? []) {
    const candidate = u64TextOrNull(row?.deposit);
    if (candidate !== null) {
      deposit = candidate;
      break;
    }
  }
  let newest: string | null = null;
  for (const proxy of proxies) {
    const stamp = proxy.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    ss58,
    proxy_count: proxies.length > 0 ? proxies.length : null,
    deposit,
    captured_at: newest,
    proxies,
  };
}

/**
 * One account's proxy rows through the native seam, or null.
 *
 * Null for "no store bound" (today's deployed Workers) AND for a store read
 * that failed -- both render as the same schema-stable decline, because a
 * caller cannot act differently on the two and an error body would turn a
 * degraded tier into a hard failure the sibling account routes never have.
 */
export async function loadAccountProxies(
  env: unknown,
  ss58: string,
): Promise<Row[] | null> {
  const store = selectedAccountProxiesStore(env);
  if (!store) return null;
  try {
    return await store.rows(ss58);
  } catch (error) {
    console.error("account proxies store read failed:", error);
    return null;
  }
}
