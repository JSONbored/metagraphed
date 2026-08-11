// A route that reports several INDEPENDENT faults must fingerprint them apart.
//
// THE FAILURE THIS EXISTS TO STOP, which no unit test of a single watchdog can
// reach. `recordExceptionEvent` throttles on `route:fingerprintDetail:type` --
// the same key PostHog groups by -- so two unrelated faults filed under one
// route share a storm-guard window. The louder one holds it open and the
// quieter one is dropped as a repeat.
//
// It is not hypothetical, and it is not cheap when it happens:
//
//   * #10673: `lane-alarm` fingerprinted every lane the same, so the first
//     alarming lane consumed the window and the other three in the same tick
//     vanished. Measured: exactly one event per tick for six consecutive hours
//     while the watchdog's own verdict read "4 alarming".
//   * #10813: `watchdog:safe-mode` filed `safe_mode_active` -- the chain
//     halting, the one condition that monitor exists for -- under the same
//     fingerprint as `watchdog_unreachable`, its own probe failing with an
//     HTTP 522. Sixteen of those 522s in four days, every one holding the
//     window open against the signal that matters.
//
// So this reads the capture sites back out of the source and holds the rule
// structurally: more than one `errorCode` on a `route` means each site must
// carry a `fingerprintDetail`. Nothing is listed here that the modules do not
// already state themselves -- a list in this file would be one more copy to
// forget.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, test } from "vitest";

/** Every tracked source file that could hold a capture site. */
function sourceFiles(): string[] {
  return execFileSync("git", ["ls-files", "src/*.ts", "workers/*.ts"], {
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

interface Site {
  file: string;
  errorCode: string;
  hasDetail: boolean;
}

/**
 * The capture sites in one module, keyed by route.
 *
 * Matched on the OBJECT LITERAL rather than on the call, because these are
 * written as `record(env, { route, errorCode })` through half a dozen different
 * local aliases (`record`, `capture`, `deps.recordExceptionEvent`) and a matcher
 * keyed on the callee name would silently miss whichever alias came next.
 */
function captureSites(source: string, file: string): Map<string, Site[]> {
  const byRoute = new Map<string, Site[]>();
  // POSITION-BASED, not one sweeping regex. The obvious form --
  // `/route:\s*"([^"]+)"([\s\S]{0,N}?)errorCode:\s*"([^"]+)"/g` -- looks
  // equivalent and is not: `matchAll` resumes from the END of each match, so a
  // match that ran past its own literal into a LATER site consumes that site
  // too, and skipping the bad match silently drops the good one. That is how
  // the first draft of this gate found one of safe-mode's two codes and
  // reported the route as single-fault, i.e. compliant.
  for (const match of source.matchAll(/route:\s*"([^"]+)"/g)) {
    const from = match.index! + match[0].length;
    const codeAt = source.indexOf("errorCode:", from);
    if (codeAt === -1) continue;
    const between = source.slice(from, codeAt);
    // Another `route:` in between means this literal has no errorCode of its
    // own -- the one we found belongs to a later site, which gets its own turn.
    if (/route:\s*"/.test(between)) continue;
    const code = /errorCode:\s*"([^"]+)"/.exec(source.slice(codeAt));
    if (!code) continue;
    const sites = byRoute.get(match[1]!) ?? [];
    sites.push({
      file,
      errorCode: code[1]!,
      hasDetail: between.includes("fingerprintDetail:"),
    });
    byRoute.set(match[1]!, sites);
  }
  return byRoute;
}

describe("a route with several faults fingerprints them apart", () => {
  test("no multi-fault route leaves its sites sharing one throttle window", () => {
    // Routes are collected ACROSS files: a route reported from two modules is
    // still one fingerprint, and that is exactly the case a per-file check
    // would miss.
    const byRoute = new Map<string, Site[]>();
    for (const file of sourceFiles()) {
      for (const [route, sites] of captureSites(
        readFileSync(file, "utf8"),
        file,
      )) {
        byRoute.set(route, [...(byRoute.get(route) ?? []), ...sites]);
      }
    }

    const offenders: string[] = [];
    for (const [route, sites] of byRoute) {
      const codes = new Set(sites.map((site) => site.errorCode));
      if (codes.size < 2) continue;
      const undetailed = sites.filter((site) => !site.hasDetail);
      if (undetailed.length === 0) continue;
      offenders.push(
        `${route} reports ${[...codes].sort().join(", ")} but ` +
          `${undetailed.length} site(s) carry no fingerprintDetail ` +
          `(${[...new Set(undetailed.map((site) => site.file))].join(", ")})`,
      );
    }

    assert.deepEqual(
      offenders,
      [],
      "these routes let one fault throttle another:\n  " +
        offenders.join("\n  "),
    );
  });

  test("the scan actually finds the sites it is checking", () => {
    // A structural gate that matches nothing passes forever. Anchored on a
    // route known to report two subjects -- if this stops finding them, the
    // matcher has drifted from how these sites are written and the check above
    // is vacuous.
    const sites = captureSites(
      readFileSync("src/safe-mode-watchdog.ts", "utf8"),
      "src/safe-mode-watchdog.ts",
    );
    const safeMode = sites.get("watchdog:safe-mode");
    assert.ok(safeMode, "watchdog:safe-mode has capture sites");
    assert.ok(
      safeMode.length >= 2,
      `expected several capture sites, found ${safeMode.length}`,
    );
    assert.deepEqual(
      new Set(safeMode.map((site) => site.errorCode)),
      new Set(["safe_mode_active", "watchdog_unreachable"]),
    );
  });
});
