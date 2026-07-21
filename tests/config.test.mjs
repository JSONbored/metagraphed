// Unit tests for the shared helpers in workers/config.mjs (#2568):
//   - clampInt(raw, def, min, max)        — bounded page/limit/offset coercion
//   - resolveClientIp(request)            — Cloudflare-only client IP, never XFF
// Both are imported by every paginated route and tool, so the tests pin the
// contracts (silent failure modes like Number("x") -> NaN -> def were the
// whole reason clampInt was extracted in the first place).

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  ANONYMOUS_CLIENT_KEY,
  clampInt,
  resolveClientIp,
} from "../workers/config.ts";

const fakeRequest = (headers) => ({
  headers: { get: (name) => headers[name.toLowerCase()] ?? null },
});

describe("clampInt (#2568)", () => {
  test("returns the default when raw is null or empty", () => {
    assert.equal(clampInt(null, 50, 1, 100), 50);
    assert.equal(clampInt(undefined, 50, 1, 100), 50);
    assert.equal(clampInt("", 50, 1, 100), 50);
  });

  test("returns the default when raw is non-finite (NaN, Infinity, alpha)", () => {
    assert.equal(clampInt("abc", 50, 1, 100), 50);
    assert.equal(clampInt(NaN, 50, 1, 100), 50);
    assert.equal(clampInt(Infinity, 50, 1, 100), 50);
    assert.equal(clampInt(-Infinity, 50, 1, 100), 50);
  });

  test("clamps a finite number into [min, max]", () => {
    assert.equal(clampInt(0, 50, 1, 100), 1);
    assert.equal(clampInt(1, 50, 1, 100), 1);
    assert.equal(clampInt(50, 50, 1, 100), 50);
    assert.equal(clampInt(100, 50, 1, 100), 100);
    assert.equal(clampInt(500, 50, 1, 100), 100);
  });

  test("truncates a finite float toward zero (not round)", () => {
    // clampInt calls Math.trunc, so 1.9 -> 1 (NOT 2) and -1.9 -> -1. Page
    // sizes from query strings are common fractional inputs.
    assert.equal(clampInt(1.9, 50, 0, 100), 1);
    assert.equal(clampInt(-1.9, 50, -10, 100), -1);
  });

  test("accepts a numeric string (D1 / query-param shape)", () => {
    assert.equal(clampInt("25", 50, 1, 100), 25);
    assert.equal(clampInt("0", 50, 1, 100), 1);
    assert.equal(clampInt("500", 50, 1, 100), 100);
  });

  test("an empty-string raw is treated as absent, not as 0", () => {
    // Guard: Number("") === 0, not NaN — so a bare ?? null fallback would clamp
    // the "absent" case to min, not to def. The explicit raw === "" check returns
    // def, matching the "I wasn't actually given a value" contract.
    assert.equal(clampInt("", 50, 1, 100), 50);
    assert.equal(clampInt("", 1, 0, 0), 1);
  });
});

describe("resolveClientIp (#2568)", () => {
  test("reads cf-connecting-ip on a Cloudflare-shaped request", () => {
    const key = resolveClientIp(
      fakeRequest({ "cf-connecting-ip": "203.0.113.5" }),
    );
    assert.equal(key, "203.0.113.5");
  });

  test("ignores x-forwarded-for (client-supplied, must not be trusted)", () => {
    // Guard: an attacker rotating X-Forwarded-For could otherwise mint a fresh
    // rate-limit bucket per request. The fix is to read cf-connecting-ip ONLY.
    const key = resolveClientIp(
      fakeRequest({ "x-forwarded-for": "198.51.100.1, 198.51.100.2" }),
    );
    assert.equal(key, ANONYMOUS_CLIENT_KEY);
  });

  test("ignores x-forwarded-for even when cf-connecting-ip is also present", () => {
    const key = resolveClientIp(
      fakeRequest({
        "cf-connecting-ip": "203.0.113.5",
        "x-forwarded-for": "198.51.100.1",
      }),
    );
    assert.equal(key, "203.0.113.5");
  });

  test("falls back to the anonymous bucket when no cf-connecting-ip header is set", () => {
    // Non-CF / local / test harness — collapse to a single shared bucket so
    // worst case all such callers share one rate-limit quota, not a per-request
    // mint-the-world evasion.
    const key = resolveClientIp(fakeRequest({}));
    assert.equal(key, ANONYMOUS_CLIENT_KEY);
  });

  test("ANONYMOUS_CLIENT_KEY is a non-empty fixed string", () => {
    // Guard: a downstream keyer must never see an empty key.
    assert.equal(typeof ANONYMOUS_CLIENT_KEY, "string");
    assert.ok(ANONYMOUS_CLIENT_KEY.length > 0);
  });
});
