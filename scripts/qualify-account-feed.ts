import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { HistoryAccountFeedSchema } from "../schemas-src/artifacts/history-account-feed.ts";
import { AccountEventsRowSchema } from "../schemas-src/lakehouse.ts";
import {
  iterateAccountFeed,
  mergeAccountFeedPage,
  validateAccountFeed,
} from "../src/history-account-feed.ts";
import { parquetReadBudget } from "../src/indexed-parquet.ts";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const selector = z.strictObject({
  side: z.enum(["hotkey", "coldkey", "all"]),
  account: z.string(),
  counterparty: z.string().optional(),
  kind: z.string().nullable().optional(),
  netuid: count.nullable().optional(),
  blockStart: count.optional(),
  blockEnd: count.optional(),
  cursor: z.tuple([count, count, count]).nullable().optional(),
});
const InputSchema = z.strictObject({
  manifest: HistoryAccountFeedSchema,
  selection: HistoryAccountFeedSchema.shape.selection,
  objects: z.record(
    z.string(),
    z.strictObject({ etag: z.string(), base64: z.string() }),
  ),
  queries: z
    .array(
      z.strictObject({
        selectors: z.array(selector).min(1).max(8),
        limit: count.positive().max(5001),
        offset: count.max(5000).default(0),
        expected: z.array(AccountEventsRowSchema.required()).max(5001),
      }),
    )
    .min(1)
    .max(128),
});

/** Run the deployed reader against pinned native output and independent rows. */
export async function qualifyAccountFeed(input: unknown) {
  const value = InputSchema.parse(input);
  const feed = validateAccountFeed(value.manifest, value.selection);
  const objects = new Map(
    Object.entries(value.objects).map(([key, object]) => {
      const raw = Buffer.from(object.base64, "base64");
      if (
        raw.length > 16 * 1024 * 1024 ||
        createHash("md5").update(raw).digest("hex") !== object.etag
      )
        throw new Error("Account feed qualification object identity mismatch");
      return [key, { etag: object.etag, raw }] as const;
    }),
  );
  const source = {
    async read(key: string, etag: string, offset: number, length: number) {
      const object = objects.get(key);
      if (
        !object ||
        object.etag !== etag ||
        offset < 0 ||
        offset + length > object.raw.length
      )
        throw new Error("Account feed qualification range identity mismatch");
      return Uint8Array.from(object.raw.subarray(offset, offset + length))
        .buffer;
    },
  };
  const proofs = [];
  for (const query of value.queries) {
    const budget = parquetReadBudget(24 * 1024 * 1024, 128);
    const rows = await mergeAccountFeedPage(
      query.selectors.map((selector) =>
        iterateAccountFeed(source, feed, selector, budget),
      ),
      query.limit,
      query.offset,
    );
    if (JSON.stringify(rows) !== JSON.stringify(query.expected))
      throw new Error("Account feed native row parity failed");
    proofs.push({
      rows: rows.length,
      bytes: budget.bytes,
      requests: budget.requests,
    });
  }
  return {
    generation: feed.generation,
    rows: feed.rows,
    entries: feed.entries,
    queries: proofs,
  };
}

export async function main(args = process.argv.slice(2)) {
  if (args.length !== 1)
    throw new Error("Usage: qualify-account-feed <fixture.json>");
  if ((await stat(args[0])).size > 64 * 1024 * 1024)
    throw new Error("Account feed qualification input exceeds budget");
  const value = JSON.parse(await readFile(args[0], "utf8"));
  console.log(JSON.stringify(await qualifyAccountFeed(value)));
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : "Account feed qualification failed",
    );
    process.exitCode = 1;
  });
}
