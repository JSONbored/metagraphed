// The account-multisigs serving builders (#13166) -- shared by the REST
// handler, the GraphQL resolver and the MCP tool, so the three surfaces
// cannot drift. Pure + exported for tests; callers resolve the store (the
// native seam in account-multisigs-store.ts) and hand the rows in.
//
// THE DECLINE IS NULL, NEVER ZERO. The composition state's writers -- the
// engine's Multisig call/event decode -- land separately (#13166 defers
// them), so an empty result is not "this account belongs to no multisig": it
// is "the multisig capture has not run", and `multisig_count: null` with an
// empty `multisigs` is how the artifact says so.
import { selectedAccountMultisigsStore } from "./account-multisigs-store.ts";

type Row = Record<string, unknown>;

function toIso(ms: unknown): string | null {
  if (ms == null) return null;
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  const d = new Date(n);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function positiveInt(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 ? parsed : null;
}

/** The signatory set as served: every ss58 string in the stored array, or
 * null when the capture has not resolved the composition. An array holding
 * junk entries keeps its string members -- the engine owns admission. */
function signatoryList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const members = value.filter(
    (entry): entry is string => typeof entry === "string" && entry !== "",
  );
  return members.length > 0 ? members : null;
}

export function formatMultisig(row: Row, member: string): Row | null {
  const multisig = typeof row?.multisig === "string" ? row.multisig : "";
  // A row without its multisig account names nothing; drop it.
  if (multisig === "") return null;
  const signatories = signatoryList(row?.signatories);
  return {
    multisig,
    threshold: positiveInt(row?.threshold),
    signatories,
    signatory_count: signatories ? signatories.length : null,
    // Which side of the membership matched: the account IS the multisig, or
    // it signs for one. Both can be true for a multisig signing for itself;
    // the account identity wins because it is the stronger claim.
    role: multisig === member ? "multisig" : "signatory",
    captured_at: toIso(row?.captured_at),
  };
}

export function buildAccountMultisigs(
  rows: readonly Row[] | null,
  ss58: string,
): Row {
  const multisigs = (rows ?? [])
    .map((row) => formatMultisig(row, ss58))
    .filter((row): row is Row => row !== null);
  let newest: string | null = null;
  for (const entry of multisigs) {
    const stamp = entry.captured_at as string | null;
    if (stamp !== null && (newest === null || stamp > newest)) newest = stamp;
  }
  return {
    schema_version: 1,
    ss58,
    multisig_count: multisigs.length > 0 ? multisigs.length : null,
    captured_at: newest,
    multisigs,
  };
}

/** One account's multisig membership rows through the native seam, or null --
 * same decline contract as loadAccountProxies. */
export async function loadAccountMultisigs(
  env: unknown,
  ss58: string,
): Promise<Row[] | null> {
  const store = selectedAccountMultisigsStore(env);
  if (!store) return null;
  try {
    return await store.byMember(ss58);
  } catch (error) {
    console.error("account multisigs store read failed:", error);
    return null;
  }
}
