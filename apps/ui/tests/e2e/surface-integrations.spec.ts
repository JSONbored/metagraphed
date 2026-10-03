import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const surfaces = [
  {
    id: "sn-19-fixture-mcp",
    name: "Fixture MCP",
    netuid: 19,
    kind: "subnet-api",
    url: "https://subnet.example/mcp",
    auth_required: true,
    mcp: {
      transport: "streamable-http",
      read_tools: ["read"],
      write_tools: ["write"],
      read_prompts: ["plan"],
      read_resources: ["fixture://taxonomy"],
    },
  },
  {
    id: "sn-19-fixture-http",
    name: "Fixture HTTP",
    netuid: 19,
    kind: "subnet-api",
    url: "https://subnet.example/api",
    auth_required: false,
    http: {
      operations: [
        {
          method: "POST",
          path: "/search/live",
          request_content_types: ["application/json"],
          request_body_required: true,
        },
        { method: "GET", path: "/search/live/result/{uuid}" },
      ],
    },
  },
];

for (const width of [375, 768, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`reviewed integration details ${width}px ${colorScheme}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme });
      const requests: string[] = [];
      page.on("request", (request) => {
        requests.push(new URL(request.url()).pathname);
      });
      await page.route("https://subnet.example/**", (route) => route.abort());
      await page.route("**/api/v1/subnets/19/surfaces*", (route) =>
        route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ ok: true, data: { surfaces } }),
        }),
      );
      await gotoThroughRestart(page, "/subnets/19");
      await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
      await page
        .locator("#surfaces")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      const toggle = page.getByRole("button", { name: "Show integration details" });
      await expect(toggle).toBeVisible();
      await expect(toggle).toHaveAttribute("aria-expanded", "false");
      await expect(page.locator("#surface-integrations")).toHaveCount(0);
      const before = requests.filter((path) => path === "/api/v1/subnets/19/surfaces").length;
      await toggle.focus();
      await page.keyboard.press("Enter");
      const details = page.locator("#surface-integrations");
      await expect(details).toBeVisible();
      await expect(page.getByRole("button", { name: "Hide integration details" })).toHaveAttribute(
        "aria-expanded",
        "true",
      );
      await expect(
        details.getByText("Caller authentication required", { exact: true }),
      ).toBeVisible();
      await expect(details.getByText("read_subnet_mcp", { exact: true })).toBeVisible();
      await expect(details.getByText("write_subnet_mcp", { exact: true })).toBeVisible();
      await expect(details.getByText("get_subnet_mcp_prompt", { exact: true })).toBeVisible();
      await expect(details.getByText("read_subnet_mcp_resource", { exact: true })).toBeVisible();
      await expect(details.getByText("write_subnet_surface", { exact: true })).toBeVisible();
      await expect(details.getByText("call_subnet_surface", { exact: true })).toBeVisible();
      await expect(
        details.getByRole("button", { name: "Copy Fixture MCP MCP discovery", exact: true }),
      ).toBeVisible();
      expect(requests.filter((path) => path.includes("agent-catalog"))).toEqual([]);
      expect(requests.filter((path) => path === "/api/v1/subnets/19/surfaces").length).toBe(before);
      expect(
        requests.filter(
          (path) => path === "/mcp" || path === "/api" || path.startsWith("/search/"),
        ),
      ).toEqual([]);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
      await page.getByRole("button", { name: "Hide integration details" }).click();
      await expect(details).toHaveCount(0);
    });
  }
}
