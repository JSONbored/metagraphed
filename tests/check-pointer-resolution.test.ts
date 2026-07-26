import assert from "node:assert/strict";
import { test } from "vitest";

import {
  evaluateResolution,
  type ProbeResult,
} from "../scripts/check-pointer-resolution.ts";

// #8287: the alarm's whole value is the burst/sustained and healthy/degraded
// boundary. `prefix` must read as HEALTHY -- it is the correct answer for a
// pre-#8277 pointer, for artifacts the run manifest does not name, and for
// stable-latest artifacts that bypass the pointer by design. An alarm that
// fires on `prefix` would fire constantly and get muted, which is the exact
// failure mode this issue exists to prevent.

const p = (
  path: string,
  resolution: ProbeResult["resolution"],
): ProbeResult => ({
  path,
  resolution,
});

test("all-manifest resolution is healthy", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "manifest"),
    p("/api/v1/coverage", "manifest"),
  ]);
  assert.equal(v.status, "healthy");
});

test("prefix resolution is healthy, not degraded", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "prefix"),
    p("/api/v1/coverage", "prefix"),
  ]);
  assert.equal(v.status, "healthy");
});

test("a mix of manifest and prefix is healthy", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "manifest"),
    p("/api/v1/coverage", "prefix"),
  ]);
  assert.equal(v.status, "healthy");
});

test("a SINGLE fallback is degraded — the pointer is per-key, so one is enough", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "manifest"),
    p("/api/v1/coverage", "fallback"),
    p("/api/v1/providers", "manifest"),
  ]);
  assert.equal(v.status, "degraded");
  assert.deepEqual(v.status === "degraded" ? v.fallbackPaths : null, [
    "/api/v1/coverage",
  ]);
});

test("every artifact on the fallback reports all of them, for triage", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "fallback"),
    p("/api/v1/coverage", "fallback"),
  ]);
  assert.equal(v.status, "degraded");
  assert.equal(v.status === "degraded" ? v.fallbackPaths.length : 0, 2);
});

test("fallback wins over unknown — a real signal is not masked by a missing header", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "unknown"),
    p("/api/v1/coverage", "fallback"),
  ]);
  assert.equal(v.status, "degraded");
});

test("all-unknown is unknown, not a false green", () => {
  const v = evaluateResolution([
    p("/api/v1/subnets", "unknown"),
    p("/api/v1/coverage", "unknown"),
  ]);
  assert.equal(v.status, "unknown");
  assert.match(
    v.status === "unknown" ? v.reason : "",
    /x-metagraph-artifact-resolution/,
  );
});

test("no probes at all is unknown, never healthy", () => {
  const v = evaluateResolution([]);
  assert.equal(v.status, "unknown");
});

// The probe must target the RAW artifact routes. Verified against production:
// the artifact diagnostics (source / storage-tier / resolution) are set by the
// `/metagraph/*.json` response builder only -- the /api/v1 envelope builder
// never carried them, so an /api/v1 probe reported `unknown` forever and the
// alarm was silently blind. Pin the path shape so that can't regress.
test("the default probe paths are raw artifact routes, not /api/v1", async () => {
  const src = await import("node:fs").then((fs) =>
    fs.readFileSync("scripts/check-pointer-resolution.ts", "utf8"),
  );
  const block = src.slice(
    src.indexOf("const DEFAULT_PROBE_PATHS"),
    src.indexOf("];", src.indexOf("const DEFAULT_PROBE_PATHS")),
  );
  assert.match(block, /"\/metagraph\/[a-z-]+\.json"/);
  assert.doesNotMatch(block, /"\/api\/v1\//);
});
