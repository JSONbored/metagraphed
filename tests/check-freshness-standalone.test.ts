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

const sourceRoot = fileURLToPath(new URL("..", import.meta.url));

// The scheduled checks run with Node alone. A normal installed test process
// would hide an accidental import of a build/prober dependency, so execute the
// real entrypoints from a separate source tree with no ancestor node_modules.
function runStandalone(entry: string, scenario: string) {
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
    const preload = `
      import assert from "node:assert/strict";
      import { createRequire } from "node:module";
      assert.throws(() => createRequire(import.meta.url).resolve("undici"),
        { code: "MODULE_NOT_FOUND" });
      const now = Date.now();
      const scenario = ${JSON.stringify(scenario)};
      let calls = 0;
      globalThis.fetch = async (input, init) => {
        calls += 1;
        assert.equal(String(input),
          "https://api.cloudflare.com/client/v4/accounts/" + "a".repeat(32) +
          "/d1/database/11111111-1111-1111-1111-111111111111/query");
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-reader");
        const { batch } = JSON.parse(init.body);
        assert.ok(batch.every(({ sql }) => sql.startsWith("SELECT ")));
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
            ...(scenario === "missing-inventory" ? [] :
              [{ namespace: "chain_testnet", name: "blocks" }]),
          ].map(row => ({ ...row, metadata_summary: JSON.stringify({
            "current-schema-id": 0,
            schemas: [{ "schema-id": 0, fields: [] }],
            snapshots: [{ "timestamp-ms": now }],
          }) }));
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
          [{ newest: now }], [{ newest: now }], [{ newest: now }],
        ];
        return Response.json({ success: true,
          result: results.map(results => ({ success: true, results })) });
      };
      process.on("exit", () => {
        const expected = ["empty-lanes", "missing-inventory"].includes(scenario) ? 1 : 2;
        assert.equal(calls, expected);
        process.stdout.write("fixture-complete:" + scenario + ":" + calls + "\\n");
      });
    `;
    const preloadPath = path.join(root, "fixture-preload.ts");
    writeFileSync(preloadPath, preload);
    const result = spawnSync(
      process.execPath,
      ["--import", preloadPath, path.join(root, entry)],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: {
          CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
          CLOUDFLARE_D1_DATABASE_ID:
            "11111111-1111-1111-1111-111111111111",
          CLOUDFLARE_API_TOKEN: "fixture-reader",
          NODE_NO_WARNINGS: "1",
        },
      },
    );
    assert.equal(result.error, undefined);
    assert.ok(
      result.stdout.includes(`fixture-complete:${scenario}:`),
      result.stderr,
    );
    return result;
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
