// Do the responses we SERVE match the schemas we PUBLISH? (#9141)
//
// #9138 shipped a route serving a `health_source` its own schema forbade -- on
// 15 of 20 endpoints, in production, for as long as the serve-time overlay had
// existed. It was found by hand. Nothing in CI checks this, so nothing would
// have found it and nothing would find the next one.
//
// The existing tripwire (src/response-validation-tripwire.ts) cannot: it is
// default-OFF, log-only, and wired for 5 pilot routes. That is the right design
// for the REQUEST path -- nobody wants per-request Zod parsing in a hot Worker,
// or a schema bug 500ing a live route. The gap is that nothing checked
// conformance OUT OF BAND, where being thorough is free.
//
// The class this catches is specifically serve-time transforms: the schema
// describes the baked artifact, the route serves an overlaid one, and the
// build-time tests never see the difference.
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { API_ROUTES } from "../src/contracts.ts";
import { apiRouteUrl } from "./smoke-live-api.ts";

const BASE = process.env.CONFORMANCE_API_BASE || "https://api.metagraph.sh";
const SPEC_PATH =
  process.env.CONFORMANCE_SPEC_PATH || "public/metagraph/openapi.json";

export interface Violation {
  route: string;
  path: string;
  message: string;
}

type Validator = (body: unknown) => Violation[];

/**
 * A validator for one route's declared 200 JSON schema, or null when the route
 * declares none.
 *
 * The whole spec is registered and referenced by JSON POINTER rather than
 * compiling the sub-schema on its own: every response schema is built from
 * `$ref: "#/components/schemas/..."`, and a detached sub-schema resolves none
 * of them. Getting this wrong does not under-report -- it fails all 244 routes
 * at once, which is how the first draft of this check "found" 244 bugs.
 */
export function buildValidator(
  spec: Record<string, unknown>,
  routePath: string,
): Validator | null {
  const ajv = new (
    Ajv2020 as unknown as new (o: unknown) => {
      addSchema: (s: unknown, k: string) => void;
      compile: (s: unknown) => {
        (body: unknown): boolean;
        errors?: { instancePath?: string; message?: string }[] | null;
      };
    }
  )(
    // allErrors: a route can violate its schema in more than one place, and
    // stopping at the first turns one bug into a queue of them -- /api/v1/rpc/pools
    // had two, and fixing #9138 is what "revealed" #9142.
    { strict: false, allErrors: true, validateFormats: false },
  );
  (addFormats as unknown as (a: unknown) => void)(ajv);
  ajv.addSchema(spec, "openapi.json");

  const paths = spec.paths as Record<string, Record<string, unknown>>;
  const operation = paths?.[routePath]?.get as
    { responses?: Record<string, unknown> } | undefined;
  const schema = (
    (operation?.responses?.["200"] as Record<string, Record<string, unknown>>)
      ?.content?.["application/json"] as { schema?: unknown }
  )?.schema;
  if (!schema) return null;

  const pointer = routePath.replace(/~/g, "~0").replace(/\//g, "~1");
  const validate = ajv.compile({
    $ref: `openapi.json#/paths/${pointer}/get/responses/200/content/application~1json/schema`,
  });

  return (body: unknown) => {
    if (validate(body)) return [];
    // EVERY error, not just the first. /api/v1/rpc/pools had two violations
    // and the manual audit that found #9138 reported one -- so fixing it
    // "revealed" #9142 as if it were a new regression. A conformance check
    // that stops at the first error turns one bug into a queue of them.
    const seen = new Set<string>();
    const violations: Violation[] = [];
    for (const error of validate.errors ?? []) {
      const path = error.instancePath || "(root)";
      const message = error.message || "failed validation";
      const key = `${path}|${message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push({ route: routePath, path, message });
    }
    return violations;
  };
}

/**
 * The verdict for one fetched route, as a pure function (#9141).
 *
 * Split out so the rule is testable without a network or a spec. The edges are
 * the entire point, and every one of them is a decision to SKIP rather than to
 * fail -- a conformance check that also reports availability becomes a check
 * nobody trusts, because it goes red for reasons that are not drift.
 */
export function evaluateResponse({
  status,
  body,
  validator,
}: {
  status: number;
  body: unknown;
  // Carries its own route path, so violations name it without this function
  // needing to know it.
  validator: Validator | null;
}): { skipped: string | null; violations: Violation[] } {
  // No declared JSON schema means nothing to check -- not a failure.
  if (!validator) return { skipped: "no declared 200 schema", violations: [] };
  // Only a 200 is judged. Availability is check-self-health's job; a 503 here
  // would make this monitor red for something it is not measuring.
  if (status !== 200) return { skipped: `http ${status}`, violations: [] };
  // NOTE a degraded tier answers with a schema-stable EMPTY body, and that
  // passes -- correctly. This checks shape, not content.
  return { skipped: null, violations: validator(body) };
}

async function main(): Promise<void> {
  const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as Record<
    string,
    unknown
  >;
  const today = new Date().toISOString().slice(0, 10);

  const violations: Violation[] = [];
  let checked = 0;
  let skipped = 0;

  for (const route of API_ROUTES as unknown as {
    path: string;
    method: string;
  }[]) {
    if (route.method !== "GET") continue;

    let url: string;
    try {
      // Reuses the smoke runner's fixture substitutions rather than growing a
      // second set of sample ids that could drift from it.
      url = apiRouteUrl(route.path, today);
    } catch {
      skipped += 1; // unsubstitutable placeholder (needs a discovered id)
      continue;
    }

    let fetched: { status: number; body: unknown };
    try {
      const response = await fetch(new URL(url, BASE), {
        signal: AbortSignal.timeout(30_000),
      });
      fetched = {
        status: response.status,
        body: response.status === 200 ? await response.json() : null,
      };
    } catch {
      skipped += 1; // network/timeout: not drift
      continue;
    }

    const verdict = evaluateResponse({
      ...fetched,
      validator: buildValidator(spec, route.path),
    });
    if (verdict.skipped) {
      skipped += 1;
      continue;
    }
    checked += 1;
    violations.push(...verdict.violations);

    // Paced under the anonymous rate limit (100 req / 60s per IP).
    if (checked % 20 === 0) await new Promise((r) => setTimeout(r, 15_000));
  }

  console.log(
    JSON.stringify(
      { checked, skipped, violations: violations.length, details: violations },
      null,
      2,
    ),
  );

  if (violations.length === 0) {
    console.log(
      `OK: all ${checked} checked routes match their published schemas.`,
    );
    return;
  }

  for (const violation of violations) {
    console.error(
      `ALERT: ${violation.route} ${violation.path} ${violation.message}`,
    );
  }

  const webhook = process.env.LIVE_ALERT_WEBHOOK_URL;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          content:
            `⚠️ metagraphed: ${violations.length} route(s) serve responses their own published schema rejects.\n` +
            violations
              .slice(0, 10)
              .map((v) => `• ${v.route} ${v.path} — ${v.message}`)
              .join("\n") +
            `\nA client generated from openapi.json will reject these (#9141).`,
        }),
      });
    } catch (err) {
      console.error(
        `alert webhook failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  // Non-zero so the workflow records a failure -- a monitor whose alerts only
  // reach a webhook is invisible when the webhook is misconfigured.
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
