// Does every published response pass the audit seam's own validation? (#11046)
//
// The response tripwire enforces in-path on the generic seam and audits the
// entity handlers at the fetch seam -- but a fingerprint only fires when
// TRAFFIC exercises the shape that drifts, and each late discovery resets the
// warn-stage's quiet-day clock. Both production fingerprints the seam ever
// produced (#11079's include_points omission, #11082's null artifact_path)
// were findable in one pass by simply asking every route and validating the
// answer with the seam's own call -- which is exactly what this sweep does.
//
// WHAT IT CHECKS. Every REST route in `API_ROUTES` whose path parameters have
// a subject, one call each, validated through the SAME
// `validateResponseTripwire(id, body, artifact_path, projected=false)` the
// Worker's auditResponse makes. A route that answers anything but 200 JSON is
// counted as skipped, because that is what the seam itself does with it.
//
// The subjects come from `conformance-subjects.ts`, shared with the other
// sweeps, and a route whose parameter has no subject is SKIPPED rather than
// filled with a placeholder -- validating a 404 body validates nothing. The
// three routes with a REQUIRED query parameter get it from the same table
// (`REQUIRED_QUERY` below), so they are swept rather than written off as 400s.
//
// SERIAL AND SPACED, for the reason the MCP sweep records: the endpoint
// rate-limits per client, and a parallel run manufactures failures that read
// exactly like real defects.
//
// Out of band, like its siblings: it needs production, and a check that cannot
// run on a pull request should not pretend to. Run it before flipping
// `METAGRAPH_AUDIT_RESPONSES` to enforce, and after any change that touches a
// served value -- a drift here is a warn fingerprint waiting for traffic, and
// an enforce-mode 500.
import { pathToFileURL } from "node:url";
import { API_ROUTES } from "../src/contracts.ts";
import { validateResponseTripwire } from "../src/response-validation-tripwire.ts";
import { concreteRoute, SUBJECTS } from "./conformance-subjects.ts";

const BASE = "https://api.metagraph.sh";
const USER_AGENT = "metagraphed-tripwire-conformance/1.0";
const SPACING_MS = 250;

/**
 * The routes that 400 without a query parameter, and the subject-backed fill
 * that turns each into a real answer. Everything else is probed bare: an
 * optional parameter left off IS the default shape production serves most.
 */
const REQUIRED_QUERY: Readonly<Record<string, string>> = {
  "subnet-stake-quote": "amount=1",
  compare: `netuids=${(SUBJECTS.netuids as readonly number[]).join(",")}`,
  "compare-validators": `hotkeys=${String(SUBJECTS.hotkeys)}`,
};

export interface TripwireSweepResult {
  clean: number;
  drift: string[];
  skipped: string[];
}

export type RouteVerdict =
  | { kind: "clean" }
  | { kind: "skip"; reason: string }
  | { kind: "drift"; detail: string };

/**
 * One route's verdict: exactly the seam's own decision rule. Anything but a
 * 200 JSON answer is a SKIP because `auditResponse` never sees it either; a
 * body the tripwire refuses is the finding.
 */
export async function evaluateRoute(
  route: { id: string; path: string; artifact_path: string },
  fetchImpl: typeof fetch,
): Promise<RouteVerdict> {
  const path = concreteRoute(route.path);
  if (path === null) return { kind: "skip", reason: "no subject" };
  const query = REQUIRED_QUERY[route.id];
  const url = `${BASE}${path}${query ? `?${query}` : ""}`;
  const response = await fetchImpl(url, {
    headers: { "user-agent": USER_AGENT },
  });
  if (
    response.status !== 200 ||
    !response.headers.get("content-type")?.includes("json")
  ) {
    return { kind: "skip", reason: String(response.status) };
  }
  try {
    await validateResponseTripwire(
      route.id,
      await response.json(),
      route.artifact_path,
      false,
    );
    return { kind: "clean" };
  } catch (error: unknown) {
    const detail = (error as { detail?: unknown }).detail;
    return { kind: "drift", detail: JSON.stringify(detail) };
  }
}

export async function sweepTripwireConformance(
  fetchImpl: typeof fetch = fetch,
): Promise<TripwireSweepResult> {
  const result: TripwireSweepResult = { clean: 0, drift: [], skipped: [] };
  for (const route of API_ROUTES) {
    const verdict = await evaluateRoute(route, fetchImpl);
    if (verdict.kind === "clean") result.clean += 1;
    else if (verdict.kind === "skip")
      result.skipped.push(`${route.path} (${verdict.reason})`);
    else result.drift.push(`${route.path} :: ${verdict.detail}`);
    await new Promise((resolve) => setTimeout(resolve, SPACING_MS));
  }
  return result;
}

// Runs only when EXECUTED, never when imported -- same contract as the other
// out-of-band sweeps, so a test can exercise the pieces without calling
// production.
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const result = await sweepTripwireConformance();
  console.log(
    `Tripwire conformance: ${result.clean} route(s) clean, ` +
      `${result.drift.length} drifted, ${result.skipped.length} skipped ` +
      `(non-200/non-JSON or no subject -- the seam skips those too).`,
  );
  for (const line of result.skipped) console.log(`  skip ${line}`);
  if (result.drift.length > 0) {
    console.error(
      "These responses would be warn fingerprints today and 500s under enforce:",
    );
    for (const line of result.drift) console.error(`  DRIFT ${line}`);
    process.exit(1);
  }
}
