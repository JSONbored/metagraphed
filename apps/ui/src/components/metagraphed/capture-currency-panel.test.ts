// Probe failure classifications (#10300).
//
// `is_failure` marks classifications that are NOT failures, and `share` and
// `failure_share` have different denominators. Reading any of the three as the
// others is how a working probe reads as a broken one, or how a classification
// that is 2% of traffic reads as 2% of the problem.
import { describe, expect, it } from "vitest";
import { rankedFailures } from "./capture-currency-panel";
import type { FailureReason } from "@/lib/metagraphed/types";

const reason = (
  classification: string,
  is_failure: boolean,
  failure_share: number | null,
  share: number | null = 0.1,
): FailureReason => ({ classification, is_failure, checks: 100, share, failure_share });

describe("ranking the failure classifications", () => {
  it("EXCLUDES the classifications that are not failures", () => {
    // The route marks non-failure outcomes explicitly. Listing an `ok` among
    // the failures would report a working probe as a broken one.
    const out = rankedFailures([
      reason("ok", false, null),
      reason("timeout", true, 0.6),
      reason("dns", true, 0.4),
    ]);
    expect(out.map((r) => r.classification)).toEqual(["timeout", "dns"]);
  });

  it("ranks by share OF THE FAILURES, not of all checks", () => {
    // `dns` is a bigger slice of all traffic but a smaller slice of the
    // failures. "Why do probes fail" asks the second question.
    const out = rankedFailures([
      reason("dns", true, 0.2, 0.9),
      reason("timeout", true, 0.8, 0.05),
    ]);
    expect(out[0].classification).toBe("timeout");
  });

  it("a null failure_share sorts last rather than throwing", () => {
    const out = rankedFailures([reason("unknown", true, null), reason("timeout", true, 0.5)]);
    expect(out[0].classification).toBe("timeout");
    expect(out).toHaveLength(2);
  });

  it("does not mutate the caller's array", () => {
    const input = [reason("a", true, 0.1), reason("b", true, 0.9)];
    const before = input.map((r) => r.classification);
    rankedFailures(input);
    expect(input.map((r) => r.classification)).toEqual(before);
  });

  it("all-healthy is an empty list, not a fabricated row", () => {
    expect(rankedFailures([reason("ok", false, null)])).toEqual([]);
  });
});
