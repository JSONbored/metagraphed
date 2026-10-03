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
test("neuron UID pages fetch singular records and continue the saved subnet, format and finalized source", async ({
  page,
}) => {
  const requests: {
    as_of?: string;
    operations: { kind: string; member: string; args: number[] }[];
  }[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const count = body.operations[0].member === "SubnetworkN";
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [],
          results: count
            ? [
                {
                  kind: "storage",
                  pallet: "SubtensorModule",
                  member: "SubnetworkN",
                  value: "19",
                  contract: {},
                },
              ]
            : body.operations.map(
                (operation: { kind: string; member: string; args: number[] }) => ({
                  kind: operation.kind,
                  api: "NeuronInfoRuntimeApi",
                  member: operation.member,
                  contract: {},
                  value:
                    operation.args[1] === 3
                      ? { variant: "None", fields: {} }
                      : { uid: String(operation.args[1]), stake: "9007199254740993" },
                }),
              ),
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  expect(requests).toEqual([]);
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(page.getByText("Subnet 19 · UID 0 · 19 UID slots", { exact: true })).toBeVisible();
  await expect(
    page.getByText("4. NeuronInfoRuntimeApi.get_neuron.variant", { exact: true }),
  ).toBeVisible();
  expect(requests).toHaveLength(2);
  expect(requests[0]).toEqual({
    operations: [{ kind: "storage", pallet: "SubtensorModule", member: "SubnetworkN", args: [19] }],
  });
  expect(requests[1]).toEqual({
    as_of: hash,
    operations: Array.from({ length: 16 }, (_, uid) => ({
      kind: "runtime",
      api: "NeuronInfoRuntimeApi",
      member: "get_neuron",
      args: [19, uid],
    })),
  });
  await page.getByRole("textbox", { name: "Neuron subnet", exact: true }).fill("20");
  await page.getByRole("textbox", { name: "Starting UID", exact: true }).fill("14");
  await page.getByRole("textbox", { name: "Neurons per page", exact: true }).fill("1");
  await page.getByRole("checkbox", { name: "Lite records", exact: true }).check();
  await page.getByRole("button", { name: "Next neuron page", exact: true }).click();
  await expect(page.getByText("Subnet 19 · UID 16 · 19 UID slots", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[2]).toEqual({
    as_of: hash,
    operations: [16, 17, 18].map((uid) => ({
      kind: "runtime",
      api: "NeuronInfoRuntimeApi",
      member: "get_neuron",
      args: [19, uid],
    })),
  });
  await expect(page.getByRole("button", { name: "Next neuron page", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(page.getByText("Subnet 20 · UID 14 · 19 UID slots", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(5);
  expect(requests[3]).toEqual({
    operations: [{ kind: "storage", pallet: "SubtensorModule", member: "SubnetworkN", args: [20] }],
  });
  expect(requests[4]).toEqual({
    as_of: hash,
    operations: [
      { kind: "runtime", api: "NeuronInfoRuntimeApi", member: "get_neuron_lite", args: [20, 14] },
    ],
  });
});

test("historical neuron pages use qualified byte reads while empty ranges issue no record request", async ({
  page,
}) => {
  const requests: unknown[] = [],
    oldHash = `0x${"ab".repeat(32)}`;
  let empty = false;
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source: {
            ...source,
            finalized_block_hash: oldHash,
            runtime_spec_version: 210,
            metadata_version: 14,
          },
          types: [],
          results:
            body.operations[0].member === "SubnetworkN"
              ? [
                  {
                    kind: "storage",
                    pallet: "SubtensorModule",
                    member: "SubnetworkN",
                    value: empty ? "0" : "3",
                    contract: {},
                  },
                ]
              : body.operations.map(
                  (operation: { kind: string; member: string }, index: number) => ({
                    kind: operation.kind,
                    api: "NeuronInfoRuntimeApi",
                    member: operation.member,
                    contract: {},
                    value: "0x",
                    inner_result: index === 1 ? null : { uid: "1", stake: "9007199254740993" },
                  }),
                ),
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page
    .getByRole("textbox", { name: "Finalized block hash (optional)", exact: true })
    .fill(oldHash);
  await page.getByRole("textbox", { name: "Starting UID", exact: true }).fill("1");
  await page.getByRole("checkbox", { name: "Lite records", exact: true }).check();
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(
    page.getByText("2. NeuronInfoRuntimeApi.get_neuron_lite.inner_result", { exact: true }),
  ).toBeVisible();
  expect(requests[1]).toEqual({
    as_of: oldHash,
    operations: ["0100", "0200"].map((uid) => ({
      kind: "runtime_scale",
      api: "NeuronInfoRuntimeApi",
      member: "get_neuron_lite",
      input: `0x1300${uid}`,
      decode_inner: true,
    })),
  });
  empty = true;
  await page.getByRole("textbox", { name: "Starting UID", exact: true }).fill("0");
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(page.getByText("Subnet 19 · UID 0 · 0 UID slots", { exact: true })).toBeVisible();
  expect(requests).toHaveLength(3);
  await expect(page.getByRole("button", { name: "Next neuron page", exact: true })).toHaveCount(0);
});

test("neuron page admission and source failures clear partial results and allow a clean retry", async ({
  page,
}) => {
  const requests: unknown[] = [];
  let mismatch = true;
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const count = body.operations[0].member === "SubnetworkN";
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source: {
            ...source,
            finalized_block_hash: !count && mismatch ? `0x${"ab".repeat(32)}` : hash,
          },
          types: [],
          results: count
            ? [
                {
                  kind: "storage",
                  pallet: "SubtensorModule",
                  member: "SubnetworkN",
                  value: "1",
                  contract: {},
                },
              ]
            : [
                {
                  kind: "runtime",
                  api: "NeuronInfoRuntimeApi",
                  member: "get_neuron",
                  value: { uid: "0" },
                  contract: {},
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("textbox", { name: "Neurons per page", exact: true }).fill("17");
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(page.locator('[role="alert"]')).toContainText("page size from 1 through 16");
  expect(requests).toEqual([]);
  await page.getByRole("textbox", { name: "Neurons per page", exact: true }).fill("16");
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(page.locator('[role="alert"]')).toContainText("changed their finalized source");
  await expect(page.getByRole("button", { name: "Next neuron page", exact: true })).toHaveCount(0);
  expect(requests).toHaveLength(2);
  mismatch = false;
  await page.getByRole("button", { name: "Read neuron page", exact: true }).click();
  await expect(page.getByText("Subnet 19 · UID 0 · 1 UID slots", { exact: true })).toBeVisible();
  await expect(page.locator('[role="alert"]')).toHaveCount(0);
  expect(requests).toHaveLength(4);
});
test("historical runtime inspection decodes qualified legacy records and resets selection for a new source", async ({
  page,
}) => {
  const oldHash = `0x${"ab".repeat(32)}`,
    requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const discovery = body.operations[0].kind === "describe",
      old = body.as_of === oldHash;
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source: {
            ...source,
            finalized_block_hash: body.as_of ?? hash,
            runtime_spec_version: old ? 210 : 470,
          },
          types: [],
          results: discovery
            ? [
                {
                  kind: "describe",
                  value: [
                    {
                      kind: "runtime",
                      api: "DelegateInfoRuntimeApi",
                      member: "get_delegate",
                      args: [{ name: "delegate_account_vec", type: 1 }],
                    },
                  ],
                  contract: { next_offset: null },
                },
              ]
            : [
                {
                  kind: "runtime",
                  api: "DelegateInfoRuntimeApi",
                  member: "get_delegate",
                  value: "0x",
                  inner_result: null,
                  contract: { root_type: 1, inner_scale: { root_type: 0, types: [] } },
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page
    .getByRole("textbox", { name: "Finalized block hash (optional)", exact: true })
    .fill(oldHash);
  await page.getByRole("combobox", { name: "Contract", exact: true }).selectOption("api");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("DelegateInfoRuntimeApi");
  await page.getByRole("button", { name: "Inspect contract" }).click();
  await page.getByRole("checkbox", { name: "Decode nested legacy records" }).check();
  await page
    .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
    .fill(JSON.stringify([`0x${"12".repeat(32)}`]));
  await page.getByRole("button", { name: "Read operation", exact: true }).click();
  await expect(
    page.getByText("1. DelegateInfoRuntimeApi.get_delegate.inner_result", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Absent Copy Exact value", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "0x Copy Exact value", exact: true })).toBeVisible();
  expect(requests[0]).toMatchObject({ as_of: oldHash });
  expect(requests[1]).toEqual({
    as_of: oldHash,
    operations: [
      {
        kind: "runtime",
        api: "DelegateInfoRuntimeApi",
        member: "get_delegate",
        args: [`0x${"12".repeat(32)}`],
        decode_inner: true,
      },
    ],
  });
  await page
    .getByRole("textbox", { name: "Finalized block hash (optional)", exact: true })
    .fill(hash);
  await expect(page.getByRole("checkbox", { name: "Decode nested legacy records" })).toHaveCount(0);
  await page.getByRole("button", { name: "Inspect contract" }).click();
  await expect(
    page.getByRole("textbox", { name: "Arguments (JSON array)", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Decode nested legacy records" })).toHaveCount(0);
});

test("invalid historical block hashes issue no native request", async ({ page }) => {
  const requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: {} });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page
    .getByRole("textbox", { name: "Finalized block hash (optional)", exact: true })
    .fill("not-a-hash");
  await page.getByRole("button", { name: "Inspect contract" }).click();
  await expect(page.locator('[role="alert"]')).toContainText("finalized block hash");
  expect(requests).toEqual([]);
});
test("legacy runtime API discovery performs a pinned SCALE read and retains exact result bytes", async ({
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
          source: { ...source, metadata_version: 14, runtime_spec_version: 372 },
          types: [],
          results: discovery
            ? [
                {
                  kind: "describe",
                  value: [
                    {
                      kind: "runtime_scale",
                      api: "AccountNonceApi",
                      member: "account_nonce",
                      runtime_api_version: 1,
                    },
                  ],
                  contract: { next_offset: null },
                },
              ]
            : [
                {
                  kind: "runtime_scale",
                  api: "AccountNonceApi",
                  member: "account_nonce",
                  value: "0x04030201",
                  contract: { encoding: "scale", abi: "caller-encoded", runtime_api_version: 1 },
                },
              ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("combobox", { name: "Contract", exact: true }).selectOption("api");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("AccountNonceApi");
  await page.getByRole("button", { name: "Inspect contract" }).click();
  const args = page.getByRole("textbox", { name: "Arguments (SCALE hex)", exact: true });
  await expect(args).toHaveValue("0x");
  await expect(page.getByText(/advertises AccountNonceApi version 1/)).toBeVisible();
  await args.fill(`0x${"12".repeat(32)}`);
  await page.getByRole("button", { name: "Read operation", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "0x04030201 Copy Exact value", exact: true }),
  ).toBeVisible();
  expect(requests[1]).toEqual({
    as_of: hash,
    operations: [
      {
        kind: "runtime_scale",
        api: "AccountNonceApi",
        member: "account_nonce",
        input: `0x${"12".repeat(32)}`,
      },
    ],
  });
  await expect(page.getByRole("region", { name: "Review unsigned native call" })).toHaveCount(0);
});
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
  await expect(page.getByTitle("9007199254740993", { exact: true })).toBeVisible();
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
    await expect(page.getByRole("combobox", { name: "Feature", exact: true })).toBeDisabled();
    await expect(page.getByRole("textbox", { name: "Subnet", exact: true })).toBeDisabled();
  } finally {
    release();
  }
  await expect(page.getByRole("cell", { name: "2 Copy Exact value", exact: true })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Feature", exact: true })).toBeEnabled();
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
  await expect(page.getByTitle("9007199254740993", { exact: true })).toBeVisible();
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
  await page
    .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
    .fill("[9007199254740993]");
  await page.getByRole("button", { name: "Prepare unsigned call" }).click();
  await expect(page.getByRole("alert")).toContainText("decimal strings");
  expect(requests).toHaveLength(1);
  await page
    .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
    .fill('["9007199254740993"]');
  await page.getByRole("button", { name: "Prepare unsigned call" }).click();
  await expect(
    page.getByRole("cell", { name: "0x0754010203 Copy Exact value", exact: true }),
  ).toBeVisible();
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
  await expect(
    page.getByRole("cell", { name: "123456 Copy Exact value", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Read state", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The finalized read failed.");
  await expect(
    page.getByRole("cell", { name: "123456 Copy Exact value", exact: true }),
  ).toHaveCount(0);
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
  await page
    .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
    .fill('["500000"]');
  await page.getByRole("button", { name: "Read operation" }).click();
  await expect(
    page.getByRole("cell", { name: "0xdeadbeef Copy Exact value", exact: true }),
  ).toBeVisible();
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
  await page
    .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
    .fill(JSON.stringify([gas]));
  await page.getByRole("button", { name: "Read operation" }).click();
  await expect(
    page.getByRole("cell", { name: "0xbeef Copy Exact value", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("region", { name: "Native wallet review" })).toHaveCount(0);
  expect(requests).toEqual([
    { operations: [{ kind: "describe", api: "ContractsApi", offset: 0, limit: 32 }] },
    {
      as_of: hash,
      operations: [{ kind: "runtime", api: "ContractsApi", member: "call", args: [gas] }],
    },
  ]);
});

for (const api of ["ContractsApi", "EthereumRuntimeRPCApi"] as const) {
  const member = api === "ContractsApi" ? "upload_code" : "create";
  const readMember = api === "ContractsApi" ? "get_storage" : "account_code_at";
  const result =
    api === "ContractsApi"
      ? { code_hash: `0x${"11".repeat(32)}` }
      : { contract_address: `0x${"22".repeat(20)}` };
  const resultValue = Object.values(result)[0]!;
  test(`${api} code form sends a compact checksum-bound artifact at the inspected source`, async ({
    page,
  }) => {
    const artifact = {
      url: `https://raw.githubusercontent.com/example/contracts/${"a".repeat(40)}/code.wasm`,
      sha256: "b".repeat(64),
      bytes: 131072,
    };
    const requests: { operations: { kind: string; member?: string }[] }[] = [];
    await page.route("https://raw.githubusercontent.com/**", () => {
      throw new Error("Artifact fixtures must not fetch a public provider");
    });
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
            types: [
              { id: 0, path: [], definition: { kind: "primitive", primitive: 3 } },
              { id: 1, path: [], definition: { kind: "sequence", type: 0 } },
            ],
            results: discovery
              ? [
                  {
                    kind: "describe",
                    value: [
                      {
                        kind: "runtime",
                        api,
                        member,
                        args: [{ name: api === "ContractsApi" ? "code" : "data", type: 1 }],
                      },
                      { kind: "runtime", api, member: readMember, args: [] },
                    ],
                    contract: { next_offset: null },
                  },
                ]
              : [
                  {
                    kind: "runtime",
                    api,
                    member,
                    value: result,
                    contract: { code_artifact: artifact },
                  },
                ],
          },
        },
      });
    });
    await gotoThroughRestart(page, "/apis/native");
    await page.getByRole("combobox", { name: "Contract", exact: true }).selectOption("api");
    await page.getByRole("textbox", { name: "Name", exact: true }).fill(api);
    await page.getByRole("button", { name: "Inspect contract" }).click();
    await page.getByRole("textbox", { name: "Arguments (JSON array)", exact: true }).fill('["0x"]');
    await page.getByRole("textbox", { name: "Code artifact URL", exact: true }).fill(artifact.url);
    await page.getByRole("textbox", { name: "Artifact SHA-256", exact: true }).fill("bad");
    await page.getByRole("textbox", { name: "Artifact bytes", exact: true }).fill("131072");
    await page.getByRole("button", { name: "Read operation", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("64-character SHA-256");
    expect(requests).toHaveLength(1);
    await page
      .getByRole("textbox", { name: "Artifact SHA-256", exact: true })
      .fill(artifact.sha256);
    await page.getByRole("button", { name: "Read operation", exact: true }).click();
    await expect(page.getByTitle(resultValue, { exact: true })).toBeVisible();
    expect(requests[1]).toEqual({
      as_of: hash,
      operations: [
        {
          kind: "runtime",
          api,
          member,
          args: ["0x"],
          code_artifact: artifact,
        },
      ],
    });
    expect(JSON.stringify(requests[1]).length).toBeLessThan(700);
    await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("1");
    await expect(page.getByRole("textbox", { name: "Code artifact URL", exact: true })).toHaveCount(
      0,
    );
    await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("0");
    await expect(page.getByRole("textbox", { name: "Code artifact URL", exact: true })).toHaveValue(
      "",
    );
    await expect(page.getByRole("textbox", { name: "Artifact SHA-256", exact: true })).toHaveValue(
      "",
    );
    await expect(page.getByRole("textbox", { name: "Artifact bytes", exact: true })).toHaveValue(
      "",
    );
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1,
    );
    expect(overflow).toBe(false);
  });
}

test("precompile ABI discovery and simulation use the inspected source and typed Solidity inputs at phone width", async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  const to = `0x${(2053).toString(16).padStart(40, "0")}`;
  const signature = "getStake(bytes32,bytes32,uint256)";
  const requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const op = body.operations[0];
    const rows =
      op.kind === "describe"
        ? op.evm
          ? [
              {
                kind: "evm_function",
                signature,
                selector: "0xe3b598fa",
                outputs: [{ name: "", type: "uint256" }],
                args: [
                  { name: "hotkey", type: "bytes32" },
                  { name: "coldkey", type: "bytes32" },
                  { name: "netuid", type: "uint256" },
                ],
              },
            ]
          : [
              {
                kind: "runtime",
                api: "EthereumRuntimeRPCApi",
                member: "call",
                args: [
                  { name: "to", type: 0 },
                  { name: "data", type: 1 },
                ],
              },
              { kind: "runtime", api: "EthereumRuntimeRPCApi", member: "create", args: [] },
            ]
        : {
            variant: "Ok",
            fields: {
              exit_reason: { variant: "Succeed", fields: { variant: "Returned", fields: {} } },
              value: `0x${9007199254740993n.toString(16).padStart(64, "0")}`,
            },
          };
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [],
          results: [
            {
              kind: op.kind,
              value: rows,
              ...(op.kind === "runtime"
                ? { evm_result: { status: "decoded", values: ["9007199254740993"] } }
                : {}),
              contract: { total: 1, next_offset: null },
            },
          ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("button", { name: "Explore EVM execution", exact: true }).click();
  await expect(page.getByRole("group", { name: "Precompile function (optional)" })).toBeVisible();
  await page
    .getByRole("textbox", { name: "Arguments (JSON array)", exact: true })
    .fill(JSON.stringify([to, "0x"]));
  await page.getByRole("button", { name: "Inspect precompile", exact: true }).click();
  await expect(page.getByText("1 signatures at v470.", { exact: true })).toBeVisible();
  expect(requests[1]).toEqual({
    operations: [{ kind: "describe", evm: to, offset: 0, limit: 64 }],
    as_of: hash,
  });
  await page.getByRole("combobox", { name: "Solidity signature", exact: true }).fill(signature);
  await page
    .getByRole("textbox", { name: "Solidity arguments (JSON array)", exact: true })
    .fill("[9007199254740993]");
  await page.getByRole("button", { name: "Read operation", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("decimal strings");
  expect(requests).toHaveLength(2);
  const args = [`0x${"11".repeat(32)}`, `0x${"22".repeat(32)}`, "19"];
  await page
    .getByRole("textbox", { name: "Solidity arguments (JSON array)", exact: true })
    .fill(JSON.stringify(args));
  await page.getByRole("button", { name: "Read operation", exact: true }).click();
  await expect(page.getByTitle("9007199254740993", { exact: true })).toBeVisible();
  await expect(
    page.getByTitle(`0x${9007199254740993n.toString(16).padStart(64, "0")}`, { exact: true }),
  ).toBeVisible();
  expect(requests[2]).toEqual({
    operations: [
      {
        kind: "runtime",
        api: "EthereumRuntimeRPCApi",
        member: "call",
        args: [to, "0x"],
        evm_call: { signature, args },
      },
    ],
    as_of: hash,
  });
  await page.getByRole("combobox", { name: "Operation", exact: true }).selectOption("1");
  await expect(page.getByRole("group", { name: "Precompile function (optional)" })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test("collection continuation stays pinned to the submitted operation despite later form edits", async ({
  page,
}) => {
  const requests: unknown[] = [];
  await page.route("**/api/v1/native-runtime", async (route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const op = body.operations[0];
    await route.fulfill({
      json: {
        ok: true,
        data: {
          schema_version: 1,
          source,
          types: [],
          results:
            op.kind === "describe"
              ? [
                  {
                    kind: "describe",
                    contract: { next_offset: null },
                    value: [
                      {
                        kind: "runtime",
                        api: "NeuronInfoRuntimeApi",
                        member: "get_neurons",
                        args: [{ name: "netuid", type: 0 }],
                      },
                    ],
                  },
                ]
              : [
                  {
                    kind: "runtime",
                    api: op.api,
                    member: op.member,
                    contract: { root_type: 0 },
                    value: [{ uid: String(op.value_page.offset) }],
                    value_page: {
                      ...op.value_page,
                      total: 2,
                      next_offset: op.value_page.offset === 0 ? 1 : null,
                      collection_type: 0,
                      element_type: 1,
                      value_encoding: "items",
                    },
                  },
                ],
        },
      },
    });
  });
  await gotoThroughRestart(page, "/apis/native");
  await page.getByRole("combobox", { name: "Contract", exact: true }).selectOption("api");
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("NeuronInfoRuntimeApi");
  await page.getByRole("button", { name: "Inspect contract" }).click();
  const args = page.getByRole("textbox", { name: "Arguments (JSON array)", exact: true });
  await args.fill("[19]");
  await page.getByRole("checkbox", { name: "Read a collection page" }).check();
  await page.getByRole("textbox", { name: "Collection page size", exact: true }).fill("1");
  await page.getByRole("button", { name: "Read operation", exact: true }).click();
  await expect(page.getByRole("button", { name: "Next collection page" })).toBeVisible();
  await args.fill("[20]");
  await page
    .getByRole("textbox", { name: "Collection path (JSON array)", exact: true })
    .fill('["different"]');
  await page.getByRole("button", { name: "Next collection page" }).click();
  await expect(
    page.getByText("Collection offset 1 · 2 total items", { exact: true }),
  ).toBeVisible();
  expect(requests.at(-1)).toEqual({
    as_of: hash,
    operations: [
      {
        kind: "runtime",
        api: "NeuronInfoRuntimeApi",
        member: "get_neurons",
        args: [19],
        value_page: { path: [], offset: 1, limit: 1 },
      },
    ],
  });
  await expect(page.getByRole("button", { name: "Next collection page" })).toHaveCount(0);
});
