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

  test("server-function fields cannot override results", async ({ page }, testInfo) => {
    // Exercise the compiled public input boundary with benign JSON metadata.
    // A normal navigation supplies the current URL and a positive control;
    // no generated function ID, HTML payload or script execution is assumed.
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
    expect(normalResponse.ok()).toBe(true);
    await expect(page.getByRole("heading", { name: "Documentation", level: 1 })).toBeVisible();

    const target = new URL(normalResponse.url());
    expect(target.origin).toBe(new URL(page.url()).origin);
    expect(["localhost", "127.0.0.1"]).toContain(target.hostname);
    const marker = "unexpected-transport-result";
    target.searchParams.set(
      "payload",
      JSON.stringify(
        await toJSONAsync({
          data: { invalidSlugs: true },
          result: { marker },
        }),
      ),
    );
    const response = await page.request.get(target.href, {
      headers: { "x-tsr-serverFn": "true" },
    });
    const contentType = response.headers()["content-type"];
    const body = await response.text();
    await testInfo.attach("server-function-input-boundary", {
      contentType: "application/json",
      body: JSON.stringify({
        transport_path: target.pathname,
        control_status: normalResponse.status(),
        malformed_status: response.status(),
        content_type: contentType,
        unexpected_result_in_body: body.includes(marker),
      }),
    });
    expect(contentType).not.toContain("text/html");
    expect(body).not.toContain(marker);
  });
});
