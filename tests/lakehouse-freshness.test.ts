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

function credentials() {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv(
    "CLOUDFLARE_D1_DATABASE_ID",
    "12345678-1234-1234-1234-123456789012",
  );
  vi.stubEnv("CLOUDFLARE_D1_API_TOKEN", "fixture-d1-reader");
  vi.stubEnv("LIVE_ALERT_WEBHOOK_URL", "");
}
const summary = () => ({
  snapshots: [{ "timestamp-ms": Date.now() }],
  "current-schema-id": 1,
  schemas: [
    {
      "schema-id": 1,
      fields: [{ id: 1, name: "value", type: "double", required: false }],
    },
  ],
});
const rows = () =>
  ["chain", "chain_testnet"].map((namespace) => ({
    namespace,
    name: "blocks",
    metadata_summary: JSON.stringify(summary()),
  }));
const response = (results: unknown) =>
  Response.json({ success: true, result: [{ success: true, results }] });

test("the scheduled checker uses one bounded D1 metadata query for both networks", async () => {
  credentials();
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(url)).hostname, "api.cloudflare.com");
      assert.match(
        new URL(String(url)).pathname,
        /\/d1\/database\/[^/]+\/query$/,
      );
      const statements = JSON.parse(String(init?.body)).batch;
      assert.equal(statements.length, 1);
      assert.match(
        statements[0].sql,
        /^SELECT .* FROM iceberg_catalog_tables .* LIMIT 1001$/,
      );
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        "Bearer fixture-d1-reader",
      );
      return response(rows());
    },
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    await checkLakehouseFreshness();
    assert.equal(fetcher.mock.calls.length, 1);
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

test("failed, incomplete, duplicated and malformed D1 metadata cannot report healthy", async () => {
  credentials();
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  const valid = rows();
  const invalid = [
    null,
    [],
    [valid[0]],
    Array(1001).fill(valid[0]),
    [...valid, valid[0]],
    [{ ...valid[0], name: "" }],
    [{ ...valid[0], namespace: "unknown" }],
    [{ ...valid[0], metadata_summary: "invalid" }],
    [
      {
        ...valid[0],
        metadata_summary: JSON.stringify({
          ...summary(),
          snapshots: "unavailable",
        }),
      },
    ],
    [
      {
        ...valid[0],
        metadata_summary: JSON.stringify({
          ...summary(),
          snapshots: [{ "timestamp-ms": -1 }],
        }),
      },
    ],
    [
      {
        ...valid[0],
        metadata_summary: JSON.stringify({
          ...summary(),
          "current-schema-id": 99,
        }),
      },
    ],
  ];
  try {
    for (const value of invalid) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response(value)),
      );
      await assert.rejects(checkLakehouseFreshness(), /Catalog|D1/);
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await assert.rejects(checkLakehouseFreshness(), /D1/);
    assert.equal(output.mock.calls.length, 0);
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    output.mockRestore();
  }
});
