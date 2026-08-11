// The guard that keeps live hosts out of this suite, and the proof it fires.
//
// Written the way every gate in this repo has to be: the failing case first.
// A guard nobody has seen refuse anything is indistinguishable from a guard
// that silently allows everything, and this one wraps `fetch` — the single
// easiest thing to accidentally neutralise.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { __guard } from "./setup/no-outbound-fetch.ts";

describe("the outbound-fetch guard", () => {
  test("REFUSES a call to a host we do not operate", async () => {
    await assert.rejects(
      () => globalThis.fetch("https://entrypoint-finney.opentensor.ai/"),
      /Outbound network call to entrypoint-finney\.opentensor\.ai/,
    );
  });

  test("names both ways out, so the failure is actionable", async () => {
    const error = await globalThis.fetch("https://example.invalid/x").then(
      () => null,
      (e: Error) => e,
    );
    assert.ok(error);
    assert.match(error.message, /inject the loader/);
    assert.match(error.message, /stub `globalThis\.fetch`/);
  });

  test("allows loopback, which is the local harness and not somebody's API", () => {
    for (const host of ["localhost", "127.0.0.1", "0.0.0.0"]) {
      assert.equal(__guard.hostOf(`http://${host}:8787/x`), host);
    }
  });

  test("does not treat a relative URL as outbound", () => {
    // Resolved by whatever harness serves it; it never leaves the process.
    assert.equal(__guard.hostOf("/api/v1/subnets/64"), null);
    assert.equal(__guard.hostOf(""), null);
    assert.equal(__guard.hostOf(undefined), null);
  });

  test("reads the host off a Request and a URL, not just a string", () => {
    assert.equal(
      __guard.hostOf(new Request("https://api.example.com/v1")),
      "api.example.com",
    );
    assert.equal(
      __guard.hostOf(new URL("https://other.example/x")),
      "other.example",
    );
  });

  test("a malformed URL is not silently treated as allowed", () => {
    // hostOf returns null (unparseable), which the guard reads as "cannot
    // leave the process" — the same as a relative URL. Asserted so a future
    // change that starts throwing here is a visible decision.
    assert.equal(__guard.hostOf("http://[not a url"), null);
  });

  test("a test's own stub still wins, so the existing convention is untouched", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("stubbed", { status: 200 })) as typeof fetch;
    try {
      const res = await globalThis.fetch(
        "https://entrypoint-finney.opentensor.ai/",
      );
      assert.equal(await res.text(), "stubbed");
    } finally {
      globalThis.fetch = original;
    }
  });
});
