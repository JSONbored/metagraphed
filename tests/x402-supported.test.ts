import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resolveX402SupportedConfig } from "../src/x402-supported.ts";
import { resolveX402Config } from "../src/x402.ts";
import { resetModuleState } from "../src/module-state-registry.ts";
import { mockEnv } from "./row-type.ts";

const evm = "eip155:8453";
const svm = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const feePayer = "CjNFTjvBhbJJd2B5ePPMHRLx1ELZpa8dwQgGL727eKww";
const config = resolveX402Config(
  mockEnv({
    X402_PAY_TO: "0x224809C91CF942d00ef04b23f7BaB87d5DA5013f",
    X402_NETWORK: evm,
    X402_PAY_TO_SOLANA: "EQvVxQ9WShSUjSUj8rod2PFRcQfZ4Ymejx6hJLFMsx87",
    X402_NETWORK_SOLANA: svm,
    X402_FACILITATOR_URL: "https://facilitator.payai.network/",
  }),
)!;
const kind = (network = svm, extra: unknown = { feePayer }) => ({
  x402Version: 2,
  scheme: "exact",
  network,
  extra,
});
const respond = (body: unknown) =>
  vi.fn<typeof fetch>(async () => Response.json(body));
beforeEach(() => resetModuleState());
afterEach(() => vi.restoreAllMocks());

test("quotes only exact v2 supported networks and the selected provider's current fee payer", async () => {
  const fetcher = respond({
    kinds: [
      null,
      [],
      3,
      { ...kind(), x402Version: 1 },
      { ...kind(), scheme: "other" },
      kind("unrelated"),
      kind(evm),
      kind(svm, {
        feePayer,
        recentBlockhash: "volatile",
        lastValidBlockHeight: 42,
      }),
    ],
  });
  const current = await resolveX402SupportedConfig(config, fetcher);
  expect(current?.legs).toHaveLength(2);
  expect(current?.legs[0].extra).toEqual({ name: "USD Coin", version: "2" });
  expect(current?.legs[1].extra).toEqual({ feePayer });
  expect(fetcher).toHaveBeenCalledWith(
    "https://facilitator.payai.network/supported",
    expect.objectContaining({
      redirect: "manual",
      headers: { accept: "application/json" },
    }),
  );
});

test.each([
  null,
  [],
  {},
  { kinds: null },
  { kinds: {} },
  { kinds: [] },
  { kinds: [{ ...kind(), x402Version: 1 }] },
  { kinds: [kind(svm, { feePayer: "invalid" })] },
  { kinds: [kind(svm, { feePayer: 3 })] },
  { kinds: [kind(svm, { feePayer, apiKeyRequired: true })] },
  { kinds: [kind(svm, null)] },
  { kinds: [kind(svm, [])] },
])("unsupported or malformed capabilities fail closed: %j", async (body) => {
  expect(await resolveX402SupportedConfig(config, respond(body))).toBeNull();
});

test.each([
  () => new Response("down", { status: 503 }),
  () => new Response("not-json"),
  () => new Response(" ".repeat(65_537)),
  () => {
    throw new Error("offline");
  },
])(
  "bounded discovery failures do not invent a supported offer",
  async (response) => {
    expect(
      await resolveX402SupportedConfig(
        config,
        vi.fn<typeof fetch>(async () => response()),
      ),
    ).toBeNull();
  },
);

test("coalesces discovery, refreshes fee-payer rotation after 30 seconds, and briefly caches failures", async () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
  const fetcher = respond({ kinds: [kind()] });
  const [a, b] = await Promise.all([
    resolveX402SupportedConfig(config, fetcher),
    resolveX402SupportedConfig(config, fetcher),
  ]);
  expect(a).toEqual(b);
  expect(fetcher).toHaveBeenCalledTimes(1);
  now.mockReturnValue(31_001);
  fetcher.mockResolvedValueOnce(
    Response.json({
      kinds: [
        kind(svm, { feePayer: "2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4" }),
      ],
    }),
  );
  expect(
    (await resolveX402SupportedConfig(config, fetcher))?.legs[0].extra.feePayer,
  ).not.toBe(feePayer);
  now.mockReturnValue(62_000);
  fetcher.mockRejectedValueOnce(new Error("offline"));
  expect(await resolveX402SupportedConfig(config, fetcher)).toBeNull();
  now.mockReturnValue(66_999);
  expect(await resolveX402SupportedConfig(config, fetcher)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(3);
  now.mockReturnValue(67_001);
  expect(await resolveX402SupportedConfig(config, fetcher)).not.toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(4);
});

test("bounds the provider cache and isolates providers", async () => {
  const fetcher = respond({ kinds: [kind(evm)] });
  for (let i = 0; i < 9; i++)
    await resolveX402SupportedConfig(
      { ...config, facilitatorUrl: `https://facilitator${i}.example` },
      fetcher,
    );
  await resolveX402SupportedConfig(
    { ...config, facilitatorUrl: "https://facilitator0.example" },
    fetcher,
  );
  expect(fetcher).toHaveBeenCalledTimes(10);
});

test("capability redirects are refused without following a replacement provider", async () => {
  const fetcher = vi.fn<typeof fetch>(
    async () =>
      new Response(null, {
        status: 302,
        headers: { location: "https://replacement.example/supported" },
      }),
  );
  expect(await resolveX402SupportedConfig(config, fetcher)).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1]?.redirect).toBe("manual");
});
