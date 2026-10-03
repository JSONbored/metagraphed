import { expect, test } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart.ts";

const DELAYED_READS = [
  "**/api/v1/subnets/19/ohlc*",
  "**/api/v1/subnets/19/history*",
  "**/api/v1/subnets/19/event-summary*",
  "**/api/v1/subnets/19/validators*",
  "**/api/v1/subnets/19/surfaces*",
  "**/api/v1/subnets/19/uptime*",
  "**/api/v1/subnets/19/emission-split/history*",
  "**/api/v1/subnets/19/registrations*",
  "**/api/v1/subnets/19/deregistrations*",
  "**/api/v1/economics*",
  "**/api/v1/domains*",
];

test.describe("Subnet detail secondary query states", () => {
  test("keeps below-fold evidence off the cold first read", async ({ page }) => {
    const deferredPaths = new Set([
      "/api/v1/subnets/19/surfaces",
      "/api/v1/subnets/19/event-summary",
      "/api/v1/subnets/19/cost-to-participate",
      "/api/v1/subnets/19/registrations",
      "/api/v1/subnets/19/deregistrations",
      "/api/v1/domains",
      "/api/v1/subnets/19/ownership-history",
    ]);
    const prematureReads: string[] = [];
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (deferredPaths.has(path)) prematureReads.push(path);
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets/19");

    await expect(page.locator("#surfaces .mg-rails-row--skeleton")).toHaveCount(8);
    await expect(page.locator("#activity .mg-rails-row--skeleton")).toHaveCount(10);
    await expect(page.locator("#participation .mg-rails-row--skeleton")).toHaveCount(3);
    await expect(page.getByText("published surfaces · 90d probe uptime · registry")).toBeVisible();
    expect(prematureReads).toEqual([]);
  });

  test("defers below-fold evidence without losing its structured pending instruments", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let release: (() => void) | undefined;
    const continueReads = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested: string[] = [];
    for (const pattern of DELAYED_READS) {
      await page.route(pattern, async (route) => {
        requested.push(new URL(route.request().url()).pathname);
        await continueReads;
        await route.continue();
      });
    }

    await gotoThroughRestart(page, "/subnets/19");

    await expect(page.locator("#surfaces .mg-rails-row--skeleton")).toHaveCount(8);
    await expect(page.locator("#activity .mg-rails-row--skeleton")).toHaveCount(10);
    await expect(page.locator("#participation .mg-rails-row--skeleton")).toHaveCount(3);
    await expect(page.locator("#peers .mg-rank-grid-row--skeleton")).toHaveCount(5);
    await expect(
      page.getByText("registry domain when available · otherwise neighboring emission rank"),
    ).toBeVisible();

    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    for (const [section, path] of [
      ["#surfaces", "/api/v1/subnets/19/surfaces"],
      ["#activity", "/api/v1/subnets/19/event-summary"],
      ["#participation", "/api/v1/subnets/19/registrations"],
      ["#peers", "/api/v1/domains"],
    ] as const) {
      await page
        .locator(section)
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect.poll(() => requested.includes(path)).toBe(true);
    }

    const activity = page.getByRole("group", { name: "Subnet 19 events by kind, 30 days" });
    const activityCategories = page.getByRole("group", { name: "Events by category" });
    const momentum = page.locator("#sn-19-price .mg-line-plot");
    const emission = page.getByRole("group", { name: "Subnet 19 daily emission by recipient" });
    const emissionLegend = page.getByRole("group", { name: "Emission by recipient class" });
    const validators = page.getByRole("group", { name: "Subnet 19 validators by stake" });
    const surfaces = page.getByRole("group", { name: "Subnet 19 surface uptime over 90 days" });
    const churn = page.getByRole("group", { name: "Subnet 19 slot movement over 30 days" });
    const peers = page.getByRole("group", { name: "Loading subnet peer comparison" });
    const comparable = page.getByRole("group", { name: "Loading comparable subnets" });

    await expect(activity).toHaveAttribute("aria-busy", "true");
    await expect(activityCategories).toHaveAttribute("aria-busy", "true");
    await expect(momentum).toHaveAttribute("aria-busy", "true");
    await expect(emission).toHaveAttribute("aria-busy", "true");
    await expect(emissionLegend).toHaveAttribute("aria-busy", "true");
    await expect(validators).toHaveAttribute("aria-busy", "true");
    await expect(surfaces).toHaveAttribute("aria-busy", "true");
    await expect(churn).toHaveAttribute("aria-busy", "true");
    await expect(peers).toHaveAttribute("aria-busy", "true");
    await expect(comparable).toHaveAttribute("aria-busy", "true");
    await expect(activity.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(activityCategories.locator(".mg-rank-grid-row--skeleton")).toHaveCount(4);
    await expect(emission.locator(".mg-stack-col--skeleton")).toHaveCount(30);
    await expect(emissionLegend.locator(".mg-rank-grid-row--skeleton")).toHaveCount(4);
    await expect(validators.locator(".mg-rails-row--skeleton")).toHaveCount(10);
    await expect(surfaces.locator(".mg-rails-row--skeleton")).toHaveCount(8);
    await expect(churn.locator(".mg-rails-row--skeleton")).toHaveCount(3);
    await expect(peers.locator(".mg-rank-grid-row--skeleton")).toHaveCount(5);
    await expect(comparable.locator("li[aria-hidden='true']")).toHaveCount(4);
    await expect(page.getByText("Loading 30d event activity · chain-direct")).toBeVisible();
    await expect(
      page.getByText("Loading 30d price and stake readings · chain-direct"),
    ).toBeVisible();
    await expect(page.getByText("Loading 30d emission recipients · chain-direct")).toBeVisible();
    await expect(page.getByText("Loading validator records · chain-direct")).toBeVisible();
    await expect(page.getByText("Loading surfaces and 90d uptime · registry")).toBeVisible();
    await expect(page.getByText("Loading 30d registration activity · chain-direct")).toBeVisible();
    await expect(page.getByText("loading subnet peer context", { exact: true })).toBeVisible();
    await expect(page.getByText(/0 events across 0 kinds/)).toHaveCount(0);
    await expect(page.getByText(/0 with a permit/)).toHaveCount(0);
    await expect(page.getByText(/0 of 0 probed/)).toHaveCount(0);
    await expect(page.getByText("no registry domain · ranked by emission share")).toHaveCount(0);

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);

    const completedReads = [...new Set(requested)].map((path) =>
      page.waitForResponse((response) => new URL(response.url()).pathname === path),
    );
    release?.();
    await Promise.all(completedReads);
    await expect(activity).not.toHaveAttribute("aria-busy", "true");
    await expect(activityCategories).not.toHaveAttribute("aria-busy", "true");
    await expect(momentum).not.toHaveAttribute("aria-busy", "true");
    await expect(emission).not.toHaveAttribute("aria-busy", "true");
    await expect(emissionLegend).not.toHaveAttribute("aria-busy", "true");
    await expect(validators).not.toHaveAttribute("aria-busy", "true");
    await expect(surfaces).not.toHaveAttribute("aria-busy", "true");
    await expect(churn).not.toHaveAttribute("aria-busy", "true");
    await expect(peers).toHaveCount(0);
    await expect(comparable).toHaveCount(0);
    await expect(page.locator("#peers .mg-rank-grid")).not.toHaveAttribute("aria-busy", "true");
    await expect(page.locator("#peers .mg-leaders")).not.toHaveAttribute("aria-busy", "true");
  });

  test("keeps a peer-data failure actionable and reserves emission fallback for a domain failure", async ({
    page,
  }) => {
    let economicsFails = true;
    let domainsFail = true;
    await page.route("**/api/v1/economics*", async (route) => {
      if (economicsFails) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Peer economics fixture failed" },
          }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/api/v1/domains*", async (route) => {
      if (domainsFail) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Domain fixture failed" },
          }),
        });
        return;
      }
      await route.continue();
    });

    await page.setViewportSize({ width: 375, height: 812 });
    await gotoThroughRestart(page, "/subnets/19");

    const peerSection = page.locator("#peers");
    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    await peerSection.evaluate((element) => element.scrollIntoView({ block: "center" }));
    const peerError = peerSection.getByRole("alert");
    await page.getByRole("button", { name: "refresh", exact: true }).click();
    await expect(peerError).toContainText("Couldn't load the subnet peer comparison");
    await expect(peerSection.getByRole("group", { name: "Emission neighbours" })).toHaveCount(0);

    economicsFails = false;
    domainsFail = false;
    await peerError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(peerError).toHaveCount(0);
    await expect(peerSection.getByRole("group", { name: "Emission neighbours" })).toBeVisible();
    await expect(
      peerSection.getByText("registry domain unavailable · ranked by emission share", {
        exact: true,
      }),
    ).toBeVisible();
  });

  test("keeps failed activity, validator, and emission records scoped and retryable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let failReads = true;
    const failedRecords = [
      "**/api/v1/subnets/19/event-summary*",
      "**/api/v1/subnets/19/validators*",
      "**/api/v1/subnets/19/emission-split/history*",
    ];
    for (const pattern of failedRecords) {
      await page.route(pattern, async (route) => {
        if (!failReads) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Subnet record fixture failed" },
          }),
        });
      });
    }

    await gotoThroughRestart(page, "/subnets/19");

    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    await page
      .locator("#activity")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));

    const activityError = page.locator("#activity").getByRole("alert");
    const validatorsError = page.locator("#validators").getByRole("alert");
    const emissionError = page.locator("#emission-split").getByRole("alert");
    await expect(activityError).toContainText("Couldn't load 30-day subnet event activity");
    await expect(validatorsError).toContainText("Couldn't load subnet validator records");
    await expect(emissionError).toContainText("Couldn't load 30d emission recipients");
    await expect(page.getByText(/temporarily unavailable · (chain-direct|registry)/)).toHaveCount(
      0,
    );

    failReads = false;
    await activityError.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(activityError).toHaveCount(0);
    await expect(
      page.getByRole("group", { name: "Subnet 19 events by kind, 30 days" }),
    ).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });

  test("keeps independent surface, participation, and momentum failures distinguishable", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    let failReads = true;
    const failedRecords = [
      "**/api/v1/subnets/19/surfaces*",
      "**/api/v1/subnets/19/uptime*",
      "**/api/v1/subnets/19/cost-to-participate*",
      "**/api/v1/subnets/19/registrations*",
      "**/api/v1/subnets/19/deregistrations*",
      "**/api/v1/subnets/19/ohlc*",
      "**/api/v1/subnets/19/history*",
    ];
    for (const pattern of failedRecords) {
      await page.route(pattern, async (route) => {
        if (!failReads) {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: { code: "fixture_failure", message: "Subnet record fixture failed" },
          }),
        });
      });
    }

    await gotoThroughRestart(page, "/subnets/19");

    await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
    await page.evaluate(() => {
      document.documentElement.style.scrollBehavior = "auto";
    });
    await page
      .locator("#surfaces")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));
    await expect(page.locator("#surfaces").getByRole("alert")).toBeVisible();
    await page
      .locator("#participation")
      .evaluate((element) => element.scrollIntoView({ block: "center" }));

    const surfaceError = page.locator("#surfaces").getByRole("alert");
    const participationErrors = page.locator("#participation").getByRole("alert");
    const priceError = page.locator("#momentum").getByRole("alert").first();
    const historyError = page.locator("#momentum").getByRole("alert").last();
    await expect(surfaceError).toContainText("Couldn't load published subnet surfaces");
    await expect(participationErrors).toHaveCount(2);
    await expect(participationErrors.first()).toContainText(
      "Couldn't load subnet participation floors",
    );
    await expect(participationErrors.last()).toContainText(
      "Couldn't load 30-day registration activity",
    );
    await expect(priceError).toContainText("Couldn't load 30d alpha price history");
    await expect(historyError).toContainText("Couldn't load 30d subnet stake and emission history");

    failReads = false;
    await participationErrors.first().getByRole("button", { name: "Retry", exact: true }).click();
    await expect(
      page
        .locator("#participation")
        .getByRole("alert")
        .filter({ hasText: "Couldn't load subnet participation floors" }),
    ).toHaveCount(0);
    await expect(page.locator("#participation .mg-facts")).toBeVisible();

    const dimensions = await page.evaluate(() => ({
      document: document.documentElement.scrollWidth,
      viewport: window.innerWidth,
    }));
    expect(dimensions.document).toBeLessThanOrEqual(dimensions.viewport);
  });
});

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
          request_content_types: ["application/json", "text/plain", "multipart/form-data", "application/octet-stream"],
          request_body_required: true,
        },
        { method: "GET", path: "/search/live/result/{uuid}" },
        {
          method: "PATCH",
          path: "/document",
          request_content_types: ["application/merge-patch+json"],
          request_body_required: true,
        },
        {
          method: "PUT",
          path: "/bytes",
          request_content_types: ["application/octet-stream"],
          request_body_required: true,
        },
        {
          method: "POST",
          path: "/multipart",
          request_content_types: ["multipart/form-data"],
          request_body_required: true,
        },
      ],
    },
  },
];

for (const width of [375, 768, 1280]) {
  for (const colorScheme of ["light", "dark"] as const) {
    test(`reviewed integration details ${width}px ${colorScheme}`, async ({ page, context }) => {
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
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
      const surfaceRead = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/v1/subnets/19/surfaces" &&
          response.status() === 200,
      );
      await gotoThroughRestart(page, "/subnets/19");
      await page.waitForFunction(() => window.__MG_HYDRATED__ === true);
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await page.evaluate(() => {
        document.documentElement.style.scrollBehavior = "auto";
      });
      await page
        .locator("#surfaces")
        .evaluate((element) => element.scrollIntoView({ block: "center" }));
      await surfaceRead;
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
      await expect(
        details.getByText("write_subnet_surface", { exact: true }).first(),
      ).toBeVisible();
      await expect(details.getByText("call_subnet_surface", { exact: true })).toBeVisible();
      await expect(
        details.getByRole("button", { name: "Copy Fixture MCP MCP discovery", exact: true }),
      ).toBeVisible();
      await expect(
        details.getByText(/multipart boundaries must match the encoded body/),
      ).toBeVisible();
      for (const [method, path, body] of [
        ["PATCH", "/document", { json_body: {}, content_type: "application/merge-patch+json" }],
        [
          "PUT",
          "/bytes",
          {
            content_type: "application/octet-stream",
            body_base64: "<canonical base64 of the exact request bytes>",
          },
        ],
        [
          "POST",
          "/multipart",
          {
            content_type: "multipart/form-data; boundary=REPLACE_WITH_YOUR_BOUNDARY",
            body_base64:
              "<canonical base64 of the complete multipart body with the matching boundary>",
          },
        ],
      ] as const) {
        await details
          .getByRole("button", { name: `Copy ${method} ${path} call template`, exact: true })
          .click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(
            JSON.stringify({
              name: "write_subnet_surface",
              arguments: { surface_id: "sn-19-fixture-http", path, method, ...body },
            }),
          );
      }
      const formats = details.getByRole("combobox", { name: "Request format POST /search/live", exact: true });
      await expect(formats).toHaveValue("application/json");
      for (const [media, body] of [
        ["text/plain", { content_type: "text/plain", body: "<replace with the provider's encoded request body>" }],
        ["multipart/form-data", { content_type: "multipart/form-data; boundary=REPLACE_WITH_YOUR_BOUNDARY", body_base64: "<canonical base64 of the complete multipart body with the matching boundary>" }],
        ["application/json", { json_body: {} }],
      ] as const) {
        await formats.selectOption(media);
        await details.getByRole("button", { name: "Copy POST /search/live call template", exact: true }).click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify({
          name: "write_subnet_surface", arguments: { surface_id: "sn-19-fixture-http", path: "/search/live", method: "POST", ...body },
        }));
      }
      const artifactFormats = details.getByRole("combobox", { name: "Request format POST from artifact /search/live", exact: true });
      await artifactFormats.focus();
      await page.keyboard.press("End");
      await expect(artifactFormats).toHaveValue("application/octet-stream");
      await details.getByRole("button", { name: "Copy POST from artifact /search/live call template", exact: true }).click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(JSON.stringify({
        name: "write_subnet_surface", arguments: { surface_id: "sn-19-fixture-http", path: "/search/live", method: "POST",
          content_type: "application/octet-stream", body_artifact: {
            url: "<public raw.githubusercontent.com URL with a full 40-character commit>",
            sha256: "<lowercase SHA-256 of the complete request bytes>",
            bytes: "<exact complete request byte count, at most 10000000>",
          } },
      }));
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
