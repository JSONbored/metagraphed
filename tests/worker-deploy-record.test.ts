// Synthetic subprocess replies only: exercising the real checker must never
// fetch git refs, call a provider, or execute Wrangler during this regression.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  older: "a".repeat(40),
  target: "b".repeat(40),
  newestMessage: "-",
  calls: [] as string[],
}));

vi.mock("node:child_process", () => ({
  execFileSync(command: string, args: string[]) {
    fixtures.calls.push([command, ...args].join(" "));
    if (command === "npx") {
      const records = [
        {
          created_on: "2026-01-01T00:00:00Z",
          annotations: { "workers/message": fixtures.older },
          versions: [{ version_id: "synthetic-old-version", percentage: 100 }],
        },
        {
          created_on: "2026-01-01T01:00:00Z",
          annotations: { "workers/message": fixtures.newestMessage },
          versions: [{ version_id: "synthetic-new-version", percentage: 100 }],
        },
      ];
      return args.includes("--json")
        ? JSON.stringify(records)
        : records
            .map(
              (record) =>
                `Created: ${record.created_on}\nMessage: ${record.annotations["workers/message"]}\nVersion(s): (100%) ${record.versions[0]!.version_id}\n    Message: ${fixtures.target}`,
            )
            .join("\n\n");
    }
    if (command === "gh")
      return [
        "metagraphed",
        "metagraphed-data-api",
        "metagraphed-registry-sync-api",
        "metagraphed-wss-lb",
      ]
        .map((worker) => `Workers Builds: ${worker}`)
        .join("\n");
    if (command !== "git") throw new Error(`Unexpected subprocess: ${command}`);
    if (args[0] === "fetch" || args[0] === "merge-base") return "";
    if (args[0] === "log")
      return args.includes("--format=%H") ? fixtures.target : "1767225600";
    if (args[0] === "rev-list")
      return args[1]?.startsWith(fixtures.older) ? fixtures.target : "";
    throw new Error(`Unexpected git operation: ${args[0]}`);
  },
  spawnSync() {
    throw new Error("Unexpected subprocess execution");
  },
}));

import { checkWorkerDeploys } from "../scripts/check-worker-deploys.ts";

describe("deployment identity through the actual checker", () => {
  test("does not report the older SHA as STALE when the newest message is missing", () => {
    fixtures.newestMessage = "-";
    fixtures.calls.length = 0;
    const rows = checkWorkerDeploys(Date.parse("2026-01-01T02:00:00Z"));
    for (const row of rows) {
      assert.equal(row.verdict, "unknown");
      assert.equal(row.deployed, null);
    }
    assert.equal(
      fixtures.calls.filter((call) => call.startsWith("npx ")).length,
      4,
    );
  });

  test("a readable newest identity keeps the existing current verdict", () => {
    fixtures.newestMessage = fixtures.target;
    const rows = checkWorkerDeploys(Date.parse("2026-01-01T02:00:00Z"));
    for (const row of rows) {
      assert.equal(row.deployed, fixtures.target);
      assert.equal(row.verdict, "ok");
    }
  });
});
