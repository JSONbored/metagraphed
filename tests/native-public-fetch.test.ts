import assert from "node:assert/strict";
import { test } from "vitest";
import type { Agent, Dispatcher } from "undici";
import {
  createNativePublicFetch,
  isPublicInternetAddress,
  type NativePublicFetchOptions,
} from "../src/native-public-fetch.ts";

function harness(
  settings: NativePublicFetchOptions = {},
  response: (call: number) => Response | Promise<Response> = () =>
    new Response("result", { headers: { "content-length": "6" } }),
) {
  const requests: {
    url: string;
    options: RequestInit & { dispatcher: Dispatcher };
  }[] = [];
  const agents: {
    host: string;
    address: string;
    family: number;
    closed: number;
    destroyed: number;
  }[] = [];
  let resolved = 0;
  const fetcher = createNativePublicFetch({
    resolver: async () => {
      resolved += 1;
      return [{ address: "93.184.216.34", family: 4 }];
    },
    dispatcher(host, address, family) {
      const agent = { host, address, family, closed: 0, destroyed: 0 };
      agents.push(agent);
      return {
        close: async () => {
          agent.closed += 1;
        },
        destroy: async () => {
          agent.destroyed += 1;
        },
      } as unknown as Agent;
    },
    transport: (async (url, options) => {
      requests.push({
        url: String(url),
        options: options as RequestInit & { dispatcher: Dispatcher },
      });
      return response(requests.length);
    }) as typeof fetch,
    ...settings,
  });
  return { fetcher, requests, agents, resolutions: () => resolved };
}

test("only globally routable unicast addresses qualify, including safe mapped IPv4", () => {
  for (const address of [
    "93.184.216.34",
    "1.1.1.1",
    "2606:4700:4700::1111",
    "::ffff:808:808",
  ]) {
    assert.equal(isPublicInternetAddress(address), true, address);
  }
  for (const address of [
    "not-an-ip",
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.0.1",
    "0.0.0.0",
    "192.0.2.1",
    "192.88.99.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:c000:201",
    "::808:808",
    "64:ff9b::808:808",
    "2002:808:808::",
    "2001:db8::1",
    "2001:2::1",
    "3fff::1",
    "5f00::1",
    "fc00::1",
    "fe80::1",
    "ff00::1",
  ])
    assert.equal(isPublicInternetAddress(address), false, address);
});

test("validates bounded options and refuses unsupported methods and protocols", async () => {
  for (const settings of [
    { timeoutMs: 0 },
    { timeoutMs: 10001 },
    { maxResponseBytes: 0 },
    { maxResponseBytes: 1048577 },
    { maxRedirects: -1 },
    { maxRedirects: 6 },
    { maxRedirects: 0.5 },
  ]) {
    assert.throws(
      () => createNativePublicFetch(settings),
      /Invalid public fetch/,
    );
  }
  const h = harness();
  await assert.rejects(
    h.fetcher("https://example.com", { method: "POST", body: "body" }),
    /GET and HEAD/,
  );
  await assert.rejects(h.fetcher("data:text/plain,hello"), /HTTP or HTTPS/);
  assert.equal(h.resolutions(), 0);
  assert.equal(h.requests.length, 0);
});

test("pins each public hop, strips cross-origin credentials and preserves response metadata", async () => {
  const h = harness({}, (call) =>
    call === 1
      ? new Response(null, {
          status: 302,
          headers: { location: "https://second.example/metadata" },
        })
      : new Response('{"client_id":"ok"}', {
          status: 201,
          statusText: "Created",
          headers: { "x-fixture": "kept" },
        }),
  );
  const response = await h.fetcher(
    new Request("https://first.example/metadata", {
      headers: {
        accept: "application/json",
        authorization: "fixture",
        cookie: "session=fixture",
        "proxy-authorization": "fixture",
        host: "untrusted.example",
      },
    }),
  );
  assert.equal(response.status, 201);
  assert.equal(response.statusText, "Created");
  assert.equal(response.headers.get("x-fixture"), "kept");
  assert.equal(response.url, "https://second.example/metadata");
  assert.equal(response.redirected, true);
  const clone = response.clone();
  assert.equal(clone.url, response.url);
  assert.equal(clone.redirected, true);
  assert.equal(await response.text(), '{"client_id":"ok"}');
  assert.equal(await clone.text(), '{"client_id":"ok"}');
  assert.equal(h.resolutions(), 2);
  assert.deepEqual(
    h.agents.map((agent) => [
      agent.host,
      agent.address,
      agent.family,
      agent.closed,
    ]),
    [
      ["first.example", "93.184.216.34", 4, 1],
      ["second.example", "93.184.216.34", 4, 1],
    ],
  );
  assert.equal(
    new Headers(h.requests[0].options.headers).get("authorization"),
    "fixture",
  );
  assert.equal(new Headers(h.requests[0].options.headers).get("host"), null);
  for (const name of ["authorization", "cookie", "proxy-authorization"]) {
    assert.equal(new Headers(h.requests[1].options.headers).get(name), null);
  }
  assert.equal(
    new Headers(h.requests[1].options.headers).get("accept"),
    "application/json",
  );
  assert.equal(h.requests[1].options.redirect, "manual");
  assert.ok(h.requests[1].options.signal instanceof AbortSignal);
});

test("same-origin redirects retain authorization; HEAD and no-body metadata close promptly", async () => {
  const h = harness({}, (call) =>
    call === 1
      ? new Response(null, { status: 307, headers: { location: "/next" } })
      : new Response(null, { status: 204 }),
  );
  const response = await h.fetcher("https://example.com/start", {
    method: "HEAD",
    headers: { authorization: "fixture" },
  });
  assert.equal(response.status, 204);
  assert.equal(response.url, "https://example.com/next");
  assert.equal(response.clone().redirected, true);
  assert.equal(
    new Headers(h.requests[1].options.headers).get("authorization"),
    "fixture",
  );
  assert.equal(h.requests[1].options.method, "HEAD");
  assert.deepEqual(
    h.agents.map((agent) => agent.closed),
    [1, 1],
  );
});

test("private, mixed, reserved and failed resolution never reaches transport", async () => {
  const real = createNativePublicFetch();
  await assert.rejects(real("http://127.0.0.1:1/"), /not publicly routable/);
  await assert.rejects(real("http://[::1]:1/"), /not publicly routable/);
  for (const url of [
    "http://127.0.0.1",
    "https://[::ffff:127.0.0.1]/",
    "http://192.0.2.1",
  ]) {
    const h = harness();
    await assert.rejects(h.fetcher(url), /not publicly routable/);
    assert.equal(h.requests.length, 0);
  }
  for (const records of [
    [],
    [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ],
    [{ address: "2001:db8::1", family: 6 }],
  ]) {
    const h = harness({ resolver: async () => records });
    await assert.rejects(
      h.fetcher("https://example.com"),
      /not publicly routable/,
    );
    assert.equal(h.requests.length, 0);
  }
  const h = harness({
    resolver: async () => {
      throw new Error("DNS failed");
    },
  });
  await assert.rejects(
    h.fetcher("https://example.com"),
    /not publicly routable/,
  );
  assert.equal(h.agents.length, 0);
});

test("redirect policies cannot turn a validated connection into a private fetch", async () => {
  const h = harness(
    {},
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest" },
      }),
  );
  await assert.rejects(
    h.fetcher("https://example.com"),
    /not publicly routable/,
  );
  assert.equal(h.requests.length, 1);
  assert.equal(h.agents[0].closed, 1);
  const manual = harness(
    {},
    () =>
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1" },
      }),
  );
  const response = await manual.fetcher("https://example.com", {
    redirect: "manual",
  });
  assert.equal(response.status, 302);
  assert.equal(manual.requests.length, 1);
  const refuse = harness(
    {},
    () => new Response(null, { status: 302, headers: { location: "/next" } }),
  );
  await assert.rejects(
    refuse.fetcher("https://example.com", { redirect: "error" }),
    /redirect refused/,
  );
  assert.equal(refuse.agents[0].destroyed, 1);
  const loop = harness(
    { maxRedirects: 1 },
    () => new Response(null, { status: 302, headers: { location: "/next" } }),
  );
  await assert.rejects(loop.fetcher("https://example.com"), /redirect limit/);
  assert.equal(loop.requests.length, 2);
  assert.equal(loop.agents[1].destroyed, 1);
});

test("body bytes and declared lengths are bounded and failures destroy their dispatcher", async () => {
  for (const contentLength of ["invalid", "5"]) {
    const h = harness(
      { maxResponseBytes: 4 },
      () => new Response("a", { headers: { "content-length": contentLength } }),
    );
    await assert.rejects(h.fetcher("https://example.com"), /byte budget/);
    assert.equal(h.agents[0].destroyed, 1);
  }
  const h = harness({ maxResponseBytes: 4 }, () => new Response("12345"));
  const response = await h.fetcher("https://example.com");
  await assert.rejects(response.text(), /byte budget/);
  assert.equal(h.agents[0].destroyed, 1);
  const failed = harness({}, () =>
    Promise.reject(new Error("transport failed")),
  );
  await assert.rejects(
    failed.fetcher("https://example.com"),
    /transport failed/,
  );
  assert.equal(failed.agents[0].destroyed, 1);
});

test("aborts during DNS, transport and body stalls, including an unread response", async () => {
  const resolver = harness({
    timeoutMs: 20,
    resolver: () => new Promise(() => {}),
  });
  await assert.rejects(resolver.fetcher("https://example.com"), /deadline/);
  assert.equal(resolver.requests.length, 0);
  const pending = harness({ timeoutMs: 20 }, () => new Promise(() => {}));
  await assert.rejects(pending.fetcher("https://example.com"), /deadline/);
  assert.equal(pending.agents[0].destroyed, 1);
  let cancelled = 0;
  const body = harness(
    { timeoutMs: 20 },
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled += 1;
            return new Promise(() => {});
          },
        }),
      ),
  );
  const response = await body.fetcher("https://example.com");
  await assert.rejects(response.text(), /deadline/);
  assert.equal(body.agents[0].destroyed, 1);
  assert.equal(cancelled, 1);
  const unread = harness(
    { timeoutMs: 20 },
    () => new Response(new ReadableStream()),
  );
  await unread.fetcher("https://example.com");
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(unread.agents[0].destroyed, 1);
});

test("caller cancellation and dispatcher-close failures retain their errors", async () => {
  const controller = new AbortController();
  controller.abort(new Error("caller cancelled"));
  const h = harness();
  await assert.rejects(
    h.fetcher("https://example.com", { signal: controller.signal }),
    /caller cancelled/,
  );
  assert.equal(h.resolutions(), 0);
  const lateController = new AbortController();
  const late = harness({}, () => new Response(new ReadableStream()));
  const lateResponse = await late.fetcher("https://example.com", {
    signal: lateController.signal,
  });
  const lateBody = lateResponse.text();
  lateController.abort(new Error("late caller cancelled"));
  await assert.rejects(lateBody, /late caller cancelled/);
  assert.equal(late.agents[0].destroyed, 1);
  const completedController = new AbortController();
  const completed = harness();
  assert.equal(
    await (
      await completed.fetcher("https://example.com", {
        signal: completedController.signal,
      })
    ).text(),
    "result",
  );
  completedController.abort(new Error("after completion"));
  assert.equal(completed.agents[0].closed, 1);
  assert.equal(completed.agents[0].destroyed, 0);
  const body = harness({}, () => new Response(new ReadableStream()));
  const response = await body.fetcher("https://example.com");
  await response.body!.cancel("caller finished");
  assert.equal(body.agents[0].destroyed, 1);
  const rejected = harness({
    dispatcher: () =>
      ({
        close: async () => {
          throw new Error("close failed");
        },
        destroy: async () => {},
      }) as unknown as Agent,
  });
  await assert.rejects(
    (await rejected.fetcher("https://example.com")).text(),
    /close failed/,
  );
  const failingCleanup = harness(
    {
      dispatcher: () =>
        ({
          close: async () => {},
          destroy: async () => {
            throw new Error("destroy failed");
          },
        }) as unknown as Agent,
    },
    () =>
      new Response(
        new ReadableStream({
          cancel: async () => {
            throw new Error("cancel failed");
          },
        }),
      ),
  );
  await (
    await failingCleanup.fetcher("https://example.com")
  ).body!.cancel("caller finished");
  await Promise.resolve();
});
