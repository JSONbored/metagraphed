import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChangeEvent,
  deliverChangeEvent,
  dispatchChangeEvent,
  eventMatchesFilters,
  isPublicWebhookAddress,
  isPublicWebhookUrl,
  isResolvedPublicWebhookUrl,
  normalizeFilters,
  publicSubscriptionView,
  signPayload,
  timingSafeEqual,
  validateSubscriptionInput,
} from "../src/webhooks.mjs";

// --- isPublicWebhookAddress ---------------------------------------------------
describe("isPublicWebhookAddress", () => {
  test("empty / falsy host → false", () => {
    assert.equal(isPublicWebhookAddress(""), false);
    assert.equal(isPublicWebhookAddress(null), false);
    assert.equal(isPublicWebhookAddress(undefined), false);
  });

  test("loopback / link-local / unique-local / mapped IPv6 → false", () => {
    assert.equal(isPublicWebhookAddress("::1"), false);
    assert.equal(isPublicWebhookAddress("::"), false);
    assert.equal(isPublicWebhookAddress("fe80::1"), false);
    assert.equal(isPublicWebhookAddress("fc00::1"), false);
    assert.equal(isPublicWebhookAddress("fd12::1"), false);
    assert.equal(isPublicWebhookAddress("::ffff:10.0.0.1"), false);
  });

  test("the rest of the fe00::/8 reserved range → false", () => {
    // Only fe80 was blocked before; the rest of fe00::/8 (none of it is global
    // unicast, which is 2000::/3) was wrongly classified as public. Notably
    // fec0::/10 is deprecated site-local — a real internal range, and URL
    // parsing does not compress it away (unlike loopback).
    assert.equal(isPublicWebhookAddress("fec0::1"), false);
    assert.equal(isPublicWebhookAddress("fe00::1"), false);
    assert.equal(isPublicWebhookAddress("feff::1"), false);
  });

  test("public IPv6 → true", () => {
    assert.equal(isPublicWebhookAddress("2606:4700:4700::1111"), true);
  });

  test("IPv4 tunnelled inside an IPv6 literal → false", () => {
    // IPv4-compatible (deprecated); the URL parser re-serialises ::127.0.0.1 to
    // ::7f00:1, so both spellings must be caught.
    assert.equal(isPublicWebhookAddress("::127.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("::7f00:1"), false);
    assert.equal(isPublicWebhookAddress("::192.168.1.1"), false);
    // 6to4 (2002::/16) wrapping a private/loopback v4.
    assert.equal(isPublicWebhookAddress("2002:7f00:1::"), false);
    assert.equal(isPublicWebhookAddress("2002:a00:1::"), false); // 10.0.0.1
    // NAT64 (64:ff9b::/96) wrapping a private/loopback v4.
    assert.equal(isPublicWebhookAddress("64:ff9b::7f00:1"), false);
    assert.equal(isPublicWebhookAddress("64:ff9b::c0a8:101"), false); // 192.168.1.1
  });

  test("an IPv6 form wrapping a PUBLIC v4 stays public", () => {
    // 6to4 / NAT64 of 8.8.8.8 is genuinely routable — don't over-block.
    assert.equal(isPublicWebhookAddress("2002:808:808::"), true);
    assert.equal(isPublicWebhookAddress("64:ff9b::808:808"), true);
  });

  test("private IPv4 literals → false", () => {
    assert.equal(isPublicWebhookAddress("10.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("127.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("169.254.1.1"), false);
    assert.equal(isPublicWebhookAddress("192.168.1.1"), false);
    assert.equal(isPublicWebhookAddress("172.16.0.1"), false);
    assert.equal(isPublicWebhookAddress("100.64.0.1"), false);
  });

  test("public IPv4 literal → true", () => {
    assert.equal(isPublicWebhookAddress("8.8.8.8"), true);
  });

  test("a bare hostname (not an IP literal) → false", () => {
    assert.equal(isPublicWebhookAddress("example.com"), false);
  });
});

// --- isPublicWebhookUrl -------------------------------------------------------
describe("isPublicWebhookUrl", () => {
  test("rejects an unparseable URL", () => {
    assert.equal(isPublicWebhookUrl("not a url"), false);
  });

  test("rejects non-https, credentials, non-default port", () => {
    assert.equal(isPublicWebhookUrl("http://example.com/x"), false);
    assert.equal(isPublicWebhookUrl("https://user:pass@example.com/x"), false);
    assert.equal(isPublicWebhookUrl("https://example.com:8443/x"), false);
  });

  test("allows the explicit default 443 port", () => {
    assert.equal(isPublicWebhookUrl("https://example.com:443/x"), true);
  });

  test("rejects localhost / internal / local suffixes and bare labels", () => {
    assert.equal(isPublicWebhookUrl("https://localhost/x"), false);
    assert.equal(isPublicWebhookUrl("https://api.localhost/x"), false);
    assert.equal(isPublicWebhookUrl("https://svc.internal/x"), false);
    assert.equal(isPublicWebhookUrl("https://printer.local/x"), false);
    assert.equal(isPublicWebhookUrl("https://router/x"), false);
  });

  test("rejects a private IPv4 literal host", () => {
    assert.equal(isPublicWebhookUrl("https://169.254.169.254/x"), false);
  });

  test("rejects a v4 loopback tunnelled through an IPv6 literal host", () => {
    // The URL parser normalises [::127.0.0.1] → [::7f00:1]; the SSRF guard must
    // still see the embedded loopback rather than treating it as public IPv6.
    assert.equal(isPublicWebhookUrl("https://[::127.0.0.1]/x"), false);
    assert.equal(isPublicWebhookUrl("https://[2002:7f00:1::]/x"), false);
    assert.equal(isPublicWebhookUrl("https://[64:ff9b::7f00:1]/x"), false);
  });

  test("allows a public IPv4 literal host", () => {
    assert.equal(isPublicWebhookUrl("https://8.8.8.8/x"), true);
  });

  test("allows a registrable hostname with a dot", () => {
    assert.equal(isPublicWebhookUrl("https://hooks.example.com/mg"), true);
  });
});

// --- isResolvedPublicWebhookUrl ----------------------------------------------
describe("isResolvedPublicWebhookUrl", () => {
  test("short-circuits false for a non-public URL", async () => {
    assert.equal(
      await isResolvedPublicWebhookUrl("http://example.com/x"),
      false,
    );
  });

  test("returns true with no resolver injected", async () => {
    assert.equal(
      await isResolvedPublicWebhookUrl("https://hooks.example.com/mg"),
      true,
    );
  });

  test("an IP-literal host is checked directly (resolver ignored)", async () => {
    assert.equal(
      await isResolvedPublicWebhookUrl("https://8.8.8.8/x", async () => [
        "10.0.0.1",
      ]),
      true,
    );
    assert.equal(
      await isResolvedPublicWebhookUrl("https://127.0.0.1/x", async () => [
        "8.8.8.8",
      ]),
      false,
    );
  });

  test("returns false when the resolver throws", async () => {
    assert.equal(
      await isResolvedPublicWebhookUrl("https://hooks.example.com/mg", () => {
        throw new Error("dns boom");
      }),
      false,
    );
  });

  test("requires every resolved address to be public", async () => {
    assert.equal(
      await isResolvedPublicWebhookUrl(
        "https://hooks.example.com/mg",
        async () => ["8.8.8.8", "1.1.1.1"],
      ),
      true,
    );
    assert.equal(
      await isResolvedPublicWebhookUrl(
        "https://hooks.example.com/mg",
        async () => ["8.8.8.8", "10.0.0.1"],
      ),
      false,
    );
    assert.equal(
      await isResolvedPublicWebhookUrl(
        "https://hooks.example.com/mg",
        async () => [],
      ),
      false,
    );
  });
});

// --- normalizeFilters / validateSubscriptionInput ----------------------------
describe("normalizeFilters", () => {
  test("undefined / null → {}", () => {
    assert.deepEqual(normalizeFilters(undefined), {});
    assert.deepEqual(normalizeFilters(null), {});
  });

  test("non-object or array → null", () => {
    assert.equal(normalizeFilters(5), null);
    assert.equal(normalizeFilters([1, 2]), null);
  });

  test("rejects too many netuids", () => {
    const netuids = Array.from({ length: 65 }, (_, i) => i);
    assert.equal(normalizeFilters({ netuids }), null);
  });

  test("rejects non-array / out-of-range netuids", () => {
    assert.equal(normalizeFilters({ netuids: "nope" }), null);
    assert.equal(normalizeFilters({ netuids: [-1] }), null);
    assert.equal(normalizeFilters({ netuids: [70000] }), null);
    assert.equal(normalizeFilters({ netuids: [1.5] }), null);
  });

  test("dedupes + sorts netuids", () => {
    assert.deepEqual(normalizeFilters({ netuids: [7, 1, 7] }), {
      netuids: [1, 7],
    });
  });

  test("rejects too many kinds", () => {
    const kinds = Array.from({ length: 9 }, () => "subnets");
    assert.equal(normalizeFilters({ kinds }), null);
  });

  test("rejects a non-array / invalid kind", () => {
    assert.equal(normalizeFilters({ kinds: "subnets" }), null);
    assert.equal(normalizeFilters({ kinds: ["nope"] }), null);
    assert.equal(normalizeFilters({ kinds: [5] }), null);
  });

  test("dedupes + sorts kinds", () => {
    assert.deepEqual(
      normalizeFilters({ kinds: ["subnets", "artifacts", "subnets"] }),
      { kinds: ["artifacts", "subnets"] },
    );
  });
});

describe("validateSubscriptionInput", () => {
  test("rejects a non-object input", () => {
    assert.equal(validateSubscriptionInput(null).ok, false);
    assert.equal(validateSubscriptionInput([]).ok, false);
    assert.equal(validateSubscriptionInput(5).ok, false);
  });

  test("rejects a non-string / non-public url", () => {
    assert.equal(validateSubscriptionInput({ url: 5 }).ok, false);
    assert.equal(
      validateSubscriptionInput({ url: "http://example.com/x" }).ok,
      false,
    );
  });

  test("rejects invalid filters", () => {
    const out = validateSubscriptionInput({
      url: "https://hooks.example.com/x",
      filters: { netuids: "bad" },
    });
    assert.equal(out.ok, false);
    assert.match(out.error, /filters/);
  });

  test("rejects a too-short / too-long / non-string secret", () => {
    assert.equal(
      validateSubscriptionInput({
        url: "https://hooks.example.com/x",
        secret: "short",
      }).ok,
      false,
    );
    assert.equal(
      validateSubscriptionInput({
        url: "https://hooks.example.com/x",
        secret: "x".repeat(257),
      }).ok,
      false,
    );
    assert.equal(
      validateSubscriptionInput({
        url: "https://hooks.example.com/x",
        secret: 12345,
      }).ok,
      false,
    );
  });

  test("accepts a valid subscription with a secret + filters", () => {
    const out = validateSubscriptionInput({
      url: "https://hooks.example.com/x",
      filters: { netuids: [7], kinds: ["subnets"] },
      secret: "a-sixteen-char!!",
    });
    assert.equal(out.ok, true);
    assert.deepEqual(out.value.filters, { netuids: [7], kinds: ["subnets"] });
    assert.equal(out.value.secret, "a-sixteen-char!!");
  });
});

// --- buildChangeEvent / eventMatchesFilters ----------------------------------
describe("buildChangeEvent + eventMatchesFilters", () => {
  const event = buildChangeEvent({
    changelog: {
      generated_at: "g",
      contract_version: "v1",
      artifacts: {
        added: ["/metagraph/subnets/7.json", { path: "/metagraph/x.json" }],
        modified: [],
        removed: [],
      },
      subnets: {
        added: [{ netuid: 7 }],
        removed: [3],
        renamed: [{ netuid: 11 }],
      },
    },
    pointer: { published_at: "p" },
  });

  test("derives change kinds, affected netuids, and summary", () => {
    assert.equal(event.published_at, "p");
    assert.deepEqual(event.change_kinds.sort(), ["artifacts", "subnets"]);
    assert.deepEqual(event.affected_netuids, [3, 7, 11]);
    assert.equal(event.summary.artifacts.added, 2);
    assert.equal(event.summary.subnets.renamed, 1);
  });

  test("empty changelog → no kinds, empty netuids", () => {
    const empty = buildChangeEvent({});
    assert.deepEqual(empty.change_kinds, []);
    assert.deepEqual(empty.affected_netuids, []);
    assert.equal(empty.contract_version, null);
  });

  test("no filters → matches everything", () => {
    assert.equal(eventMatchesFilters(event, undefined), true);
    assert.equal(eventMatchesFilters(event, {}), true);
  });

  test("kind filter: matches only when a kind overlaps", () => {
    assert.equal(eventMatchesFilters(event, { kinds: ["subnets"] }), true);
    const artifactsOnly = buildChangeEvent({
      changelog: { artifacts: { added: ["/metagraph/x.json"] } },
    });
    assert.equal(
      eventMatchesFilters(artifactsOnly, { kinds: ["subnets"] }),
      false,
    );
  });

  test("netuid filter: matches only on an affected netuid", () => {
    assert.equal(eventMatchesFilters(event, { netuids: [7] }), true);
    assert.equal(eventMatchesFilters(event, { netuids: [99] }), false);
  });

  test("an explicit empty allowlist matches nothing (not everything)", () => {
    // normalizeFilters preserves `[]`, so these are reachable subscriptions.
    // An empty allowlist allows zero items → no event matches.
    assert.equal(eventMatchesFilters(event, { kinds: [] }), false);
    assert.equal(eventMatchesFilters(event, { netuids: [] }), false);
    assert.equal(eventMatchesFilters(event, { netuids: [], kinds: [] }), false);
    // An empty allowlist on one facet rejects even when the other would match.
    assert.equal(
      eventMatchesFilters(event, { netuids: [7], kinds: [] }),
      false,
    );
  });
});

// --- signPayload / timingSafeEqual -------------------------------------------
describe("signPayload + timingSafeEqual", () => {
  test("signing is deterministic for the same secret + body", async () => {
    const a = await signPayload("secret", "hello");
    const b = await signPayload("secret", "hello");
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("a different secret yields a different signature", async () => {
    const a = await signPayload("secret-a", "hello");
    const b = await signPayload("secret-b", "hello");
    assert.notEqual(a, b);
  });

  test("timingSafeEqual matches equal strings and rejects mismatches", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
  });
});

// --- publicSubscriptionView --------------------------------------------------
describe("publicSubscriptionView", () => {
  test("null / non-object → null", () => {
    assert.equal(publicSubscriptionView(null), null);
    assert.equal(publicSubscriptionView("nope"), null);
  });

  test("strips the secret and defaults active true", () => {
    const view = publicSubscriptionView({
      id: "x",
      url: "https://h.example.com",
      secret: "s",
    });
    assert.equal(view.secret, undefined);
    assert.equal(view.active, true);
    assert.deepEqual(view.filters, {});
    assert.equal(view.created_at, null);
  });

  test("active false is preserved", () => {
    assert.equal(
      publicSubscriptionView({ id: "x", active: false }).active,
      false,
    );
  });
});

// --- deliverChangeEvent ------------------------------------------------------
describe("deliverChangeEvent", () => {
  const event = buildChangeEvent({
    changelog: { subnets: { added: [{ netuid: 7 }] } },
    pointer: { published_at: "p" },
  });
  const base = {
    id: "sub-1",
    url: "https://hooks.example.com/mg",
    secret: "a-sixteen-char!!",
  };

  test("skips an invalid subscription (no url)", async () => {
    const out = await deliverChangeEvent({
      subscription: { id: "x" },
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(out.status, "skipped");
    assert.equal(out.reason, "invalid");
  });

  test("skips a null subscription", async () => {
    const out = await deliverChangeEvent({
      subscription: null,
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(out.status, "skipped");
    assert.equal(out.id, null);
  });

  test("skips an unsafe url", async () => {
    const out = await deliverChangeEvent({
      subscription: { ...base, url: "http://example.com/x" },
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(out.status, "skipped");
    assert.equal(out.reason, "unsafe-url");
  });

  test("reports filtered on a filter mismatch", async () => {
    const out = await deliverChangeEvent({
      subscription: { ...base, filters: { netuids: [99] } },
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(out.status, "filtered");
  });

  test("skips when no secret is set", async () => {
    const out = await deliverChangeEvent({
      subscription: { id: "x", url: base.url },
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(out.status, "skipped");
    assert.equal(out.reason, "no-secret");
  });

  test("skips when DNS resolves to a private address", async () => {
    const out = await deliverChangeEvent({
      subscription: base,
      event,
      fetchFn: async () => new Response("", { status: 200 }),
      resolveHostnames: async () => ["10.0.0.1"],
    });
    assert.equal(out.status, "skipped");
    assert.equal(out.reason, "unsafe-url");
  });

  test("delivers on a 2xx with the current timestamp from now()", async () => {
    let seenHeaders;
    const out = await deliverChangeEvent({
      subscription: base,
      event,
      now: () => "2026-06-11T00:00:00.000Z",
      fetchFn: async (_url, init) => {
        seenHeaders = init.headers;
        return new Response(null, { status: 204 });
      },
    });
    assert.equal(out.status, "delivered");
    assert.equal(out.status_code, 204);
    assert.equal(out.attempts, 1);
    assert.equal(
      seenHeaders["x-metagraph-timestamp"],
      "2026-06-11T00:00:00.000Z",
    );
    assert.match(seenHeaders["x-metagraph-signature"], /^[0-9a-f]{64}$/);
  });

  test("uses the epoch timestamp when now() is not a function", async () => {
    let seenHeaders;
    await deliverChangeEvent({
      subscription: base,
      event,
      fetchFn: async (_url, init) => {
        seenHeaders = init.headers;
        return new Response("", { status: 200 });
      },
    });
    assert.equal(
      seenHeaders["x-metagraph-timestamp"],
      new Date(0).toISOString(),
    );
  });

  test("fails (no retry) on a 3xx redirect", async () => {
    const out = await deliverChangeEvent({
      subscription: base,
      event,
      fetchFn: async () => new Response("", { status: 302 }),
    });
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "redirect-not-followed");
    assert.equal(out.attempts, 1);
  });

  test("fails (no retry) on a deterministic 4xx", async () => {
    let calls = 0;
    const out = await deliverChangeEvent({
      subscription: base,
      event,
      fetchFn: async () => {
        calls += 1;
        return new Response("", { status: 404 });
      },
    });
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "http-404");
    assert.equal(calls, 1);
  });

  test("retries 5xx up to maxAttempts then fails", async () => {
    let calls = 0;
    const out = await deliverChangeEvent({
      subscription: base,
      event,
      maxAttempts: 3,
      fetchFn: async () => {
        calls += 1;
        return new Response("", { status: 503 });
      },
    });
    assert.equal(out.status, "failed");
    assert.equal(out.reason, "http-503");
    assert.equal(out.attempts, 3);
    assert.equal(calls, 3);
  });

  test("retries 429 then succeeds", async () => {
    let calls = 0;
    const out = await deliverChangeEvent({
      subscription: base,
      event,
      fetchFn: async () => {
        calls += 1;
        return calls < 2
          ? new Response("", { status: 429 })
          : new Response("", { status: 200 });
      },
    });
    assert.equal(out.status, "delivered");
    assert.equal(out.attempts, 2);
  });

  test("classifies a TimeoutError vs a generic network error", async () => {
    const timeoutOut = await deliverChangeEvent({
      subscription: base,
      event,
      maxAttempts: 1,
      fetchFn: async () => {
        const err = new Error("timed out");
        err.name = "TimeoutError";
        throw err;
      },
    });
    assert.equal(timeoutOut.status, "failed");
    assert.equal(timeoutOut.reason, "timeout");

    const networkOut = await deliverChangeEvent({
      subscription: base,
      event,
      maxAttempts: 1,
      fetchFn: async () => {
        throw new Error("connection reset");
      },
    });
    assert.equal(networkOut.status, "failed");
    assert.equal(networkOut.reason, "network-error");
  });
});

// --- dispatchChangeEvent -----------------------------------------------------
describe("dispatchChangeEvent", () => {
  const event = buildChangeEvent({
    changelog: { subnets: { added: [{ netuid: 7 }] } },
  });

  test("fans out over many subscriptions, one result each", async () => {
    const subs = Array.from({ length: 5 }, (_, i) => ({
      id: `sub-${i}`,
      url: "https://hooks.example.com/mg",
      secret: "a-sixteen-char!!",
    }));
    const results = await dispatchChangeEvent({
      subscriptions: subs,
      event,
      concurrency: 2,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(results.length, 5);
    assert.ok(results.every((r) => r.status === "delivered"));
  });

  test("empty subscription list → empty results (no throw)", async () => {
    const results = await dispatchChangeEvent({
      subscriptions: [],
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.deepEqual(results, []);
  });

  test("a bad endpoint cannot sink the batch", async () => {
    const results = await dispatchChangeEvent({
      subscriptions: [
        {
          id: "ok",
          url: "https://hooks.example.com/mg",
          secret: "a-sixteen-char!!",
        },
        { id: "bad", url: "http://example.com/x", secret: "a-sixteen-char!!" },
      ],
      event,
      fetchFn: async () => new Response("", { status: 200 }),
    });
    assert.equal(results.length, 2);
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
    assert.equal(byId.ok, "delivered");
    assert.equal(byId.bad, "skipped");
  });
});
