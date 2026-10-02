import { test, expect } from "@playwright/test";
import { gotoThroughRestart } from "./server-restart";

test("native page initializes inside the app source provider without issuing a read", async ({
  page,
}) => {
  const requests: string[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    requests.push(route.request().url());
    await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
  });
  await gotoThroughRestart(page, "/apis/native");
  await expect(page.getByRole("heading", { name: "Native chain", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Read state", exact: true })).toBeVisible();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(requests).toEqual([]);
});

const hash = `0x${"33".repeat(32)}`;
const source = {
  network: "finney",
  network_genesis_hash: `0x${"44".repeat(32)}`,
  finalized_block_hash: hash,
  finalized_block: "500",
  runtime_spec_version: 470,
  runtime_transaction_version: 1,
  runtime_code_hash: null,
  metadata_version: 15,
  metadata_sha256: `0x${"55".repeat(32)}`,
};
test.use({ serviceWorkers: "block" });
test("map records use leading keys and preserve source while advancing the cursor", async ({
  page,
}) => {
  const requests: unknown[] = [];
  let reads = 0;
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const discovery = body.operations[0].kind === "describe";
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [{ id: 0, path: ["NetUid"], definition: { kind: "primitive", primitive: 4 } }],
          results: discovery
            ? [
                {
                  kind: "describe",
                  value: [
                    {
                      kind: "storage",
                      pallet: "SubtensorModule",
                      member: "MinerCollateral",
                      key_type: 0,
                      key_parts: 1,
                    },
                  ],
                  contract: { next_offset: null },
                },
              ]
            : [
                {
                  kind: "entries",
                  pallet: "SubtensorModule",
                  member: "MinerCollateral",
                  value:
                    ++reads === 1
                      ? [
                          {
                            storage_key: "0x1122",
                            keys: [{ value: "19" }],
                            value: { locked: "9007199254740993" },
                          },
                        ]
                      : [],
                  contract: { next_cursor: reads === 1 ? "0x1122" : null },
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("button", { name: "Inspect contract" }).click();
  await page.getByRole("button", { name: "Browse records" }).click();
  await expect(page.getByRole("cell", { name: "9007199254740993", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Next records" }).click();
  await expect(page.getByRole("button", { name: "Next records" })).toHaveCount(0);
  expect(requests.slice(1)).toEqual([
    {
      as_of: hash,
      operations: [
        {
          kind: "entries",
          pallet: "SubtensorModule",
          member: "MinerCollateral",
          args: [],
          limit: 16,
        },
      ],
    },
    {
      as_of: hash,
      operations: [
        {
          kind: "entries",
          pallet: "SubtensorModule",
          member: "MinerCollateral",
          args: [],
          limit: 16,
          cursor: "0x1122",
        },
      ],
    },
  ]);
});
test("in-flight native reads cannot be relabeled by changing their inputs", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/v1/native-runtime", async (route) => {
    await gate;
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [],
          results: [{ kind: "storage", pallet: "P", member: "C", value: "2", contract: {} }],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("button", { name: "Read state", exact: true }).click();
  try {
    await expect(page.getByLabel("Feature", { exact: true })).toBeDisabled();
    await expect(page.getByLabel("Subnet", { exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole("cell", { name: "2", exact: true })).toBeVisible();
  await expect(page.getByLabel("Feature", { exact: true })).toBeEnabled();
});
test("native feature reads are explicit, exact and usable at phone width", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [],
          results: [
            {
              kind: "storage",
              pallet: "SubtensorModule",
              member: "MechanismCountCurrent",
              value: "2",
              contract: { root_type: 0 },
            },
            {
              kind: "storage",
              pallet: "SubtensorModule",
              member: "MechanismEmissionSplit",
              value: ["9007199254740993", "65535"],
              contract: { root_type: 1 },
            },
          ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await expect(page.getByRole("heading", { name: "Native chain", exact: true })).toBeVisible();
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Read state", exact: true }).click();
  await expect(page.getByRole("cell", { name: "9007199254740993", exact: true })).toBeVisible();
  await expect(page.getByText("v470 · metadata v15", { exact: true })).toBeVisible();
  expect(requests).toEqual([
    {
      operations: [
        { kind: "storage", pallet: "SubtensorModule", member: "MechanismCountCurrent", args: [19] },
        {
          kind: "storage",
          pallet: "SubtensorModule",
          member: "MechanismEmissionSplit",
          args: [19],
        },
      ],
    },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test("metadata-discovered calls use their declared arguments and pinned contract source", async ({
  page,
}) => {
  const requests: { operations: { kind: string }[]; as_of?: string }[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const discovery = body.operations[0].kind === "describe";
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [{ id: 0, path: ["TaoBalance"], definition: { kind: "primitive", primitive: 6 } }],
          results: discovery
            ? [
                {
                  kind: "describe",
                  value: [
                    {
                      kind: "prepare",
                      pallet: "SubtensorModule",
                      member: "stake",
                      args: [{ name: "amount", type: 0 }],
                    },
                  ],
                  contract: { total: 1, next_offset: null },
                },
              ]
            : [
                {
                  kind: "prepare",
                  pallet: "SubtensorModule",
                  member: "stake",
                  call_data: "0x0754010203",
                  contract: {},
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("button", { name: "Inspect contract" }).click();
  await expect(page.getByText("TaoBalance", { exact: true })).toBeVisible();
  await page.getByLabel("Arguments (JSON array)").fill("[9007199254740993]");
  await page.getByRole("button", { name: "Prepare unsigned call" }).click();
  await expect(page.getByRole("alert")).toContainText("decimal strings");
  expect(requests).toHaveLength(1);
  await page.getByLabel("Arguments (JSON array)").fill('["9007199254740993"]');
  await page.getByRole("button", { name: "Prepare unsigned call" }).click();
  await expect(page.getByRole("cell", { name: "0x0754010203", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Native wallet review" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign and submit reviewed call" })).toHaveCount(0);
  expect(requests[1]).toEqual({
    as_of: hash,
    operations: [
      { kind: "prepare", pallet: "SubtensorModule", member: "stake", args: ["9007199254740993"] },
    ],
  });
});
test("failed native reads do not leave a prior response presented as the new state", async ({
  page,
}) => {
  let count = 0;
  await page.route("**/api/v1/native-runtime", (route) =>
    route.fulfill(
      ++count === 1
        ? {
            json: {
              ok: true,
              data: {
                schema_version: 1,
                source,
                types: [],
                results: [
                  { kind: "storage", pallet: "P", member: "C", value: "123456", contract: {} },
                ],
              },
            },
          }
        : { status: 502, json: { ok: false, error: { message: "The finalized read failed." } } },
    ),
  );
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("button", { name: "Read state", exact: true }).click();
  await expect(page.getByRole("cell", { name: "123456", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Read state", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The finalized read failed.");
  await expect(page.getByRole("cell", { name: "123456", exact: true })).toHaveCount(0);
});

test("EVM execution is discovered and simulated using the displayed finalized contract", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const discovery = body.operations[0].kind === "describe";
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [{ id: 1, path: ["U256"], definition: { kind: "primitive", primitive: 8 } }],
          results: discovery
            ? [
                {
                  kind: "describe",
                  value: [
                    {
                      kind: "runtime",
                      api: "EthereumRuntimeRPCApi",
                      member: "call",
                      args: [{ name: "gas_limit", type: 1 }],
                    },
                  ],
                  contract: { next_offset: null },
                },
              ]
            : [
                {
                  kind: "runtime",
                  api: "EthereumRuntimeRPCApi",
                  member: "call",
                  value: {
                    variant: "Ok",
                    fields: {
                      exit_reason: { variant: "Revert", fields: {} },
                      value: "0xdeadbeef",
                      used_gas: "22000",
                    },
                  },
                  contract: { root_type: 1 },
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Explore EVM execution" }).click();
  await expect(
    page.getByText("each request can use up to 1,000,000 gas.", { exact: false }),
  ).toBeVisible();
  await page.getByLabel("Arguments (JSON array)").fill('["500000"]');
  await page.getByRole("button", { name: "Read operation" }).click();
  await expect(page.getByRole("cell", { name: "0xdeadbeef", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Native wallet review" })).toHaveCount(0);
  expect(requests).toEqual([
    { operations: [{ kind: "describe", api: "EthereumRuntimeRPCApi", offset: 0, limit: 32 }] },
    {
      as_of: hash,
      operations: [
        { kind: "runtime", api: "EthereumRuntimeRPCApi", member: "call", args: ["500000"] },
      ],
    },
  ]);
});

test("Wasm contracts use discovered Weight arguments and retain reverted bytes without a signing action", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const discovery = body.operations[0].kind === "describe";
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [{ id: 1, path: ["Weight"], definition: { kind: "primitive", primitive: 6 } }],
          results: discovery
            ? [
                {
                  kind: "describe",
                  value: [
                    {
                      kind: "runtime",
                      api: "ContractsApi",
                      member: "call",
                      args: [{ name: "gas_limit", type: 1 }],
                    },
                  ],
                  contract: { next_offset: null },
                },
              ]
            : [
                {
                  kind: "runtime",
                  api: "ContractsApi",
                  member: "call",
                  value: { result: { variant: "Ok", fields: { flags: "1", data: "0xbeef" } } },
                  contract: { root_type: 1 },
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  expect(requests).toHaveLength(0);
  await page.getByRole("button", { name: "Explore Wasm contracts" }).click();
  await expect(
    page.getByText("simulation does not publish code or a contract.", { exact: false }),
  ).toBeVisible();
  const gas = { variant: "Some", fields: { ref_time: "100000000000", proof_size: "32768" } };
  await page.getByLabel("Arguments (JSON array)").fill(JSON.stringify([gas]));
  await page.getByRole("button", { name: "Read operation" }).click();
  await expect(page.getByRole("cell", { name: "0xbeef", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Native wallet review" })).toHaveCount(0);
  expect(requests).toEqual([
    { operations: [{ kind: "describe", api: "ContractsApi", offset: 0, limit: 32 }] },
    {
      as_of: hash,
      operations: [{ kind: "runtime", api: "ContractsApi", member: "call", args: [gas] }],
    },
  ]);
});
