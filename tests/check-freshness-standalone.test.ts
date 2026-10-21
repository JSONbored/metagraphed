import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { createFreshnessReport } from "../scripts/lib/freshness-report.ts";

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const freshnessEntry = "scripts/check-lakehouse-freshness.ts";
const fixtureWebhook = "https://fixture.invalid/freshness-alert";
const fixtureSource = "b".repeat(40);
const fixtureAccount = `0x${"c".repeat(40)}`;
const fixtureSs58 = `5${"D".repeat(47)}`;
const fixtureRawRecord = [
  "raw-fixture-record",
  "fixture-reader",
  fixtureWebhook,
  fixtureAccount,
  fixtureSs58,
  "203.0.113.77",
].join(" ");

interface StandaloneOptions {
  checkOnly?: boolean;
  report?: boolean;
  args?: string[];
  sourceSha?: string | null;
  expectedReads?: number;
}

interface FreshnessCounts {
  tables: number;
  stale: number;
  known: number;
  regressions: number;
  recovered: number;
  namespaces: { chain: number; chain_testnet: number };
}

interface FreshnessReport {
  schema_version: number;
  source_sha: string | null;
  node_version: string;
  started_at: string;
  finished_at: string;
  mode: "check-only" | "notify";
  status: "ok" | "stale" | "error";
  phase: "arguments" | "catalog" | "evidence" | "evaluation";
  counts: FreshnessCounts | null;
  notification: { mode: "suppressed" | "enabled"; attempted: boolean };
  error_code: ReturnType<typeof createFreshnessReport>["error_code"];
  http_status: number | null;
  cloudflare_code: 10000 | null;
}

// The scheduled checks run with Node alone. A normal installed test process
// would hide an accidental import of a build/prober dependency, so execute the
// real entrypoints from a separate source tree with no ancestor node_modules.
function runStandalone(
  entry: string,
  scenario: string,
  options: StandaloneOptions = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), "freshness-standalone-"));
  try {
    for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
      assert.equal(existsSync(path.join(ancestor, "node_modules")), false);
      if (path.dirname(ancestor) === ancestor) break;
    }
    for (const directory of ["scripts", "src"]) {
      cpSync(path.join(sourceRoot, directory), path.join(root, directory), {
        recursive: true,
      });
    }
    writeFileSync(
      path.join(root, "package.json"),
      readFileSync(path.join(sourceRoot, "package.json")),
    );
    writeFileSync(
      path.join(root, "wrangler.jsonc"),
      '{ // fixture config\n "d1_databases": [{ "binding": "D1_STATE", "database_id": "11111111-1111-1111-1111-111111111111", }],\n "routes": ["example.invalid/*",],\n}',
    );
    const reportPath = path.join(root, "freshness-report.json");
    const ledgerPath = path.join(root, "fixture-requests.json");
    const earlyReads: Record<string, number> = {
      "credential-failure": 0,
      "empty-lanes": 1,
      "missing-inventory": 1,
      malformed: 1,
      "transport-failure": 1,
      "http-failure": 1,
      "response-failure": 1,
    };
    const expectedReads = options.expectedReads ?? earlyReads[scenario] ?? 2;
    const notificationFailures = [
      "incomplete",
      "stale",
      "missing-source",
      "unclassified",
      "empty-snapshots",
    ];
    const expectedAlerts = Number(
      !options.checkOnly && notificationFailures.includes(scenario),
    );
    const preload = `
      import assert from "node:assert/strict";
      import { writeFileSync } from "node:fs";
      import { createRequire } from "node:module";
      assert.throws(() => createRequire(import.meta.url).resolve("undici"),
        { code: "MODULE_NOT_FOUND" });
      const now = Date.now();
      const scenario = ${JSON.stringify(scenario)};
      const requests = [];
      let calls = 0, alerts = 0, unexpected = 0;
      globalThis.fetch = async (input, init) => {
        try {
        if (String(input) === ${JSON.stringify(fixtureWebhook)}) {
          alerts += 1;
          assert.equal(${Boolean(options.checkOnly)}, false);
          assert.equal(init.method, "POST");
          assert.equal(new Headers(init.headers).get("content-type"), "application/json");
          assert.equal(typeof JSON.parse(init.body).content, "string");
          return new Response(null, { status: 204 });
        }
        const endpoint = "https://api.cloudflare.com/client/v4/accounts/" +
          "a".repeat(32) + "/d1/database/11111111-1111-1111-1111-111111111111/query";
        if (String(input) !== endpoint) {
          throw new Error("unexpected fixture endpoint");
        }
        calls += 1;
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-reader");
        const { batch } = JSON.parse(init.body);
        assert.ok(batch.every(({ sql }) => sql.startsWith("SELECT ")));
        requests.push(batch);
        if (scenario === "transport-failure") {
          // Reject outside the fixture assertion catch: this is the intended fault.
          return Promise.reject(new Error(${JSON.stringify(fixtureRawRecord)}));
        }
        if (scenario === "http-failure") {
          return Response.json({
            success: false,
            errors: [{ code: 10000, message: ${JSON.stringify(fixtureRawRecord)} }],
            result: ${JSON.stringify(fixtureRawRecord)},
          }, { status: 401, statusText: ${JSON.stringify(fixtureRawRecord)} });
        }
        if (scenario === "response-failure")
          return new Response(${JSON.stringify(fixtureRawRecord)});
        if (scenario === "empty-lanes") {
          assert.equal(calls, 1);
          assert.equal(batch.length, 1);
          assert.match(batch[0].sql, /FROM generated_artifacts/);
          return Response.json({ success: true, result: [{ success: true, results: [] }] });
        }
        if (calls === 1) {
          assert.equal(batch.length, 1);
          assert.match(batch[0].sql, /FROM iceberg_catalog_tables/);
          assert.match(batch[0].sql, /LIMIT 1001$/);
          const rows = [
            { namespace: "chain", name: "compute_declarations" },
            ...(scenario === "unclassified" ?
              [{ namespace: "chain", name: "fixture_unclassified" }] : []),
            ...(scenario === "missing-inventory" ? [] :
              [{ namespace: "chain_testnet", name: "blocks" }]),
          ].map(row => ({ ...row, metadata_summary: JSON.stringify({
            "current-schema-id": 0,
            schemas: [{ "schema-id": 0, fields: [] }],
            snapshots: scenario === "empty-snapshots" && row.namespace === "chain_testnet" ? [] :
              [{ "timestamp-ms": scenario === "stale" && row.namespace === "chain_testnet" ?
                now - 7 * 3600000 : now }],
          }) }));
          if (scenario === "malformed")
            rows[0].metadata_summary = ${JSON.stringify(fixtureRawRecord)};
          return Response.json({ success: true, result: [{ success: true, results: rows }] });
        }
        assert.equal(calls, 2);
        assert.equal(batch.length, 5);
        assert.match(batch[0].sql, /FROM generated_artifacts/);
        const receipt = {
          ok: true, complete: scenario !== "incomplete", namespace: "chain",
          checked_at: new Date(now).toISOString(), failures: {},
          tables: { compute_declarations: "compute_declarations: unchanged (1 rows), no snapshot" },
          tables_expected: 1, tables_reported: 1,
        };
        const results = [
          [{ payload: JSON.stringify(receipt) }],
          [{ lane: "compute-declarations", verdict: "ok", checked_at: now }],
          [{ newest: scenario === "missing-source" ? null : now }],
          [{ newest: now }], [{ newest: now }],
        ];
        return Response.json({ success: true,
          result: results.map(results => ({ success: true, results })) });
        } catch (error) {
          unexpected += 1;
          throw error;
        }
      };
      process.on("exit", () => {
        assert.equal(calls, ${expectedReads});
        assert.equal(alerts, ${expectedAlerts});
        assert.equal(unexpected, 0);
        writeFileSync(${JSON.stringify(ledgerPath)}, JSON.stringify({ requests, alerts }));
        process.stdout.write("fixture-complete:" + scenario + ":" + calls + ":" + alerts + "\\n");
      });
    `;
    const preloadPath = path.join(root, "fixture-preload.ts");
    writeFileSync(preloadPath, preload);
    const childEnv: Record<string, string | undefined> = {
      CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
      CLOUDFLARE_D1_DATABASE_ID: "11111111-1111-1111-1111-111111111111",
      CLOUDFLARE_API_TOKEN:
        scenario === "credential-failure" ? undefined : "fixture-reader",
      LIVE_ALERT_WEBHOOK_URL: fixtureWebhook,
      GITHUB_SHA:
        options.sourceSha === null
          ? undefined
          : (options.sourceSha ?? fixtureSource),
      NODE_NO_WARNINGS: "1",
    };
    const args = [
      ...(options.report ? ["--report", reportPath] : []),
      ...(options.checkOnly ? ["--check-only"] : []),
      ...(options.args ?? []),
    ];
    const result = spawnSync(
      process.execPath,
      ["--import", preloadPath, path.join(root, entry), ...args],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        // Generated Worker bindings augment ProcessEnv with application fields;
        // those bindings do not belong in this isolated Node environment.
        env: childEnv as NodeJS.ProcessEnv,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.ok(
      result.stdout.includes(
        `fixture-complete:${scenario}:${expectedReads}:${expectedAlerts}`,
      ),
      result.stderr,
    );
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      requests: unknown[];
      alerts: number;
    };
    return {
      ...result,
      ...ledger,
      reportText: existsSync(reportPath)
        ? readFileSync(reportPath, "utf8")
        : null,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("freshness reaches bounded reads without installed dependencies", () => {
  const result = runStandalone(
    "scripts/check-lakehouse-freshness.ts",
    "healthy",
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /lakehouse-freshness: 0 stale of 2/);
});

const invalidEvidence: [string, RegExp][] = [
  ["incomplete", /mirror completion is missing, failed, incomplete, or stale/],
  [
    "missing-inventory",
    /Catalog table inventory is unavailable: chain_testnet/,
  ],
];
test.each(invalidEvidence)("rejects %s evidence", (scenario, reason) => {
  const result = runStandalone(
    "scripts/check-lakehouse-freshness.ts",
    scenario,
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, reason);
});

test("lane checker rejects an empty census without dependencies", () => {
  const result = runStandalone("scripts/check-lane-status.ts", "empty-lanes");
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /lane-status: NO D1 status records found/);
});

function counts(tables = 2, stale = 0, chain = 1): FreshnessCounts {
  return {
    tables,
    stale,
    known: 0,
    regressions: stale,
    recovered: 0,
    namespaces: { chain, chain_testnet: 1 },
  };
}

function readReport(
  result: { reportText: string | null; stderr: string; alerts: number },
  checkOnly: boolean,
  sourceSha: string | null = fixtureSource,
): FreshnessReport {
  assert.notEqual(result.reportText, null, result.stderr);
  const text = result.reportText!;
  assert.ok(Buffer.byteLength(text, "utf8") <= 4096);
  const report = JSON.parse(text) as FreshnessReport;
  assert.deepEqual(Object.keys(report).sort(), [
    "cloudflare_code",
    "counts",
    "error_code",
    "finished_at",
    "http_status",
    "mode",
    "node_version",
    "notification",
    "phase",
    "schema_version",
    "source_sha",
    "started_at",
    "status",
  ]);
  assert.equal(report.schema_version, 2);
  assert.equal(report.source_sha, sourceSha);
  if (report.source_sha !== null)
    assert.match(report.source_sha, /^[a-fA-F0-9]{40}$/);
  assert.equal(report.node_version, process.version);
  assert.equal(report.started_at, new Date(report.started_at).toISOString());
  assert.equal(report.finished_at, new Date(report.finished_at).toISOString());
  assert.ok(Date.parse(report.finished_at) >= Date.parse(report.started_at));
  assert.equal(report.mode, checkOnly ? "check-only" : "notify");
  assert.deepEqual(Object.keys(report.notification).sort(), [
    "attempted",
    "mode",
  ]);
  assert.equal(report.notification.mode, checkOnly ? "suppressed" : "enabled");
  assert.equal(report.notification.attempted, result.alerts > 0);
  if (report.error_code !== "d1_http") {
    assert.equal(report.http_status, null);
    assert.equal(report.cloudflare_code, null);
  }
  if (checkOnly) assert.equal(result.alerts, 0);
  if (report.counts !== null) {
    assert.deepEqual(Object.keys(report.counts).sort(), [
      "known",
      "namespaces",
      "recovered",
      "regressions",
      "stale",
      "tables",
    ]);
    assert.deepEqual(Object.keys(report.counts.namespaces).sort(), [
      "chain",
      "chain_testnet",
    ]);
    for (const value of [
      report.counts.tables,
      report.counts.stale,
      report.counts.known,
      report.counts.regressions,
      report.counts.recovered,
      report.counts.namespaces.chain,
      report.counts.namespaces.chain_testnet,
    ]) {
      assert.ok(Number.isSafeInteger(value) && value >= 0);
    }
  }
  for (const forbidden of [
    fixtureWebhook,
    fixtureAccount,
    fixtureSs58,
    "fixture-reader",
    "a".repeat(32),
    "11111111-1111-1111-1111-111111111111",
    "203.0.113.77",
    "raw-fixture-record",
    "compute_declarations",
    "fixture_unclassified",
    "blocks",
    "https://",
    "Bearer",
  ]) {
    assert.equal(text.includes(forbidden), false, forbidden);
  }
  return report;
}

test("check-only writes a bounded complete report", () => {
  const result = runStandalone(freshnessEntry, "healthy", {
    checkOnly: true,
    report: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const report = readReport(result, true);
  assert.equal(report.status, "ok");
  assert.equal(report.phase, "evaluation");
  assert.equal(report.error_code, null);
  assert.deepEqual(report.counts, counts());
  assert.equal(result.requests.length, 2);
});

const failedSweeps = [
  ["incomplete", counts(2, 1)],
  ["stale", counts(2, 1)],
  ["missing-source", counts(2, 1)],
  ["unclassified", counts(3, 1, 2)],
  ["empty-snapshots", counts(2, 1)],
] as const;

test.each(failedSweeps)("check-only rejects %s", (scenario, expected) => {
  const result = runStandalone(freshnessEntry, scenario, {
    checkOnly: true,
    report: true,
  });
  assert.equal(result.status, 1, result.stderr);
  const report = readReport(result, true);
  assert.equal(report.status, "stale");
  assert.equal(report.phase, "evaluation");
  assert.equal(report.error_code, null);
  assert.deepEqual(report.counts, expected);
});

test.each([
  ["missing-inventory", "catalog_inventory"],
  ["malformed", "catalog_metadata"],
  ["credential-failure", "d1_credentials"],
  ["transport-failure", "d1_transport"],
  ["http-failure", "d1_http"],
  ["response-failure", "d1_response"],
])(
  "check-only sanitizes %s errors without inventing completed counts",
  (scenario, code) => {
    const result = runStandalone(freshnessEntry, scenario, {
      checkOnly: true,
      report: true,
    });
    assert.equal(result.status, 1, result.stderr);
    const report = readReport(result, true);
    assert.equal(report.status, "error");
    assert.equal(report.phase, "catalog");
    assert.equal(report.counts, null);
    assert.equal(report.error_code, code);
    assert.equal(report.http_status, scenario === "http-failure" ? 401 : null);
    assert.equal(
      report.cloudflare_code,
      scenario === "http-failure" ? 10000 : null,
    );
    assert.equal(result.alerts, 0);
    assert.equal(result.stderr, "lakehouse-freshness: check failed.\n");
  },
);

test("notification mode preserves freshness reads", () => {
  const notified = runStandalone(freshnessEntry, "incomplete", {
    report: true,
  });
  const suppressed = runStandalone(freshnessEntry, "incomplete", {
    checkOnly: true,
    report: true,
  });
  assert.equal(notified.status, 1);
  assert.equal(suppressed.status, 1);
  assert.equal(notified.alerts, 1);
  assert.equal(suppressed.alerts, 0);
  assert.deepEqual(notified.requests, suppressed.requests);
  const notifiedReport = readReport(notified, false);
  const suppressedReport = readReport(suppressed, true);
  assert.equal(notifiedReport.status, "stale");
  assert.equal(suppressedReport.status, "stale");
  assert.deepEqual(notifiedReport.counts, suppressedReport.counts);
});

test.each([
  ["unknown", ["--unexpected"]],
  ["duplicate check-only", ["--check-only"]],
  ["duplicate report", ["--report", "other-report.json"]],
] as const)("%s arguments fail before reads", (_label, args) => {
  const result = runStandalone(freshnessEntry, "healthy", {
    checkOnly: true,
    report: true,
    args: [...args],
    expectedReads: 0,
  });
  assert.equal(result.status, 1);
  const report = readReport(result, true);
  assert.equal(report.status, "error");
  assert.equal(report.phase, "arguments");
  assert.equal(report.counts, null);
  assert.equal(report.error_code, "invalid_arguments");
});

test("a missing report argument fails before any read", () => {
  const result = runStandalone(freshnessEntry, "healthy", {
    checkOnly: true,
    args: ["--report"],
    expectedReads: 0,
  });
  assert.equal(result.status, 1);
  assert.equal(result.reportText, null);
  assert.match(result.stderr, /Invalid lakehouse freshness arguments/);
});

test("a failed report write cannot turn a completed check green", () => {
  const result = runStandalone(freshnessEntry, "healthy", {
    checkOnly: true,
    args: ["--report", "."],
  });
  assert.equal(result.status, 1);
  assert.equal(result.reportText, null);
  assert.match(result.stdout, /lakehouse-freshness: 0 stale of 2/);
});

test.each([null, fixtureWebhook, fixtureAccount])(
  "reports replace unavailable or invalid source identities with null (%#)",
  (sourceSha) => {
    const result = runStandalone(freshnessEntry, "healthy", {
      checkOnly: true,
      report: true,
      sourceSha,
    });
    assert.equal(result.status, 0);
    assert.equal(readReport(result, true, null).source_sha, null);
  },
);

function reportFailure(error: unknown): FreshnessReport {
  const report = createFreshnessReport({
    state: {
      startedAt: new Date(0).toISOString(),
      phase: "catalog",
      counts: null,
      notificationAttempted: false,
    },
    status: "error",
    checkOnly: true,
    sourceSha: fixtureSource,
    nodeVersion: process.version,
    finishedAt: new Date(1).toISOString(),
    error,
  });
  return readReport(
    { reportText: JSON.stringify(report), stderr: "", alerts: 0 },
    true,
  );
}

test("freshness diagnostics accept only exact internal failure messages", () => {
  const cases = [
    ["Invalid lakehouse freshness arguments", "invalid_arguments"],
    ["D1 maintenance response exceeds 4 MiB", "d1_response"],
    [
      "D1 maintenance batch failed or returned an invalid result",
      "d1_response",
    ],
    [
      "Catalog metadata inventory is empty or exceeds its bound",
      "catalog_inventory",
    ],
    ["Catalog metadata inventory repeats a table", "catalog_inventory"],
    ["Catalog table inventory is unavailable: chain", "catalog_inventory"],
    ["Catalog metadata row is invalid", "catalog_metadata"],
    ["Catalog schema or freshness metadata is incomplete", "catalog_metadata"],
  ];
  for (const [message, code] of cases) {
    assert.equal(reportFailure(new Error(message)).error_code, code);
    assert.equal(
      reportFailure(new Error(`${message}; ${fixtureRawRecord}`)).error_code,
      "check_failed",
    );
  }
});

test("freshness diagnostics retain only allowlisted HTTP status and authentication code", () => {
  for (const status of [
    204, 400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504,
  ]) {
    for (const code of [false, true]) {
      const message =
        `D1 maintenance request failed with HTTP ${status}` +
        (code ? "; Cloudflare error codes: 10000" : "");
      const report = reportFailure(new Error(message));
      assert.equal(report.error_code, "d1_http");
      assert.equal(report.http_status, status);
      assert.equal(report.cloudflare_code, code ? 10000 : null);
    }
  }
});

test("freshness diagnostics reject hostile errors without serializing raw details", () => {
  const hostileAccessor = new Error();
  Object.defineProperty(hostileAccessor, "message", {
    get() {
      throw new Error(fixtureRawRecord);
    },
  });
  const messages = [
    fixtureRawRecord,
    fixtureRawRecord.repeat(20),
    `D1 maintenance request failed with HTTP 401; ${fixtureRawRecord}`,
    "D1 maintenance request failed with HTTP 401; Cloudflare error codes: 9109",
    "D1 maintenance request failed with HTTP 401; Cloudflare error codes: 10000\n",
    "D1 maintenance request failed with HTTP 777",
    "D1 maintenance request failed with HTTP 418",
    "Catalog table inventory is unavailable: private_table",
  ];
  for (const error of [
    ...messages.map(
      (message) => new Error(message, { cause: fixtureRawRecord }),
    ),
    fixtureRawRecord,
    {
      message: "D1 maintenance request failed with HTTP 401",
      token: fixtureRawRecord,
    },
    Object.assign(new Error(), { message: { secret: fixtureRawRecord } }),
    hostileAccessor,
    null,
    undefined,
  ]) {
    const report = reportFailure(error);
    assert.equal(report.error_code, "check_failed");
    assert.equal(report.http_status, null);
    assert.equal(report.cloudflare_code, null);
  }
  const known = new Error("D1 maintenance request failed with HTTP 401", {
    cause: fixtureRawRecord,
  });
  Object.assign(known, { stack: fixtureRawRecord, token: fixtureRawRecord });
  assert.equal(reportFailure(known).http_status, 401);
});

test.each(["error", "stale"] as const)(
  "the report builder excludes raw fields for a late %s outcome",
  async (status) => {
    const { createFreshnessReport } =
      await import("../scripts/lib/freshness-report.ts");
    const state = {
      startedAt: new Date(0).toISOString(),
      phase: "evaluation" as const,
      counts: { ...counts(2, 1), account: fixtureAccount },
      notificationAttempted: false,
      error: fixtureRawRecord,
      record: { address: fixtureSs58 },
    };
    const report = createFreshnessReport({
      state,
      status,
      checkOnly: true,
      sourceSha: fixtureSource,
      nodeVersion: process.version,
      finishedAt: new Date(1).toISOString(),
      error: new Error(fixtureRawRecord),
    });
    readReport(
      { reportText: JSON.stringify(report), stderr: "", alerts: 0 },
      true,
    );
    assert.equal(report.status, status);
    assert.deepEqual(report.counts, status === "error" ? null : counts(2, 1));
    assert.equal(report.error_code, status === "error" ? "check_failed" : null);
  },
);
