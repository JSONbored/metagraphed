// #9092: every `/api/v1` path the Worker serves must be a path the contract
// publishes.
//
// Nothing checked this, and three routes went missing for it. `POST
// /api/v1/ask`, `GET /api/v1/search/semantic` and `GET
// /api/v1/surfaces/{surface_id}/verify` -- the AI-native layer of ADR 0003 --
// were live and returning 200 while absent from `openapi.json`, the generated
// types, and every typed client. `validate:openapi` could not notice: it
// validates the routes that ARE declared, so a route nobody declared is
// invisible to it by construction.
//
// ── Derived, with a declared set of exceptions ──────────────────────────────
//
// The served set is DERIVED, by reading the Worker's own source. Which paths
// are deliberately unpublished cannot be derived -- "this endpoint is internal"
// is a decision, not a property of the code -- so it is declared here with a
// reason, and proven in BOTH directions: a served path that is neither
// registered nor excluded fails, and an exclusion the Worker no longer serves
// fails too, so the list cannot quietly rot.
//
// Same split as AUTH_REQUIRED_TOOL_NAMES and the field-provenance maps: derive
// the facts, declare the judgements, and let a test hold them together.
//
// ── What this does not cover ───────────────────────────────────────────────
//
// Literal `url.pathname === "/api/v1/…"` comparisons only. Templated routes are
// matched by regex against captured groups, and turning an arbitrary regex back
// into the `/api/v1/subnets/{netuid}/…` template it corresponds to is not
// something to do mechanically -- a half-working parser here would report
// confident nonsense, which is worse than a stated boundary. Every route this
// defect actually hid behind was a literal comparison.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { API_ROUTES } from "../src/contracts.ts";

const WORKER_SOURCE = "workers/api.ts";

/**
 * Paths the Worker serves on purpose without publishing them, and why.
 *
 * A prefix entry covers a whole family that shares one reason; an exact entry
 * covers a single endpoint. Both are asserted to still match something the
 * Worker serves.
 */
const UNPUBLISHED_PREFIXES: { prefix: string; reason: string }[] = [
  {
    prefix: "/api/v1/internal/",
    reason:
      "cron and service-binding sync endpoints, authenticated by shared secret and called only by our own workflows",
  },
  {
    prefix: "/api/v1/auth/",
    reason:
      "wallet challenge/verify, part of the auth flow rather than the read API",
  },
  {
    prefix: "/api/v1/watch/",
    reason: "watch-token issuance, an auth surface rather than a read route",
  },
];

const UNPUBLISHED_EXACT: { path: string; reason: string }[] = [
  {
    path: "/api/v1/graphql",
    reason:
      "the GraphQL endpoint publishes its own contract as an SDL (src/graphql-sdl.ts); an OpenAPI operation would describe the transport, not the API",
  },
  {
    path: "/api/v1/events",
    reason:
      "a Server-Sent Events stream, not a JSON artifact -- it has no response body to type",
  },
  {
    path: "/api/v1/chain/stream",
    reason: "the chain-firehose SSE stream, same reason as /api/v1/events",
  },
  {
    path: "/api/v1/icon",
    reason: "serves an image, not an envelope",
  },
];

/** Every `/api/v1` path the Worker compares against a literal. */
function servedLiteralPaths(): string[] {
  const source = readFileSync(WORKER_SOURCE, "utf8");
  return [
    ...new Set(
      [...source.matchAll(/pathname === "(\/api\/v1[^"]*)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();
}

const SERVED = servedLiteralPaths();
const REGISTERED = new Set(API_ROUTES.map((route) => route.path as string));

function excusedBy(path: string): string | null {
  const prefix = UNPUBLISHED_PREFIXES.find((entry) =>
    path.startsWith(entry.prefix),
  );
  if (prefix) return prefix.reason;
  return UNPUBLISHED_EXACT.find((entry) => entry.path === path)?.reason ?? null;
}

describe("every served /api/v1 path is published or explicitly excluded (#9092)", () => {
  test("the scan actually finds the Worker's routes", () => {
    // A regex that silently matched nothing would make the assertion below
    // vacuously pass -- the way a source-scanning check stops checking.
    assert.ok(
      SERVED.length >= 50,
      `expected to find the Worker's /api/v1 literals, found ${SERVED.length}`,
    );
    assert.ok(SERVED.includes("/api/v1/ask"));
  });

  test("no served path is missing from the contract", () => {
    const unpublished = SERVED.filter(
      (path) => !REGISTERED.has(path) && excusedBy(path) === null,
    );
    assert.deepEqual(
      unpublished,
      [],
      `${WORKER_SOURCE} serves these paths, and API_ROUTES does not publish them. ` +
        `Register each in src/contracts.ts, or add it to this file's exclusion list with a reason: ${unpublished.join(", ")}`,
    );
  });

  test("every exclusion is still a path the Worker serves", () => {
    // The other direction. An exclusion for a path that no longer exists is a
    // stale exemption that would silently excuse a future route reusing the
    // name.
    const served = new Set(SERVED);
    const stale = [
      ...UNPUBLISHED_EXACT.filter((entry) => !served.has(entry.path)).map(
        (entry) => entry.path,
      ),
      ...UNPUBLISHED_PREFIXES.filter(
        (entry) => !SERVED.some((path) => path.startsWith(entry.prefix)),
      ).map((entry) => entry.prefix),
    ];
    assert.deepEqual(
      stale,
      [],
      `these exclusions no longer match anything ${WORKER_SOURCE} serves: ${stale.join(", ")}`,
    );
  });

  test("an excluded path is never also registered", () => {
    // Both would be true statements about different things, but together they
    // mean the exclusion list is lying about why the path is absent.
    const contradictory = SERVED.filter(
      (path) => REGISTERED.has(path) && excusedBy(path) !== null,
    );
    assert.deepEqual(
      contradictory,
      [],
      `excluded as unpublished yet present in API_ROUTES: ${contradictory.join(", ")}`,
    );
  });

  test("the AI-native layer is registered", () => {
    // The three this check exists because of. Named explicitly so a revert
    // fails here with the reason, not just as a count.
    for (const path of [
      "/api/v1/ask",
      "/api/v1/search/semantic",
      "/api/v1/surfaces/{surface_id}/verify",
    ]) {
      assert.ok(
        REGISTERED.has(path),
        `${path} is served but not published -- the defect #9092 fixed`,
      );
    }
  });
});
