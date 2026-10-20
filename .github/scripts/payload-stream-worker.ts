import { storeChainDetailPayloads as baseline } from "../../src/chain-detail-payloads.baseline.ts";
import { storeChainDetailPayloads as candidate, restoreChainDetailPayloads } from "../../src/chain-detail-payloads.ts";
import { historySha256 } from "../../src/history-sha256.ts";
import type { ProducerStatement } from "../../src/producer-store.ts";

function require(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
}
function entropy(length: number) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 0x12345678;
  const chunks: string[] = [];
  for (let offset = 0; offset < length; offset += 8192) {
    let chunk = "";
    for (let i = offset; i < Math.min(offset + 8192, length); i++) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      chunk += alphabet[(state >>> 16) & 63];
    }
    chunks.push(chunk);
  }
  return chunks.join("");
}
const names = ["maximum-ascii", "maximum-chunks", "unicode-bom", "escaped-json", "parallel-families"];
function rowsFor(name: string) {
  if (name === "maximum-ascii") return [{ call_args: "x".repeat(16 * 1024 * 1024) }];
  if (name === "maximum-chunks") return [{ call_args: entropy(16 * 1024 * 1024) }];
  if (name === "unicode-bom") return [{ args: "\uFEFF" + "界😀".repeat(200_000) }];
  if (name === "escaped-json") return [{ call_args: "\uFEFF" + JSON.stringify({ text: "\u0000\\\"界😀\r\n".repeat(30_000) }) }];
  return [{ call_args: "z".repeat(700_000) }, { args: "\uFEFF" + "界😀".repeat(140_000) }, { call_args: entropy(900_000) }, { args: "[]" }];
}
function environment(plan: ProducerStatement[]) {
  return { D1_STATE: { prepare() { return { bind(hash: string) { return { async all() {
    return { results: plan.filter(s => s.text.startsWith("INSERT INTO chain_detail_payload_chunks (sha256,part,data) VALUES") && s.values?.[0] === hash)
      .map(s => ({part: s.values![1], data: s.values![2]})).sort((a,b) => Number(a.part)-Number(b.part)) };
  } }; } }; } } };
}
export default {
  async fetch(request: Request) {
    const name = new URL(request.url).pathname.slice(1);
    require(names.includes(name), "fixture-name");
    const rows = rowsFor(name);
    const original = JSON.stringify(rows);
    const first: ProducerStatement[] = [], second: ProducerStatement[] = [];
    const [oldRows, newRows] = await Promise.all([baseline(undefined, rows, first), candidate(undefined, rows, second)]);
    require(JSON.stringify(rows) === original, "source-mutated");
    require(JSON.stringify(oldRows) === JSON.stringify(newRows), "reference-identity");
    require(JSON.stringify(first) === JSON.stringify(second), "gzip-and-plan-identity");
    if (name === "maximum-chunks") require(first.length > 1, "chunk-fixture-reachable");
    const restored = await restoreChainDetailPayloads(environment(second), newRows);
    require(JSON.stringify(restored) === original, "exact-restore");
    return Response.json({ name, exactReferenceEquality: true, exactCompressedPlanEquality: true,
      exactRestore: true, sourceUnchanged: true, rows: rows.length, chunkStatements: second.length,
      inputSha256: historySha256(original), referencesSha256: historySha256(JSON.stringify(newRows)),
      planSha256: historySha256(JSON.stringify(second)) });
  },
};
