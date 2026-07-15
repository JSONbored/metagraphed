import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
  buildChangeEvent,
  deliverChangeEvent,
  dispatchChangeEvent,
  eventMatchesFilters,
  generateSecret,
  generateSubscriptionId,
  isPublicWebhookAddress,
  isPublicWebhookUrl,
  isValidSubscriptionId,
  normalizeFilters,
  publicSubscriptionView,
  signPayload,
  subscriptionStorageKey,
  timingSafeEqual,
  validateSubscriptionInput,
  WEBHOOK_SIGNATURE_HEADER,
} from "../src/webhooks.mjs";

describe("isPublicWebhookUrl", () => {
  test("accepts a normal public https URL", () => {
    assert.equal(isPublicWebhookUrl("https://hooks.example.com/mg"), true);
    assert.equal(isPublicWebhookUrl("https://example.com:443/x"), true);
  });

  test("rejects non-https and credentialed / odd-port URLs", () => {
    assert.equal(isPublicWebhookUrl("http://example.com/x"), false);
    assert.equal(isPublicWebhookUrl("https://user:pw@example.com/x"), false);
    assert.equal(isPublicWebhookUrl("https://example.com:8443/x"), false);
    assert.equal(isPublicWebhookUrl("ftp://example.com"), false);
    assert.equal(isPublicWebhookUrl("not a url"), false);
  });

  test("rejects localhost, private, and link-local hosts (SSRF guard)", () => {
    for (const url of [
      "https://localhost/x",
      "https://app.localhost/x",
      "https://svc.internal/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://192.168.0.5/x",
      "https://172.16.0.1/x",
      "https://169.254.169.254/latest/meta-data", // cloud metadata
      "https://100.100.0.1/x", // CGNAT
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[fe80::1]/x",
      "https://router/x", // bare label, no dot
    ]) {
      assert.equal(isPublicWebhookUrl(url), false, `should reject ${url}`);
    }
  });

  test("accepts a public IPv4/IPv6 literal", () => {
    assert.equal(isPublicWebhookUrl("https://8.8.8.8/x"), true);
    assert.equal(isPublicWebhookUrl("https://[2606:4700:4700::1111]/x"), true);
  });

  test("classifies resolved addresses and rejects private DNS answers", async () => {
    assert.equal(isPublicWebhookAddress("8.8.8.8"), true);
    assert.equal(isPublicWebhookAddress("10.0.0.1"), false);
    assert.equal(isPublicWebhookAddress("2606:4700:4700::1111"), true);
    assert.equal(isPublicWebhookAddress("fd00::1"), false);
  });
});

describe("normalizeFilters / validateSubscriptionInput", () => {
  test("normalizes, dedupes, and sorts filters", () => {
    assert.deepEqual(normalizeFilters(undefined), {});
    assert.deepEqual(
      normalizeFilters({ netuids: [7, 7, 2], kinds: ["subnets", "subnets"] }),
      { netuids: [2, 7], kinds: ["subnets"] },
    );
  });

  test("rejects malformed filters", () => {
    assert.equal(normalizeFilters([]), null);
    assert.equal(normalizeFilters({ netuids: "7" }), null);
    assert.equal(normalizeFilters({ netuids: [-1] }), null);
    assert.equal(normalizeFilters({ kinds: ["nope"] }), null);
  });

  test("validates a good subscription and rejects bad ones", () => {
    const ok = validateSubscriptionInput({
      url: "https://hooks.example.com/mg",
      filters: { netuids: [7] },
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.filters, { netuids: [7] });
    assert.equal(ok.value.secret, null);

    assert.equal(validateSubscriptionInput(null).ok, false);
    assert.equal(validateSubscriptionInput({ url: "http://x.com" }).ok, false);
    assert.equal(
      validateSubscriptionInput({ url: "https://x.com", filters: 5 }).ok,
      false,
    );
    assert.equal(
      validateSubscriptionInput({ url: "https://x.com", secret: "short" }).ok,
      false,
    );
  });
});

describe("buildChangeEvent", () => {
  const changelog = {
    generated_at: "2026-06-10T00:00:00.000Z",
    contract_version: "2026-06-06.1",
    artifacts: {
      added: [{ path: "evidence/7.json", hash: "a" }],
      modified: [
        { path: "coverage.json", hash: "b" },
        { path: "subnets/64.json", hash: "c" },
      ],
      removed: [],
    },
    subnets: {
      added: [],
      removed: [],
      renamed: [{ netuid: 110, from: "x", to: "y" }],
    },
  };
  const pointer = { published_at: "2026-06-10T01:23:45.000Z" };

  test("summarizes counts, change kinds, and affected netuids", () => {
    const event = buildChangeEvent({ changelog, pointer });
    assert.equal(event.type, "metagraph.publish");
    assert.equal(event.published_at, "2026-06-10T01:23:45.000Z");
    assert.deepEqual(event.summary.artifacts, {
      added: 1,
      modified: 2,
      removed: 0,
    });
    assert.deepEqual(event.summary.subnets, {
      added: 0,
      removed: 0,
      renamed: 1,
    });
    assert.deepEqual(event.change_kinds.sort(), ["artifacts", "subnets"]);
    // 7 (evidence), 64 (subnets/64.json), 110 (renamed). coverage.json => none.
    assert.deepEqual(event.affected_netuids, [7, 64, 110]);
  });

  test("is robust to an empty/missing changelog", () => {
    const event = buildChangeEvent({});
    assert.deepEqual(event.change_kinds, []);
    assert.deepEqual(event.affected_netuids, []);
    assert.equal(event.published_at, null);
  });
});

describe("eventMatchesFilters", () => {
  const event = {
    change_kinds: ["artifacts"],
    affected_netuids: [7, 64],
  };

  test("no filters => always matches", () => {
    assert.equal(eventMatchesFilters(event, {}), true);
    assert.equal(eventMatchesFilters(event, undefined), true);
  });

  test("netuid filter matches on overlap only", () => {
    assert.equal(eventMatchesFilters(event, { netuids: [64] }), true);
    assert.equal(eventMatchesFilters(event, { netuids: [1, 2] }), false);
  });

  test("kind filter matches on overlap only", () => {
    assert.equal(eventMatchesFilters(event, { kinds: ["artifacts"] }), true);
    assert.equal(eventMatchesFilters(event, { kinds: ["subnets"] }), false);
  });

  test("both filters must pass", () => {
    assert.equal(
      eventMatchesFilters(event, { netuids: [64], kinds: ["subnets"] }),
      false,
    );
    assert.equal(
      eventMatchesFilters(event, { netuids: [64], kinds: ["artifacts"] }),
      true,
    );
  });
});

describe("signing + identity helpers", () => {
  test("signPayload is deterministic and key-sensitive", async () => {
    const a = await signPayload("secret-key-123456", '{"x":1}');
    const b = await signPayload("secret-key-123456", '{"x":1}');
    const c = await signPayload("different-key-9999", '{"x":1}');
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.match(a, /^[0-9a-f]{64}$/);
  });

  test("timingSafeEqual compares correctly", () => {
    assert.equal(timingSafeEqual("abc", "abc"), true);
    assert.equal(timingSafeEqual("abc", "abd"), false);
    assert.equal(timingSafeEqual("abc", "abcd"), false);
    // Length mismatch in either direction (no early return — see #1374); empty.
    assert.equal(timingSafeEqual("abcd", "abc"), false);
    assert.equal(timingSafeEqual("", ""), true);
    assert.equal(timingSafeEqual("a", ""), false);
  });

  test("ids/secrets/keys are well formed", () => {
    const id = generateSubscriptionId();
    assert.equal(isValidSubscriptionId(id), true);
    assert.equal(isValidSubscriptionId("nope"), false);
    assert.match(generateSecret(), /^[0-9a-f]{64}$/);
    assert.equal(subscriptionStorageKey("abc"), "webhooks:sub:abc");
  });

  test("publicSubscriptionView strips the secret", () => {
    const view = publicSubscriptionView({
      id: "i",
      url: "https://x.com",
      secret: "TOPSECRET",
      filters: { netuids: [7] },
      created_at: "t",
      active: true,
    });
    assert.equal(view.secret, undefined);
    assert.equal(view.url, "https://x.com");
    assert.deepEqual(view.filters, { netuids: [7] });
  });
});

describe("deliverChangeEvent", () => {
  const event = {
    type: "metagraph.publish",
    change_kinds: ["artifacts"],
    affected_netuids: [7],
  };
  const sub = (over = {}) => ({
    id: "s1",
    url: "https://hooks.example.com/mg",
    secret: "subscription-secret-value",
    filters: {},
    ...over,
  });
  const now = () => "2026-06-10T00:00:00.000Z";

  test("delivers with a signed body on 2xx", async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return new Response("ok", { status: 200 });
    };
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn,
      now,
    });
    assert.equal(res.status, "delivered");
    assert.equal(res.attempts, 1);
    assert.equal(calls.length, 1);
    const sig = calls[0].init.headers[WEBHOOK_SIGNATURE_HEADER];
    assert.equal(sig, await signPayload(sub().secret, JSON.stringify(event)));
  });

  test("skips an unsafe URL without fetching", async () => {
    let called = false;
    const fetchFn = async () => {
      called = true;
      return new Response("", { status: 200 });
    };
    const res = await deliverChangeEvent({
      subscription: sub({ url: "https://127.0.0.1/x" }),
      event,
      fetchFn,
      now,
    });
    assert.equal(res.status, "skipped");
    assert.equal(res.reason, "unsafe-url");
    assert.equal(called, false);
  });

  test("skips DNS-resolved private destinations without fetching", async () => {
    let called = false;
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn: async () => {
        called = true;
        return new Response("", { status: 200 });
      },
      resolveHostnames: async () => ["169.254.169.254"],
      now,
    });
    assert.equal(res.status, "skipped");
    assert.equal(res.reason, "unsafe-url");
    assert.equal(called, false);
  });

  test("does not follow redirects", async () => {
    const calls = [];
    const fetchFn = async (url, init) => {
      calls.push({ url, init });
      return new Response("", {
        status: 302,
        headers: { location: "http://127.0.0.1/admin" },
      });
    };
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn,
      now,
    });
    assert.equal(res.status, "failed");
    assert.equal(res.status_code, 302);
    assert.equal(res.reason, "redirect-not-followed");
    assert.equal(calls[0].init.redirect, "manual");
  });

  test("filters out a non-matching subscription", async () => {
    const res = await deliverChangeEvent({
      subscription: sub({ filters: { netuids: [999] } }),
      event,
      fetchFn: async () => new Response("", { status: 200 }),
      now,
    });
    assert.equal(res.status, "filtered");
  });

  test("retries 5xx then succeeds", async () => {
    let n = 0;
    const fetchFn = async () => {
      n += 1;
      return new Response("", { status: n < 2 ? 503 : 200 });
    };
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn,
      now,
    });
    assert.equal(res.status, "delivered");
    assert.equal(res.attempts, 2);
  });

  test("applies exponential backoff between retries, none after the last", async () => {
    const delays = [];
    const fetchFn = async () => new Response("", { status: 503 }); // always retryable
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn,
      now,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    });
    assert.equal(res.status, "failed");
    assert.equal(res.attempts, 3);
    // 2 backoffs for 3 attempts (500ms, 1s); no trailing wait after the last.
    assert.deepEqual(delays, [500, 1000]);
  });

  test("does NOT retry a 4xx rejection", async () => {
    let n = 0;
    const fetchFn = async () => {
      n += 1;
      return new Response("", { status: 400 });
    };
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn,
      now,
    });
    assert.equal(res.status, "failed");
    assert.equal(res.status_code, 400);
    assert.equal(n, 1);
  });

  test("fails after exhausting retries on persistent 5xx", async () => {
    const fetchFn = async () => new Response("", { status: 502 });
    const res = await deliverChangeEvent({
      subscription: sub(),
      event,
      fetchFn,
      now,
      maxAttempts: 3,
    });
    assert.equal(res.status, "failed");
    assert.equal(res.attempts, 3);
    assert.equal(res.reason, "http-502");
  });
});

describe("dispatchChangeEvent", () => {
  test("returns one result per subscription and respects filters/safety", async () => {
    const event = { change_kinds: ["subnets"], affected_netuids: [7, 9] };
    const subs = [
      {
        id: "a",
        url: "https://a.example.com/h",
        secret: "secret-value-aaaaaa",
        filters: { netuids: [7] },
      },
      {
        id: "b",
        url: "https://b.example.com/h",
        secret: "secret-value-bbbbbb",
        filters: { netuids: [100] },
      },
      {
        id: "c",
        url: "https://10.0.0.1/h",
        secret: "secret-value-cccccc",
        filters: {},
      },
    ];
    const fetchFn = async () => new Response("", { status: 200 });
    const results = await dispatchChangeEvent({
      subscriptions: subs,
      event,
      fetchFn,
      now: () => "t",
      concurrency: 2,
    });
    const byId = Object.fromEntries(results.map((r) => [r.id, r.status]));
    assert.equal(byId.a, "delivered");
    assert.equal(byId.b, "filtered");
    assert.equal(byId.c, "skipped");
    assert.equal(results.length, 3);
  });
});
