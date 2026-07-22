// Unit tests for the get_feed MCP tool's five input-validation functions and
// loadFeedItems's per-kind branch dispatch (#7234). The validators are the
// layer between a malformed agent call and a clean invalid_params toolError
// (vs. an unhandled exception), so each error path + edge case is covered.
import assert from "node:assert/strict";
import { describe, test, vi } from "vitest";
import {
  FEED_KINDS,
  loadFeedItems,
  optionalTag,
  optionalTimestampMs,
  requireKind,
  resolveLimit,
  resolveNetuid,
} from "../src/feed-mcp.ts";
import { FEED_MAX_ITEMS } from "../src/feeds.mjs";

// A thrown value is a clean invalid_params toolError.
const isInvalidParams = (e) =>
  e?.toolError === true && e?.code === "invalid_params";

describe("requireKind", () => {
  test("returns each of the four valid FEED_KINDS unchanged", () => {
    for (const kind of FEED_KINDS) {
      assert.equal(requireKind({ kind }), kind);
    }
  });

  test("rejects a missing kind", () => {
    assert.throws(() => requireKind({}), isInvalidParams);
    assert.throws(() => requireKind(undefined), isInvalidParams);
  });

  test("rejects an unknown or non-string kind", () => {
    assert.throws(() => requireKind({ kind: "bogus" }), isInvalidParams);
    assert.throws(() => requireKind({ kind: 7 }), isInvalidParams);
  });
});

describe("resolveNetuid", () => {
  test("kind subnet: returns a valid non-negative integer netuid", () => {
    assert.equal(resolveNetuid({ netuid: 0 }, "subnet"), 0);
    assert.equal(resolveNetuid({ netuid: 64 }, "subnet"), 64);
  });

  test("kind subnet: rejects a missing, negative, or non-integer netuid", () => {
    assert.throws(() => resolveNetuid({}, "subnet"), isInvalidParams);
    assert.throws(
      () => resolveNetuid({ netuid: -1 }, "subnet"),
      isInvalidParams,
    );
    assert.throws(
      () => resolveNetuid({ netuid: 1.5 }, "subnet"),
      isInvalidParams,
    );
    assert.throws(
      () => resolveNetuid({ netuid: "7" }, "subnet"),
      isInvalidParams,
    );
  });

  test("non-subnet kind: returns null when no netuid is present", () => {
    assert.equal(resolveNetuid({}, "registry"), null);
    assert.equal(resolveNetuid({ netuid: undefined }, "incidents"), null);
    assert.equal(resolveNetuid({ netuid: null }, "gaps"), null);
  });

  test("non-subnet kind: rejects a netuid the caller thinks is doing something", () => {
    assert.throws(
      () => resolveNetuid({ netuid: 7 }, "registry"),
      isInvalidParams,
    );
    assert.throws(
      () => resolveNetuid({ netuid: 0 }, "incidents"),
      isInvalidParams,
    );
  });
});

describe("optionalTimestampMs", () => {
  test("absent / empty resolves to null", () => {
    assert.equal(optionalTimestampMs({}, "since"), null);
    assert.equal(optionalTimestampMs({ since: undefined }, "since"), null);
    assert.equal(optionalTimestampMs({ since: null }, "since"), null);
    assert.equal(optionalTimestampMs({ since: "" }, "since"), null);
  });

  test("a valid ISO date-time parses to its exact epoch ms (endOfDay is irrelevant to a full datetime)", () => {
    const iso = "2026-06-01T12:00:00Z";
    const expected = Date.parse("2026-06-01T12:00:00.000Z");
    assert.equal(optionalTimestampMs({ since: iso }, "since"), expected);
    assert.equal(optionalTimestampMs({ until: iso }, "until"), expected);
  });

  test("a bare date is start-of-day for since and inclusive end-of-day for until", () => {
    const startJun1 = Date.UTC(2026, 5, 1);
    const endJun1 = Date.UTC(2026, 5, 2) - 1;
    assert.equal(
      optionalTimestampMs({ since: "2026-06-01" }, "since"),
      startJun1,
    );
    assert.equal(
      optionalTimestampMs({ until: "2026-06-01" }, "until"),
      endJun1,
    );
    // The end-of-day rule pushes until later than since for the same bare date,
    // but keeps it within that same UTC day.
    assert.ok(endJun1 > startJun1);
    assert.ok(endJun1 < Date.UTC(2026, 5, 2));
  });

  test("rejects an unparseable string or a non-string value", () => {
    assert.throws(
      () => optionalTimestampMs({ since: "not-a-date" }, "since"),
      isInvalidParams,
    );
    assert.throws(
      () => optionalTimestampMs({ since: "2026-13-01" }, "since"),
      isInvalidParams,
    );
    assert.throws(
      () => optionalTimestampMs({ since: 12345 }, "since"),
      isInvalidParams,
    );
    assert.throws(
      () => optionalTimestampMs({ until: {} }, "until"),
      isInvalidParams,
    );
  });
});

describe("optionalTag", () => {
  test("absent / empty resolves to null; a valid string passes through", () => {
    assert.equal(optionalTag({}), null);
    assert.equal(optionalTag({ tag: undefined }), null);
    assert.equal(optionalTag({ tag: "" }), null);
    assert.equal(optionalTag({ tag: "inference" }), "inference");
  });

  test("rejects a non-string tag", () => {
    assert.throws(() => optionalTag({ tag: 7 }), isInvalidParams);
    assert.throws(() => optionalTag({ tag: ["a"] }), isInvalidParams);
  });
});

describe("resolveLimit", () => {
  test("absent resolves to FEED_MAX_ITEMS", () => {
    assert.equal(resolveLimit({}), FEED_MAX_ITEMS);
    assert.equal(resolveLimit({ limit: null }), FEED_MAX_ITEMS);
  });

  test("a valid in-range integer passes through; over-max clamps to FEED_MAX_ITEMS", () => {
    assert.equal(resolveLimit({ limit: 1 }), 1);
    assert.equal(resolveLimit({ limit: 10 }), 10);
    assert.equal(resolveLimit({ limit: FEED_MAX_ITEMS + 100 }), FEED_MAX_ITEMS);
  });

  test("rejects a non-integer or below-1 limit", () => {
    assert.throws(() => resolveLimit({ limit: 0 }), isInvalidParams);
    assert.throws(() => resolveLimit({ limit: -5 }), isInvalidParams);
    assert.throws(() => resolveLimit({ limit: 2.5 }), isInvalidParams);
    assert.throws(() => resolveLimit({ limit: "10" }), isInvalidParams);
  });
});

describe("loadFeedItems branch dispatch", () => {
  function makeCtxDeps() {
    // readArtifact returns a cold miss so every builder degrades to [] rather
    // than depending on real artifact shapes; loadIncidents is a spy so we can
    // assert which kinds consult the incident ledger.
    const readArtifact = vi.fn(async () => ({
      ok: false,
      code: "artifact_not_found",
    }));
    const loadIncidents = vi.fn(async () => []);
    return {
      ctx: { env: {}, readArtifact },
      deps: { loadIncidents },
    };
  }

  test("registry: no netuid, does not consult the incident ledger", async () => {
    const { ctx, deps } = makeCtxDeps();
    const res = await loadFeedItems(ctx, { kind: "registry" }, deps);
    assert.equal(res.kind, "registry");
    assert.equal(res.netuid, null);
    assert.equal(deps.loadIncidents.mock.calls.length, 0);
    assert.ok(Array.isArray(res.items));
    assert.equal(res.returned, res.items.length);
    assert.equal(res.filters.limit, FEED_MAX_ITEMS);
  });

  test("incidents: consults the incident ledger exactly once", async () => {
    const { ctx, deps } = makeCtxDeps();
    const res = await loadFeedItems(ctx, { kind: "incidents" }, deps);
    assert.equal(res.kind, "incidents");
    assert.equal(res.netuid, null);
    assert.equal(deps.loadIncidents.mock.calls.length, 1);
  });

  test("gaps: no netuid, does not consult the incident ledger", async () => {
    const { ctx, deps } = makeCtxDeps();
    const res = await loadFeedItems(ctx, { kind: "gaps" }, deps);
    assert.equal(res.kind, "gaps");
    assert.equal(res.netuid, null);
    assert.equal(deps.loadIncidents.mock.calls.length, 0);
  });

  test("subnet: carries the netuid and consults the incident ledger (registry + incidents combined)", async () => {
    const { ctx, deps } = makeCtxDeps();
    const res = await loadFeedItems(ctx, { kind: "subnet", netuid: 7 }, deps);
    assert.equal(res.kind, "subnet");
    assert.equal(res.netuid, 7);
    assert.equal(deps.loadIncidents.mock.calls.length, 1);
  });

  test("forwards the raw since/until args into the returned filters descriptor", async () => {
    const { ctx, deps } = makeCtxDeps();
    const res = await loadFeedItems(
      ctx,
      { kind: "registry", since: "2026-06-01", until: "2026-06-02", limit: 5 },
      deps,
    );
    assert.deepEqual(res.filters, {
      tag: null,
      since: "2026-06-01",
      until: "2026-06-02",
      limit: 5,
    });
  });
});
