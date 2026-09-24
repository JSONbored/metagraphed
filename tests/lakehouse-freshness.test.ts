// The lakehouse freshness rule, tested without a catalog (#11048).
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  EXPECTED,
  evaluate,
  checkLakehouseFreshness,
} from "../scripts/check-lakehouse-freshness.ts";
import { TABLES } from "../scripts/refresh-lakehouse-schema.ts";

const DAY = 24 * 60 * 60 * 1000;

describe("lakehouse freshness", () => {
  test("an UNCLASSIFIED table fails -- absent is not exempt", () => {
    // The Neon watchdog's rule, for the Neon watchdog's reason: absent means
    // nobody thought about it, and a table nobody classified is watched by
    // nothing, forever.
    const v = evaluate(
      { table: "brand_new", newestMs: Date.now(), ageMs: 0 },
      undefined,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /not classified/);
  });

  test("every table this repo READS is classified", () => {
    // Derived from the snapshot list rather than restated, so a table added
    // there without a bound here fails.
    const unclassified = TABLES.filter((t: string) => !(t in EXPECTED));
    assert.deepEqual(unclassified, []);
  });

  test("a table past its bound is STALE, and says by how much", () => {
    const v = evaluate(
      {
        table: "nominator_positions",
        newestMs: Date.now() - 11 * DAY,
        ageMs: 11 * DAY,
      },
      EXPECTED.nominator_positions,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /11\.0d/);
  });

  test("a table inside its bound passes", () => {
    const v = evaluate(
      { table: "blocks", newestMs: Date.now() - 60_000, ageMs: 60_000 },
      EXPECTED.blocks,
    );
    assert.equal(v.ok, true);
  });

  test("NO snapshots at all is a failure, not an age of zero", () => {
    const v = evaluate(
      { table: "blocks", newestMs: null, ageMs: null },
      EXPECTED.blocks,
    );
    assert.equal(v.ok, false);
    assert.match(v.detail, /NO snapshots/);
  });

  test("an explicit null bound is exempt, and carries its reason", () => {
    const v = evaluate(
      { table: "rehearsal", newestMs: 0, ageMs: 99 * DAY },
      EXPECTED.rehearsal,
    );
    assert.equal(v.ok, true);
    assert.match(v.detail, /rehearsal fixture/);
  });

  test("the frozen tables are bounded by what they SHOULD do, not their outage", () => {
    // A watchdog calibrated to the outage it watches reports success forever.
    // These must FAIL at their measured 10.5d age, which is the point.
    for (const t of [
      "nominator_positions",
      "subnet_hyperparams",
      "self_health_daily",
    ]) {
      const rule = EXPECTED[t]!;
      assert.ok(rule.maxAgeMs !== null && rule.maxAgeMs < 10.5 * DAY, t);
    }
  });
});

test("the scheduled checker uses only catalog metadata, including historical type changes", async () => {
  const calls: string[] = [];
  vi.stubEnv("R2_CATALOG_TOKEN", "fixture-catalog-reader");
  vi.stubEnv("LIVE_ALERT_WEBHOOK_URL", "");
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(String(url));
      calls.push(parsed.href);
      assert.equal(parsed.hostname, "catalog.cloudflarestorage.com");
      assert.equal(parsed.searchParams.has("query"), false);
      if (parsed.pathname.endsWith("/v1/config"))
        return Response.json({ overrides: { prefix: "fixture" } });
      if (parsed.pathname.endsWith("/tables"))
        return Response.json({ identifiers: [{ name: "blocks" }] });
      assert.match(
        parsed.pathname,
        /\/namespaces\/chain(?:_testnet)?\/tables\/blocks$/,
      );
      return Response.json({
        metadata: {
          snapshots: [{ "timestamp-ms": Date.now() }],
          "current-schema-id": 1,
          schemas: [
            {
              "schema-id": 0,
              fields: [{ id: 1, name: "value", type: "float" }],
            },
            {
              "schema-id": 1,
              fields: [{ id: 1, name: "value", type: "double" }],
            },
          ],
        },
      });
    }),
  );
  try {
    await checkLakehouseFreshness();
    assert.equal(calls.length, 5);
    assert.equal(
      calls.filter((url) => url.endsWith("/tables/blocks")).length,
      2,
    );
    assert.match(
      output.mock.calls.map(([text]) => String(text)).join(""),
      /0 stale of 2/,
    );
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    output.mockRestore();
  }
});

test("catalog failures and incomplete responses cannot report a healthy inventory", async () => {
  vi.stubEnv("R2_CATALOG_TOKEN", "fixture-catalog-reader");
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  try {
    for (const mode of [
      "http",
      "missing-list",
      "empty-list",
      "invalid-name",
      "missing-metadata",
      "invalid-snapshots",
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string | URL | Request) => {
          const path = new URL(String(url)).pathname;
          if (path.endsWith("/v1/config"))
            return Response.json({ overrides: { prefix: "fixture" } });
          if (mode === "http")
            return new Response("unavailable", { status: 503 });
          if (path.endsWith("/tables")) {
            if (mode === "missing-list") return Response.json({});
            if (mode === "empty-list")
              return Response.json({ identifiers: [] });
            if (mode === "invalid-name")
              return Response.json({ identifiers: [{}] });
            return Response.json({ identifiers: [{ name: "blocks" }] });
          }
          return Response.json(
            mode === "missing-metadata"
              ? {}
              : { metadata: { snapshots: "unavailable" } },
          );
        }),
      );
      await assert.rejects(checkLakehouseFreshness(), /Catalog/);
    }
    assert.equal(output.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    output.mockRestore();
  }
});
