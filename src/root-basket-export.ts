// Completed captures are immutable in D1. Every page checks its scoped receipt;
// a missing/incomplete capture cannot leak provisional rows into the archive.
import { z } from "zod";
import { RootBasketCaptureSchema } from "../schemas-src/root-basket-capture.ts";
import { selectedD1Store } from "./d1-store.ts";
import { ROOT_BASKET_D1_TABLES } from "./root-basket-capture-d1.ts";

const root = RootBasketCaptureSchema.shape;
const fund = root.funds.element.shape;
const captureId = root.capture_id;
const plans = {
  root_basket_captures: {
    columns:
      "capture_id network network_genesis_hash finalized_block_hash finalized_block runtime_spec_version runtime_api_version decoder_version metadata_sha256 started_at_ms finished_at_ms expected_pages expected_funds index_status index_completed_block bag_index_q64_bits stake_index_q64_bits content_sha256 accepted_at_ms",
    keys: ["capture_id"],
    cursor: z.tuple([captureId]),
  },
  root_basket_capture_pages: {
    columns: "page_index start_after next_after response_sha256 fund_count",
    keys: ["page_index"],
    cursor: z.tuple([root.pages.element.shape.page_index]),
  },
  root_basket_fund_snapshots: {
    columns:
      "hotkey page_index shares_atomic spot_nav_rao realizable_nav_rao deposited_rao redeemed_rao raw_spot_price_q64_bits display_price_q64_bits display_shares_q64_bits stake_price_q64_bits staker_twr_q64_bits pending_entitlement_q64_bits provisional first_block price_divisor_q64_bits rate0_q32_bits tr_splice_q64_bits holdings_count targets_count",
    keys: ["hotkey"],
    cursor: z.tuple([fund.hotkey]),
  },
  root_basket_holdings: {
    columns:
      "hotkey netuid quantity_atomic quantity_unit spot_value_rao realizable_value_rao",
    keys: ["hotkey", "netuid"],
    cursor: z.tuple([fund.hotkey, fund.holdings.element.shape.netuid]),
  },
  root_basket_targets: {
    columns: "hotkey netuid weight",
    keys: ["hotkey", "netuid"],
    cursor: z.tuple([fund.hotkey, fund.targets.element.shape.netuid]),
  },
} as const;
const RequestSchema = z
  .object({
    kind: z.literal("basket"),
    operation: z.enum(["ceiling", "discover", "rows"]),
    network: root.network,
    network_genesis_hash: root.network_genesis_hash,
    decoder_version: root.decoder_version,
    after: captureId.optional(),
    through: captureId.optional(),
    limit: z.number().int().min(1).max(64).optional(),
    table: z.enum(Object.keys(plans) as [keyof typeof plans]).optional(),
    capture_id: captureId.optional(),
    cursor: z
      .array(z.union([z.string().max(66), z.number().safe()]))
      .optional(),
  })
  .strict();
const SCOPE =
  "c.network=? AND c.network_genesis_hash=? AND c.decoder_version=?";
const COMPLETE =
  "root_basket_captures c JOIN root_basket_capture_completions r USING(capture_id)";
const PAGE_ROWS = 500;
interface ExportRow {
  [column: string]: string | null;
}

export async function handleRootBasketExport(
  input: unknown,
  env: unknown,
): Promise<Response> {
  const reply = (value: unknown, status = 200) =>
    Response.json(value, {
      status,
      headers: { "cache-control": "no-store" },
    });
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return reply({ error: "invalid basket export" }, 400);
  const value = parsed.data;
  const scope = [
    value.network,
    value.network_genesis_hash,
    value.decoder_version,
  ];
  try {
    const db = selectedD1Store(env, ROOT_BASKET_D1_TABLES);
    if (!db)
      return reply({ error: "basket export requires D1 ownership" }, 503);
    if (value.operation === "ceiling") {
      const last = await db.first<{ capture_id: string }>(
        `SELECT c.capture_id FROM ${COMPLETE} WHERE ${SCOPE} ORDER BY c.capture_id DESC LIMIT 1`,
        scope,
      );
      return reply({ version: 1, ceiling: last?.capture_id ?? null });
    }
    if (value.operation === "discover") {
      if (!value.through)
        return reply({ error: "basket discovery requires a ceiling" }, 400);
      const ids = await db.query<{ capture_id: string }>(
        `SELECT c.capture_id FROM ${COMPLETE} WHERE ${SCOPE}
        AND c.capture_id > ? AND c.capture_id <= ? ORDER BY c.capture_id LIMIT ?`,
        [...scope, value.after ?? "", value.through, value.limit ?? 64],
      );
      return reply({ version: 1, captures: ids.map((row) => row.capture_id) });
    }
    if (!value.table || !value.capture_id)
      return reply({ error: "basket rows require a table and capture" }, 400);
    const plan = plans[value.table];
    if (value.cursor && !plan.cursor.safeParse(value.cursor).success)
      return reply({ error: "invalid basket export cursor" }, 400);
    const columns = plan.columns.split(" ");
    const fields = columns.map((name) => {
      if (name === "provisional")
        return "CASE t.provisional WHEN 1 THEN 'true' WHEN 0 THEN 'false' END AS provisional";
      const alias = ["content_sha256", "accepted_at_ms"].includes(name)
        ? "r"
        : "t";
      return `CAST(${alias}.${name} AS TEXT) AS ${name}`;
    });
    const keys = plan.keys.map((key) => `t.${key}`).join(",");
    const rows = await db.query<ExportRow>(
      `SELECT ${fields.join(",")},json_array(${keys}) AS _cursor
      FROM ${value.table} t JOIN root_basket_captures c ON c.capture_id=t.capture_id
      JOIN root_basket_capture_completions r ON r.capture_id=c.capture_id
      WHERE ${SCOPE} AND c.capture_id=?
      ${value.cursor ? `AND (${keys}) > (${plan.keys.map(() => "?").join(",")})` : ""}
      ORDER BY ${keys} LIMIT ${PAGE_ROWS + 1}`,
      [...scope, value.capture_id, ...(value.cursor ?? [])],
    );
    const selected = rows.slice(0, PAGE_ROWS);
    const next =
      rows.length > PAGE_ROWS ? JSON.parse(selected.at(-1)!._cursor!) : null;
    const result = {
      version: 1,
      rows: selected.map(({ _cursor, ...row }) => {
        void _cursor;
        return row;
      }),
      next_cursor: next,
    };
    if (
      new TextEncoder().encode(JSON.stringify(result)).length >
      2 * 1024 * 1024
    )
      throw new Error("basket export page exceeds budget");
    return reply(result);
  } catch {
    return reply({ error: "basket export unavailable" }, 503);
  }
}
