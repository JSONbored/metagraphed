import { createHash } from "node:crypto";
import { encodeExtrinsicPage, type ExtrinsicPageEntry } from "../../scripts/lib/extrinsic-page-encoding.ts";
import { feedOrder } from "../../src/history-feed-tree.ts";

/** Frozen source rows shared with the original-Parquet recovery fixture. */
export function extrinsicRecoveryFixture() {
  const rows = Array.from({ length: 3 }, (_, n) => ({
    block_number: 0, extrinsic_index: n, observed_at: 10000,
    signer: ["alice", "bob", null][n], call_module: ["Balances", "System", null][n],
    call_function: ["transfer_keep_alive", "remark", null][n], success: [true, false, null][n],
    extrinsic_hash: `0x${(n + 1).toString(16).padStart(64, "0")}`,
  }));
  const cases = [0, 1].map((fileId) => {
    const entries: ExtrinsicPageEntry[] = [];
    for (const [ordinal, row] of rows.entries()) {
      const selectors: unknown[][] = [["all", "*", null]];
      if (row.signer) selectors.push(["signer", row.signer, null]);
      if (row.call_module) {
        selectors.push(["module", row.call_module, null]);
        if (row.call_function) selectors.push(["module", row.call_module, row.call_function]);
      }
      if (row.call_function) selectors.push(["function", row.call_function, null]);
      if (row.success !== null) selectors.push(["success", String(row.success), null]);
      for (const selector of selectors) entries.push({
        token: createHash("sha256").update(JSON.stringify(selector)).digest("hex") +
          feedOrder(row.observed_at, row.block_number, row.extrinsic_index) + "b".repeat(64) + ordinal.toString(16).padStart(8, "0"),
        values: [row.block_number, row.extrinsic_index, row.observed_at, row.signer, row.call_module, row.call_function, row.success, fileId],
      });
    }
    entries.sort((a, b) => a.token.localeCompare(b.token));
    const groups = new Map<string, ExtrinsicPageEntry[]>();
    for (const entry of entries) groups.set(entry.token[0], [...(groups.get(entry.token[0]) ?? []), entry]);
    return { fileId, pages: [...groups.values()].map((page) => ({
      entries: page.map(({token, values}) => [token, values]),
      base64: Buffer.from(encodeExtrinsicPage(page)!).toString("base64"),
    })) };
  });
  return { version: 1, producer: "scripts/lib/extrinsic-page-encoding.ts", rows, cases };
}
