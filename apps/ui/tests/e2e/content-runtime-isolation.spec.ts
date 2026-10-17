import { expect, test } from "@playwright/test";
import { fromJSON, toJSONAsync } from "seroval";
import { gotoThroughRestart } from "./server-restart.ts";

const OPENAPI_CHUNK = /\/assets\/openapi-page-[^/]+\.js(?:\?|$)/;

function recordOpenAPIChunks(page: Parameters<typeof gotoThroughRestart>[0]): string[] {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (OPENAPI_CHUNK.test(request.url())) requests.push(request.url());
  });
  return requests;
}

test.describe("content route runtime isolation", () => {
  test("a hand-written guide does not load the API-reference renderer", async ({ page }) => {
    const openapiChunks = recordOpenAPIChunks(page);
    await gotoThroughRestart(page, "/docs/mcp");
    await expect(page.getByRole("heading", { name: "MCP", level: 1 })).toBeVisible();
    expect(openapiChunks).toEqual([]);
  });

  test("a digest does not load the API-reference renderer", async ({ page }) => {
    const openapiChunks = recordOpenAPIChunks(page);
    await gotoThroughRestart(page, "/news/sn19/2026-w17");
    await expect(page.getByRole("heading", { name: /Subnet 19.*2026-W17/i })).toBeVisible();
    expect(openapiChunks).toEqual([]);
  });

  test("an API-reference page resolves its isolated renderer", async ({ page }) => {
    const openapiChunks = recordOpenAPIChunks(page);
    await gotoThroughRestart(page, "/docs/api-reference/subnets/subnets-by-network");
    await expect(page.getByRole("heading", { name: "Subnets By Network" })).toBeVisible();
    await expect(
      page.getByText("/api/v1/{network}/subnets", { exact: false }).first(),
    ).toBeVisible();
    await expect.poll(() => openapiChunks.length).toBe(1);
  });

  test("a malformed server-function link cannot become an HTML document", async ({
    page,
  }, testInfo) => {
    // GHSA-qx66-fv34-fjm8: exercise the compiled public transport, not a mock
    // handler or a hard-coded generated function ID. A normal client navigation
    // supplies both the current URL and a positive control for that function.
    await gotoThroughRestart(page, "/news/sn19/2026-w17");
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    const normalCall = page.waitForResponse((response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/_serverFn/") || response.request().method() !== "GET")
        return false;
      const payload = url.searchParams.get("payload");
      if (!payload) return false;
      const input = fromJSON(JSON.parse(payload)) as { data?: unknown };
      // Distinguish the docs slug loader from unrelated header/palette calls.
      return Array.isArray(input.data) && input.data.length === 0;
    });
    await page.locator("footer").getByRole("link", { name: "Docs", exact: true }).click();
    const normalResponse = await normalCall;
    expect(normalResponse.status()).toBe(200);
    expect(normalResponse.request().method()).toBe("GET");
    expect(normalResponse.request().isNavigationRequest()).toBe(false);
    const controlHeaders = await normalResponse.request().allHeaders();
    expect(controlHeaders["x-tsr-serverfn"]).toBe("true");
    await expect(page.getByRole("heading", { name: "Documentation", level: 1 })).toBeVisible();

    const target = new URL(normalResponse.url());
    expect(target.origin).toBe(new URL(page.url()).origin);
    expect(["localhost", "127.0.0.1"]).toContain(target.hostname);
    const marker = "metagraph-server-function-canary";
    const html =
      `<p id="${marker}">Untrusted transport result</p>` +
      "<script>globalThis.__METAGRAPH_SERVER_FUNCTION_CANARY__ = true</script>";
    target.searchParams.set(
      "payload",
      JSON.stringify(
        await toJSONAsync({
          // The docs loader expects an array of slugs. Its failure must not
          // leave this untrusted result eligible for response handling.
          data: { invalidSlugs: true },
          result: {
            constructor: { name: "HTTPResponse" },
            status: 200,
            headers: { "content-type": "text/html" },
            body: html,
          },
        }),
      ),
    );

    // A document navigation deliberately carries no x-tsr-serverFn header,
    // matching the unauthenticated link-opening boundary in the advisory.
    const response = await gotoThroughRestart(page, target.href);
    expect(response).not.toBeNull();
    const attackRequest = response!.request();
    const attackHeaders = await attackRequest.allHeaders();
    const responseHeaders = response!.headers();
    const contentType = responseHeaders["content-type"];
    const body = await response!.text();
    const executed = await page.evaluate(
      () => Reflect.get(globalThis, "__METAGRAPH_SERVER_FUNCTION_CANARY__") === true,
    );
    await testInfo.attach("server-function-response-boundary", {
      contentType: "application/json",
      body: JSON.stringify({
        transport_path: target.pathname,
        control_status: normalResponse.status(),
        attack_status: response!.status(),
        content_type: contentType,
        control_internal_header: controlHeaders["x-tsr-serverfn"],
        attack_internal_header_present: "x-tsr-serverfn" in attackHeaders,
        attack_navigation: attackRequest.isNavigationRequest(),
        attack_method: attackRequest.method(),
        serialized: responseHeaders["x-tss-serialized"],
        raw: responseHeaders["x-tss-raw"],
        canary_in_body: body.includes(marker),
        canary_executed: executed,
      }),
    });
    expect(attackRequest.method()).toBe("GET");
    expect(attackRequest.isNavigationRequest()).toBe(true);
    expect(attackHeaders["x-tsr-serverfn"]).toBeUndefined();
    // A loader error is serialized inside a successful transport response.
    // A generic 4xx/5xx could conceal a missing route or unrelated SSR failure.
    expect(response!.status()).toBe(200);
    expect(contentType).toMatch(/^application\/json(?:\s*;|$)/i);
    expect(responseHeaders["x-tss-serialized"]).toBe("true");
    expect(responseHeaders["x-tss-raw"]).not.toBe("true");
    expect(() => JSON.parse(body)).not.toThrow();
    expect(body).not.toContain(marker);
    expect(body).not.toContain("__METAGRAPH_SERVER_FUNCTION_CANARY__");
    await expect(page.locator(`#${marker}`)).toHaveCount(0);
    expect(executed).toBe(false);
  });
});
