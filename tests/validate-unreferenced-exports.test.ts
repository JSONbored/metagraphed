// The unreferenced-export ratchet's counting (#10292).
//
// The gate shells out to knip and calls process.exit, so what is unit-tested is
// the part that decides: how a knip report becomes a number and a per-directory
// breakdown. The knip run itself is exercised by CI, where a wrong count fails
// the ratchet in one direction or the other.
//
// The empty-report case matters most. knip emits `{"issues":[]}` when it finds
// nothing, and a counter that read that as "zero, therefore an improvement"
// would demand the ceiling be lowered to 0 -- locking in a number nobody
// earned, on a run that may simply have been misconfigured.

import { describe, expect, it } from "vitest";
import { countUnreferenced } from "../scripts/validate-unreferenced-exports.ts";

describe("counting a knip report", () => {
  it("sums exports and types across files", () => {
    const { total } = countUnreferenced({
      issues: [
        { file: "src/a.ts", exports: [1, 2], types: [1] },
        { file: "src/b.ts", exports: [], types: [1, 2, 3] },
      ],
    });
    expect(total).toBe(6);
  });

  it("groups by the first two path segments", () => {
    const { byDirectory } = countUnreferenced({
      issues: [
        { file: "schemas-src/routes/subnets.ts", types: [1, 2] },
        { file: "schemas-src/routes/health.ts", types: [1] },
        { file: "schemas-src/mcp-tools/shared.ts", exports: [1] },
        { file: "src/tracing.ts", exports: [1] },
      ],
    });
    expect(Object.fromEntries(byDirectory)).toEqual({
      "schemas-src/routes": 3,
      "schemas-src/mcp-tools": 1,
      "src/tracing.ts": 1,
    });
  });

  it("ignores a file knip listed with no findings", () => {
    const { total, byDirectory } = countUnreferenced({
      issues: [{ file: "src/a.ts", exports: [], types: [] }],
    });
    expect(total).toBe(0);
    expect(byDirectory.size).toBe(0);
  });

  it("treats a report with no issues array as zero rather than throwing", () => {
    expect(countUnreferenced({}).total).toBe(0);
  });

  // knip omits the keys entirely when a category is empty, so a counter that
  // assumed both were present would throw on a perfectly ordinary report.
  it("tolerates missing exports/types keys", () => {
    expect(countUnreferenced({ issues: [{ file: "src/a.ts" }] }).total).toBe(0);
  });
});
