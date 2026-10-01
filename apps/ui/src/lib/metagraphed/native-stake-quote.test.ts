import { afterEach, expect, test, vi } from "vitest";
import {
  alphaForTaoTarget, decodeNativeStakeQuote, fetchNativeStakeQuote,
  nativeStakeInput, nativeStakeOperation, nativeStakeParams, nativeStakeQuoteQuery,
  prepareNativeStakeCall,
} from "./native-stake-quote";
import type { NativeArtifact } from "./native-runtime";

const hotkey = `0x${"11".repeat(32)}`;
const source: NativeArtifact["source"] = {
  network: "finney", network_genesis_hash: `0x${"44".repeat(32)}`,
  finalized_block_hash: `0x${"33".repeat(32)}`, finalized_block: "500",
  runtime_spec_version: 470, runtime_transaction_version: 1,
  runtime_code_hash: `0x${"55".repeat(32)}`, metadata_sha256: `0x${"66".repeat(32)}`,
  metadata_version: 15,
};
const result = (member: string, value: NativeArtifact["results"][number]["value"]): NativeArtifact["results"][number] => ({ kind: "runtime", api: "SwapRuntimeApi", member, contract: null, value });
const amounts = {
  tao_amount: "9007199254740983", alpha_amount: "4503599627370496", tao_fee: "10",
  alpha_fee: "0", tao_slippage: "0", alpha_slippage: "1",
};
const artifact = (): NativeArtifact => ({ schema_version: 1, source: { ...source }, types: [], results: [result("current_alpha_price", "2000000000"), result("sim_swap_tao_for_alpha", { ...amounts })] });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("exact amounts, input fees and price limits survive beyond JavaScript safe integers", () => {
  expect(nativeStakeInput("9007199.254740993")).toBe(9007199254740993n);
  expect(nativeStakeInput("18446744073.709551615")).toBe((1n << 64n) - 1n);
  for (const bad of ["", "0", "-1", "1e3", "0.0000000001", "18446744073.709551616", "nope"])
    expect(nativeStakeInput(bad)).toBeNull();
  const quote = decodeNativeStakeQuote(artifact(), 19, 9007199254740993n, "stake", 2000000000n);
  expect(quote.inputAtomic).toBe(9007199254740993n);
  expect(quote.outputAtomic).toBe(4503599627370496n);
  expect(quote.taoFeeAtomic).toBe(10n);
  expect(quote.alphaSlippageAtomic).toBe(1n);
  expect(nativeStakeParams(quote, hotkey, 5.01)).toMatchObject({ amountStaked: 9007199254740993n, limitPrice: 2100200000n, allowPartial: false });
  const operation = nativeStakeOperation(nativeStakeParams(quote, hotkey, 5));
  expect(operation).toEqual({ kind: "prepare", pallet: "SubtensorModule", member: "add_stake_limit", args: [hotkey, 19, "9007199254740993", "2100000000", false] });
});

test("remove quotes include alpha fees and round the minimum price up", () => {
  const fixture = artifact();
  fixture.results[1] = result("sim_swap_alpha_for_tao", { tao_amount: "17", alpha_amount: "10", tao_fee: "0", alpha_fee: "1", tao_slippage: "2", alpha_slippage: "0" });
  const quote = decodeNativeStakeQuote(fixture, 0, 11n, "unstake", 2000000001n);
  expect(quote.is_root).toBe(true);
  expect(quote.outputAtomic).toBe(17n);
  expect(quote.alphaFeeAtomic).toBe(1n);
  expect(quote.taoSlippageAtomic).toBe(2n);
  const params = nativeStakeParams(quote, hotkey, 5);
  expect(params).toMatchObject({ call: "remove_stake_limit", amountUnstaked: 11n, limitPrice: 1900000001n });
  expect(nativeStakeOperation(params)).toMatchObject({ args: [hotkey, 0, "11", "1900000001", false] });
  for (const tolerance of [-1, NaN, 5.001, 100, Infinity])
    expect(() => nativeStakeParams(quote, hotkey, tolerance)).toThrow(/tolerance/);
  expect(() => nativeStakeParams({ ...quote, priceAtomic: 0n }, hotkey, 0)).toThrow(/price limit/);
  expect(() => nativeStakeParams({ ...quote, direction: "stake", priceAtomic: (1n << 64n) - 1n }, hotkey, 5)).toThrow(/price limit/);
});

test("bad quantities, mismatched methods, zero failures and partial simulations cannot authorize a quote", () => {
  for (const raw of [null, [], {}, { ...amounts, tao_amount: "0" }, { ...amounts, alpha_amount: "0" }, { ...amounts, tao_fee: 10 }, { ...amounts, alpha_fee: "18446744073709551616" }]) {
    const fixture = artifact(); fixture.results[1] = result("sim_swap_tao_for_alpha", raw);
    expect(() => decodeNativeStakeQuote(fixture, 19, 9007199254740993n, "stake", 2n)).toThrow();
  }
  const fixture = artifact(); fixture.results[1]!.member = "different";
  expect(() => decodeNativeStakeQuote(fixture, 19, 9007199254740993n, "stake", 2n)).toThrow(/does not match/);
  expect(() => decodeNativeStakeQuote(artifact(), 19, 9007199254740993n, "stake", 0n)).toThrow(/could not fill/);
});

test("TAO target conversion is ceil-rounded and range checked entirely in integers", () => {
  expect(alphaForTaoTarget(10n, 3000000000n)).toBe(4n);
  expect(alphaForTaoTarget(9007199254740993n, 2000000000n)).toBe(4503599627370497n);
  for (const [target, price] of [[0n, 1n], [1n, 0n], [-1n, 1n], [1n << 64n, 1n], [1n, 1n << 64n], [(1n << 64n) - 1n, 1n]])
    expect(() => alphaForTaoTarget(target!, price!)).toThrow();
});

function responses(rows: NativeArtifact[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({ ok: true, data: rows.shift(), meta: {} }), { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
test("stake uses one native request and preserves exact decimal-string input", async () => {
  const fetch = responses([artifact()]);
  const controller = new AbortController();
  const quote = await fetchNativeStakeQuote(19, 9007199254740993n, "stake", "tao", controller.signal);
  expect(quote.outputAtomic).toBe(4503599627370496n);
  expect(fetch).toHaveBeenCalledTimes(1);
  const init = fetch.mock.calls[0]![1] as RequestInit;
  expect(init.signal).toBe(controller.signal);
  expect(JSON.parse(String(init.body))).toEqual({ operations: [
    { kind: "runtime", api: "SwapRuntimeApi", member: "current_alpha_price", args: [19] },
    { kind: "runtime", api: "SwapRuntimeApi", member: "sim_swap_tao_for_alpha", args: [19, "9007199254740993"] },
  ] });
  for (const [netuid, amount] of [[-1, 1n], [65536, 1n], [1.5, 1n], [19, 0n], [19, 1n << 64n]] as const)
    await expect(fetchNativeStakeQuote(netuid, amount, "stake", "tao")).rejects.toThrow(/valid subnet/);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(nativeStakeQuoteQuery(19, null, "stake", "tao").enabled).toBe(false);
  expect(nativeStakeQuoteQuery(19, 9007199254740993n, "stake", "tao").queryKey).toContain("9007199254740993");
});

test("TAO-target unstake simulates at the price's same finalized source and rejects drift", async () => {
  const first = artifact(); first.results = [result("current_alpha_price", "3000000000")];
  const next = artifact(); next.results = [result("sim_swap_alpha_for_tao", { tao_amount: "9", alpha_amount: "3", tao_fee: "0", alpha_fee: "1", tao_slippage: "3", alpha_slippage: "0" })];
  const fetch = responses([first, next]);
  const quote = await fetchNativeStakeQuote(19, 10n, "unstake", "tao");
  expect(quote.inputAtomic).toBe(4n);
  expect(quote.outputAtomic).toBe(9n);
  expect(JSON.parse(String((fetch.mock.calls[1]![1] as RequestInit).body))).toEqual({ as_of: source.finalized_block_hash, operations: [{ kind: "runtime", api: "SwapRuntimeApi", member: "sim_swap_alpha_for_tao", args: [19, "4"] }] });
  responses([first, { ...next, source: { ...source, runtime_spec_version: 471 } }]);
  await expect(fetchNativeStakeQuote(19, 10n, "unstake", "tao")).rejects.toThrow(/changed its finalized/);
});

test("prepared staking method bytes keep the quote's immutable source", async () => {
  const quote = decodeNativeStakeQuote(artifact(), 19, 9007199254740993n, "stake", 2000000000n);
  const prepared = artifact(); prepared.results = [{ kind: "prepare", pallet: "SubtensorModule", member: "add_stake_limit", call_data: "0x0700", contract: null }];
  const fetch = responses([prepared]);
  expect(await prepareNativeStakeCall(quote, nativeStakeParams(quote, hotkey, 5))).toEqual(prepared);
  expect(JSON.parse(String((fetch.mock.calls[0]![1] as RequestInit).body)).as_of).toBe(source.finalized_block_hash);
  responses([{ ...prepared, source: { ...source, runtime_code_hash: null } }]);
  await expect(prepareNativeStakeCall(quote, nativeStakeParams(quote, hotkey, 5))).rejects.toThrow(/changed its finalized/);
});
