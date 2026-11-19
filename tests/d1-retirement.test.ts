import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { WORKER_CONFIGS } from "../scripts/check-worker-deploys.ts";
import { repoRoot } from "../scripts/lib.ts";
import {
  d1RetirementFindings,
  main,
} from "../scripts/validate-d1-retirement.ts";

it("names each way a deployed config keeps D1 alive, including env sections", () => {
  const findings = d1RetirementFindings(
    "w.jsonc",
    JSON.stringify({
      d1_databases: [
        { binding: "D1_STATE", database_name: "metagraphed-state" },
      ],
      vars: {
        D1_STATE_TABLES: "alerts, webhooks",
        D1_EXPORT_REVISIONS: "enabled",
      },
      env: {
        staging: { d1_databases: [{ binding: "X", database_name: "y" }] },
      },
    }),
  );
  expect(findings).toEqual([
    "w.jsonc: d1_databases binds D1_STATE (metagraphed-state)",
    "w.jsonc: vars.D1_STATE_TABLES owns 2 tables",
    "w.jsonc: vars.D1_EXPORT_REVISIONS is enabled",
    "w.jsonc: env.staging.d1_databases binds X (y)",
  ]);
});

it("passes a config with no D1 surface, and an empty or whitespace table list selects nothing", () => {
  expect(
    d1RetirementFindings(
      "w.jsonc",
      JSON.stringify({
        d1_databases: [],
        vars: { D1_STATE_TABLES: "  ", D1_EXPORT_REVISIONS: "disabled" },
      }),
    ),
  ).toEqual([]);
});

it("refuses an unreadable or non-object config instead of reading it as nothing to retire", () => {
  for (const raw of ["{broken", JSON.stringify(null), JSON.stringify([])])
    expect(d1RetirementFindings("w.jsonc", raw)).toEqual([
      "w.jsonc: unreadable wrangler config counts as a live D1 consumer",
    ]);
});

it("refuses today's deployed estate by name — this assertion flips with the cutover config change", () => {
  // Pre-cutover, the deployed configs still carry D1 (metagraphed-infra#884
  // gate 9): the retirement step must get a refusal. The cutover PR that
  // drops the bindings flips main() to 0 and updates this assertion in the
  // same reviewed diff, which is exactly the evidence the gate wants.
  expect(main()).toBe(1);
  expect(main(true)).toBe(0);
  const carrying = WORKER_CONFIGS.filter((config) => {
    try {
      return (
        d1RetirementFindings(
          config,
          readFileSync(path.join(repoRoot, config), "utf8"),
        ).length > 0
      );
    } catch {
      return false;
    }
  });
  expect(carrying).toContain("wrangler.jsonc");
  expect(carrying).toContain("wrangler.data.jsonc");
  expect(carrying).toContain("wrangler.registry.jsonc");
});

it("both modes flip together when the estate goes D1-free, and bare mode passes then", () => {
  const clean = () => JSON.stringify({ vars: {} });
  const carrying = () =>
    JSON.stringify({ d1_databases: [{ binding: "D1_STATE" }] });
  // The era guard fails the moment the fallthrough disappears, forcing the
  // cutover diff to drop --pre-cutover; the bare refusal inverts with it.
  expect(main(true, clean)).toBe(1);
  expect(main(false, clean)).toBe(0);
  expect(main(true, carrying)).toBe(0);
  expect(main(false, carrying)).toBe(1);
  // A config the repo no longer ships reads as retired in both modes.
  expect(main(false, () => null)).toBe(0);
  expect(main(true, () => null)).toBe(1);
  // A config that exists but cannot be read refuses in both modes: bare
  // because it may hide a live consumer, pre-cutover because an unknown is
  // not a declared fallthrough.
  const throwing = () => {
    throw new Error("EACCES: permission denied");
  };
  expect(main(false, throwing)).toBe(1);
  expect(main(true, throwing)).toBe(1);
});
