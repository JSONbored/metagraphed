// A filter the UI offers must be one the API can actually apply.
//
// The bug this exists to stop: /apis offered "auth required", "public safe" and
// "rate limited" shortcuts from the nav mega-menu, and applied all three
// CLIENT-SIDE over the rows already loaded. With the default page size of 25
// against 3,494 surfaces, `?auth=required` rendered at most the auth rows
// inside the first page -- 6 of the 1,184 that match. It did not error and it
// did not look empty; it silently under-reported by 99%, which reads exactly
// like a working filter.
//
// ── Derived, with declared exceptions ───────────────────────────────────────
//
// The server-side filter vocabulary is DERIVED from API_QUERY_COLLECTIONS, so
// a filter added to the contract is available here the day it lands. Which UI
// keys are legitimately client-only cannot be derived -- "this one joins two
// responses, so no single route could filter it" is a judgement -- so those are
// declared with a reason and proven to still be client-only.
//
// Same split as the field-provenance and auth-required work: derive the facts,
// declare the judgements, let the test hold them together.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "vitest";
import { API_QUERY_COLLECTIONS } from "../src/contracts.ts";

/** Every filter name any list route can apply server-side. */
function serverSideFilterNames(): Set<string> {
  const names = new Set<string>();
  for (const config of Object.values(
    API_QUERY_COLLECTIONS as Record<
      string,
      {
        filters?: Record<string, unknown>;
        csv_filters?: Record<string, unknown>;
        array_filters?: Record<string, unknown>;
        range_filters?: string[];
      }
    >,
  )) {
    for (const key of Object.keys(config.filters ?? {})) names.add(key);
    for (const key of Object.keys(config.csv_filters ?? {})) names.add(key);
    for (const key of Object.keys(config.array_filters ?? {})) names.add(key);
    for (const field of config.range_filters ?? []) {
      names.add(`min_${field}`);
      names.add(`max_${field}`);
    }
  }
  return names;
}

/**
 * The narrowing keys /apis puts in the URL, read from its own search schema.
 *
 * Parsed from source rather than imported: this file runs under the ROOT vitest
 * project, which deliberately excludes apps/ui, and importing a TanStack route
 * module here would drag in the whole router. The schema is a flat list of
 * `key: fallback(...)` lines, so reading the keys is exact.
 */
function surfacesSearchKeys(): string[] {
  const source = readFileSync(
    "apps/ui/src/lib/metagraphed/surface-filters.ts",
    "utf8",
  );
  const block = source.slice(
    source.indexOf("export const surfacesSearchSchema"),
    source.indexOf("export type SurfacesSearch"),
  );
  return [...block.matchAll(/^\s{2}([a-z_]+):\s/gm)].map((m) => m[1]);
}

/**
 * UI filter keys that are correctly client-only, and why.
 *
 * Each must still be absent from the server-side vocabulary — an entry here for
 * a filter the API has since learned is a stale exemption that would keep the
 * UI doing it the slow, truncating way.
 */
const CLIENT_ONLY: Record<string, string> = {};

const SERVER_SIDE = serverSideFilterNames();

describe("a UI filter must be one the API can apply (#9110 follow-up)", () => {
  test("the schema scan actually finds /apis' filter keys", () => {
    // A regex that silently matched nothing would make the assertion below
    // vacuously pass -- the way a source-scanning check stops checking.
    const keys = surfacesSearchKeys();
    assert.ok(
      keys.length >= 3,
      `expected /apis' search schema keys, found ${keys.length}`,
    );
    assert.ok(keys.includes("auth"), "expected the auth shortcut");
  });

  test("every /apis narrowing filter is server-backed or declared client-only", () => {
    // `auth` maps to the contract's `auth_required`; the UI keeps the shorter
    // name in the URL because it is user-facing.
    const toContractName: Record<string, string> = { auth: "auth_required" };
    const unbacked = surfacesSearchKeys()
      .filter((key) => !(key in CLIENT_ONLY))
      .filter((key) => !SERVER_SIDE.has(toContractName[key] ?? key));
    assert.deepEqual(
      unbacked,
      [],
      `these are filtered client-side over one loaded page, so they under-report: ${unbacked.join(", ")}. ` +
        "Add the filter to its API_QUERY_COLLECTIONS entry, or declare it in CLIENT_ONLY with the reason.",
    );
  });

  test("no client-only exemption is stale", () => {
    // The other direction. Once the API can filter it, the exemption is a lie
    // that keeps the UI truncating.
    const nowServerBacked = Object.keys(CLIENT_ONLY).filter((key) =>
      SERVER_SIDE.has(key),
    );
    assert.deepEqual(
      nowServerBacked,
      [],
      `the API can now filter these, so the UI must stop doing it client-side: ${nowServerBacked.join(", ")}`,
    );
  });

  test("the surfaces collection really did gain the two filters", () => {
    // Named rather than left to the generic check: these are the two that were
    // broken, so a revert should fail here with the reason.
    for (const name of ["auth_required", "public_safe", "rate_limited"]) {
      assert.ok(
        SERVER_SIDE.has(name),
        `${name} must be server-side or /apis silently truncates it`,
      );
    }
  });
});
