import {
  BASKET_RUNTIME_API_ID,
  type BasketRpc,
} from "../../src/root-basket-runtime.ts";
import { bytesToHex, storageMapPrefix } from "../../src/twox-storage-key.ts";
// Synthetic SCALE values in the field order of the v469 frozen Rust structs.
// This is offline regression evidence, not an observed chain snapshot.
export const BASKET_FIXTURE_HOTKEY = `0x${"11".repeat(32)}`;
export const BASKET_FIXTURE_COLDKEY = `0x${"22".repeat(32)}`;
export const BASKET_FIXTURE_BLOCK = `0x${"33".repeat(32)}`;
export const BASKET_FIXTURE_GENESIS = `0x${"44".repeat(32)}`;
export const BASKET_FIXTURE_Q64 = "18446744073709551616";
export const BASKET_FIXTURE_WIDE = "9007199254740993";

function le(value: string, bytes: number) {
  const hex = BigInt(value)
    .toString(16)
    .padStart(bytes * 2, "0");
  return hex.match(/../g)!.reverse().join("");
}
const u64 = (value: string) => le(value, 8);
const q64 = (value: string) => le(value, 16);
const hotkey = BASKET_FIXTURE_HOTKEY.slice(2);

export const BASKET_FIXTURE_PRICING =
  hotkey +
  ["2", "3", "4", "5", "6", "7", "8"]
    .map((n) => q64((BigInt(n) * BigInt(BASKET_FIXTURE_Q64)).toString()))
    .join("") +
  u64("100") +
  "00" +
  u64(BASKET_FIXTURE_WIDE) +
  u64("17") +
  q64("18446744073709551617");
export const BASKET_FIXTURE_POSITION =
  hotkey + u64("11") + q64("12") + q64("13") + u64("14") + u64("15") + "00";
export const BASKET_FIXTURE_CLAIM =
  hotkey +
  ["11", "12", "9", "3"].map(u64).join("") +
  ["5", "3", "2", "1", "7"].map((n) => le(n, 4)).join("");
export const BASKET_FIXTURE_TRADING =
  "0100" + ["360", "4", "5"].map(u64).join("");
export const BASKET_FIXTURE_INDEX = q64("7") + q64("8");
const holding =
  "0000" +
  ["1", "1", "1"].map(u64).join("") +
  "1300" +
  ["3", "6", "4"].map(u64).join("");
export const BASKET_FIXTURE_SUMMARY =
  hotkey + ["5", "7", "17", "19", "23"].map(u64).join("") + "08" + holding;

export function pricingPage(
  rows: string[] = [BASKET_FIXTURE_PRICING],
  next: string | null = null,
) {
  const length = rows.length;
  const prefix =
    length < 64 ? le(String(length * 4), 1) : le(String(length * 4 + 1), 2);
  return `0x${prefix}${rows.join("")}${next === null ? "00" : `01${next.slice(2)}`}`;
}

export function basketRuntimeFixture(overrides: Record<string, unknown> = {}) {
  const calls: { method: string; params: unknown[] }[] = [];
  const answers: Record<string, unknown> = {
    chain_getFinalizedHead: BASKET_FIXTURE_BLOCK,
    chain_getHeader: { number: "0x1f4" },
    chain_getBlockHash: BASKET_FIXTURE_GENESIS,
    state_getRuntimeVersion: {
      specName: "node-subtensor",
      specVersion: 469,
      apis: [[BASKET_RUNTIME_API_ID, 5]],
    },
    state_getMetadata: "0x010203",
    state_getStorage: (params: unknown[]) =>
      String(params[0]).startsWith(
        bytesToHex(storageMapPrefix("SubtensorModule", "StakingHotkeys")),
      )
        ? `0x04${BASKET_FIXTURE_HOTKEY.slice(2)}`
        : null,
    get_all_beta_pricing: pricingPage(),
    get_beta_pricing: `0x01${BASKET_FIXTURE_PRICING}`,
    get_validator_basket_summary: `0x${BASKET_FIXTURE_SUMMARY}`,
    get_beta_position: `0x01${BASKET_FIXTURE_POSITION}`,
    get_beta_portfolio: `0x04${BASKET_FIXTURE_POSITION}`,
    get_basket_claim_preview: `0x01${BASKET_FIXTURE_CLAIM}`,
    get_root_basket_claim_previews: `0x04${BASKET_FIXTURE_CLAIM}`,
    get_basket_trading_status: `0x${BASKET_FIXTURE_TRADING}`,
    get_beta_index: `0x${BASKET_FIXTURE_INDEX}`,
    ...overrides,
  };
  const rpc: BasketRpc = async (method, params) => {
    calls.push({ method, params });
    const key =
      method === "state_call"
        ? String(params[0]).replace("BetaBasketRuntimeApi_", "")
        : method;
    const value = answers[key];
    return typeof value === "function" ? value(params) : value;
  };
  return { rpc, calls };
}

/** Scope sequential contract-validator RPC reads to the independent fixture. */
export async function withBasketRuntimeFixture<T>(action: () => Promise<T>) {
  const previousFetch = globalThis.fetch;
  const fixture = basketRuntimeFixture();
  globalThis.fetch = async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    const answer = async (row: {
      id: number;
      method: string;
      params: unknown[];
    }) => ({ id: row.id, result: await fixture.rpc(row.method, row.params) });
    return Response.json(
      Array.isArray(body)
        ? await Promise.all(body.map(answer))
        : await answer(body),
    );
  };
  try {
    return await action();
  } finally {
    globalThis.fetch = previousFetch;
  }
}
