import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import {
  MIRROR_SOURCES,
  evaluateMirrorFreshness,
  loadMirrorFreshnessEvidence,
  type MirrorFreshnessEvidence,
} from "../scripts/lib/mirror-freshness.ts";
import { checkLakehouseFreshness } from "../scripts/check-lakehouse-freshness.ts";

const now = Date.UTC(2026, 8, 24, 5);
const HOUR = 3600000;
function fixture(): MirrorFreshnessEvidence {
  const tables = Object.fromEntries(
    Object.keys(MIRROR_SOURCES).map((table) => [
      table,
      `${table}: unchanged (17 rows), no snapshot`,
    ]),
  );
  tables.surface_history = "surface_history: no rows above 10006";
  tables.treasury_readings =
    "treasury_readings: unchanged (0 rows), no snapshot";
  return {
    receipt: {
      ok: true,
      complete: true,
      namespace: "chain",
      checked_at: new Date(now - HOUR).toISOString(),
      tables_expected: 6,
      tables_reported: 6,
      tables,
      failures: {},
    },
    lanes: ["registry-sync", "registry-resync", "compute-declarations"].map(
      (lane) => ({ lane, verdict: "ok", checked_at: now - HOUR }),
    ),
    computeNewest: now - HOUR,
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("quiet snapshots require a complete mirror and the corresponding source health", () => {
  const evidence = fixture();
  for (const table of Object.keys(MIRROR_SOURCES))
    assert.equal(
      evaluateMirrorFreshness(table, false, true, evidence, now).ok,
      true,
      table,
    );
  assert.equal(
    evaluateMirrorFreshness("treasury_readings", false, false, evidence, now)
      .ok,
    true,
  );
  assert.equal(
    evaluateMirrorFreshness("providers", false, false, evidence, now).ok,
    false,
  );
  assert.equal(
    evaluateMirrorFreshness("blocks", true, true, evidence, now).ok,
    false,
  );
});

test.each([
  null,
  [],
  {},
  { ok: false },
  { complete: false },
  { complete: undefined },
  { namespace: "chain_testnet" },
  { checked_at: "invalid" },
  { checked_at: 123 },
  { checked_at: new Date(now + 1).toISOString() },
  { checked_at: new Date(now - 6 * HOUR - 1).toISOString() },
  { tables: {} },
  { tables: [] },
  { tables_expected: 7 },
  { tables_reported: 5 },
  { failures: [] },
  { failures: { providers: "write failed" } },
  {
    tables: { providers: "providers: FAILED" },
    tables_expected: 1,
    tables_reported: 1,
  },
  {
    tables: { providers: "surfaces: unchanged (17 rows), no snapshot" },
    tables_expected: 1,
    tables_reported: 1,
  },
  { tables: { providers: 1 }, tables_expected: 1, tables_reported: 1 },
  {
    tables: { surfaces: "surfaces: unchanged (17 rows), no snapshot" },
    tables_expected: 1,
    tables_reported: 1,
  },
])(
  "invalid or incomplete mirror evidence cannot rescue a quiet table: %j",
  (change) => {
    const evidence = fixture();
    evidence.receipt =
      change && !Array.isArray(change) && Object.keys(change).length
        ? { ...(evidence.receipt as object), ...change }
        : change;
    assert.equal(
      evaluateMirrorFreshness("providers", false, true, evidence, now).ok,
      false,
    );
  },
);

test("source failure or silence still fails when the catalog is recent", () => {
  for (const source of [
    "registry-sync",
    "registry-resync",
    "compute-declarations",
  ])
    for (const change of [
      "missing",
      "duplicate",
      "failed",
      "stale",
      "future",
      "invalid",
    ] as const) {
      const evidence = fixture();
      const lane = evidence.lanes.find((row) => row.lane === source)!;
      if (change === "missing")
        evidence.lanes = evidence.lanes.filter((row) => row !== lane);
      if (change === "duplicate") evidence.lanes.push({ ...lane });
      if (change === "failed") lane.verdict = "unknown";
      if (change === "stale") lane.checked_at = now - 49 * HOUR;
      if (change === "future") lane.checked_at = now + 1;
      if (change === "invalid") lane.checked_at = "recent";
      const table =
        source === "compute-declarations"
          ? "compute_declarations"
          : "providers";
      assert.equal(
        evaluateMirrorFreshness(table, true, true, evidence, now).ok,
        false,
        `${source}/${change}`,
      );
    }
  for (const computeNewest of [
    null,
    NaN,
    0,
    now - 4 * HOUR - 1,
    now + 1,
    "recent",
  ]) {
    const evidence = { ...fixture(), computeNewest };
    assert.equal(
      evaluateMirrorFreshness("compute_declarations", true, true, evidence, now)
        .ok,
      false,
    );
    assert.equal(
      evaluateMirrorFreshness("emission_flow_watch", false, true, evidence, now)
        .ok,
      true,
    );
  }
});

test("an append receipt cannot excuse an old or absent catalog snapshot", () => {
  const evidence = fixture();
  evidence.receipt = {
    ...(evidence.receipt as object),
    tables: { providers: "providers: appended 17 rows as a new version" },
    tables_expected: 1,
    tables_reported: 1,
  };
  assert.equal(
    evaluateMirrorFreshness("providers", false, true, evidence, now).ok,
    false,
  );
  assert.equal(
    evaluateMirrorFreshness("providers", true, false, evidence, now).ok,
    false,
  );
  assert.equal(
    evaluateMirrorFreshness("providers", true, true, evidence, now).ok,
    true,
  );
});

function credentials() {
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "a".repeat(32));
  vi.stubEnv(
    "CLOUDFLARE_D1_DATABASE_ID",
    "11111111-1111-1111-1111-111111111111",
  );
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "fixture-maintenance-reader");
  vi.stubEnv("R2_CATALOG_TOKEN", "fixture-catalog-reader");
  vi.stubEnv("LIVE_ALERT_WEBHOOK_URL", "");
}
function transport(evidence = fixture()) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.includes("/objects/"))
      return Response.json(evidence.receipt);
    if (url.pathname.includes("/d1/database/")) {
      assert.equal(init?.method, "POST");
      const { batch } = JSON.parse(String(init?.body));
      assert.equal(batch.length, 2);
      assert.ok(
        batch.every((statement: { sql: string }) =>
          statement.sql.startsWith("SELECT "),
        ),
      );
      return Response.json({
        success: true,
        result: [
          { success: true, results: evidence.lanes },
          { success: true, results: [{ newest: evidence.computeNewest }] },
        ],
      });
    }
    assert.equal(url.hostname, "catalog.cloudflarestorage.com");
    if (url.pathname.endsWith("/v1/config"))
      return Response.json({ overrides: { prefix: "fixture" } });
    if (url.pathname.endsWith("/tables"))
      return Response.json({
        identifiers: [
          {
            name: url.pathname.includes("chain_testnet")
              ? "blocks"
              : "providers",
          },
        ],
      });
    return Response.json({
      metadata: {
        snapshots: [
          {
            "timestamp-ms": url.pathname.endsWith("/providers")
              ? now - 30 * 24 * HOUR
              : now,
          },
        ],
      },
    });
  });
}

test("the live reader uses one bounded R2 object and a two-SELECT D1 batch", async () => {
  credentials();
  const fetcher = transport();
  assert.deepEqual(await loadMirrorFreshnessEvidence(fetcher), fixture());
  assert.equal(fetcher.mock.calls.length, 2);
  assert.ok(
    fetcher.mock.calls.every(([url]) => !String(url).includes("/r2-sql/")),
  );
});

test.each(["http", "missing-body", "oversize", "json", "d1"])(
  "unreadable mirror evidence fails closed: %s",
  async (mode) => {
    credentials();
    const fetcher = transport();
    fetcher.mockImplementationOnce(async () => {
      if (mode === "http") return new Response("failed", { status: 503 });
      if (mode === "missing-body") return new Response(null);
      if (mode === "oversize") return new Response(" ".repeat(65537));
      if (mode === "json") return new Response("{");
      return Response.json(fixture().receipt);
    });
    if (mode === "d1")
      fetcher.mockImplementationOnce(async () =>
        Response.json({ success: false }),
      );
    await assert.rejects(loadMirrorFreshnessEvidence(fetcher));
  },
);

test("catalog sweep reconciles quiet tables with source health and preserves testnet checks", async () => {
  credentials();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const fetcher = transport();
  vi.stubGlobal("fetch", fetcher);
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  await checkLakehouseFreshness();
  assert.equal(fetcher.mock.calls.length, 7);
  assert.match(
    output.mock.calls.map(([text]) => String(text)).join(""),
    /0 stale of 2/,
  );
});

test("a catalog sweep cannot use recent snapshots to hide missing source evidence", async () => {
  credentials();
  vi.spyOn(Date, "now").mockReturnValue(now);
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(() => {
    throw Error("failed sweep");
  });
  const fetcher = transport();
  vi.stubGlobal(
    "fetch",
    async (input: string | URL | Request, init?: RequestInit) =>
      String(input).includes("/objects/")
        ? new Response("unavailable", { status: 503 })
        : fetcher(input, init),
  );
  await assert.rejects(checkLakehouseFreshness(), /failed sweep/);
});
