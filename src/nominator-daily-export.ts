import { z } from "zod";
import { createHash } from "node:crypto";
import { ALPHA_RUNTIMES } from "./alpha-runtime-identity.ts";
import { internalJson as reply } from "./internal-json.ts";
import { selectedD1Store, type D1StoreBinding } from "./d1-store.ts";
import { ALPHA_DAILY_TABLES } from "./read-store-tables.ts";
import {
  AlphaCompleteCaptureSchema,
  alphaPositionQuantity,
  alphaQuantityProvenance,
} from "./alpha-quantity.ts";

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const time = Date.parse(`${value}T00:00:00Z`);
    return (
      Number.isFinite(time) &&
      new Date(time).toISOString().slice(0, 10) === value
    );
  });
const key = z.string().min(1).max(128);
const schema = z.discriminatedUnion("operation", [
  z.strictObject({
    kind: z.literal("nominator-daily"),
    operation: z.literal("days"),
    from: date,
    to: date,
  }),
  z.strictObject({
    kind: z.literal("nominator-daily"),
    operation: z.literal("capture"),
    day: date,
    captured_at: z.number().int().positive().safe().optional(),
    cursor: z.tuple([key, key, z.number().int().min(1).max(65535)]).optional(),
  }),
  z.strictObject({
    kind: z.literal("nominator-daily"),
    operation: z.literal("metadata"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
type Row = Record<string, unknown>;
interface Env {
  D1_STATE?: D1StoreBinding;
  D1_STATE_TABLES?: string;
}

const MEMBER_FIELDS =
  "coldkey hotkey netuid snapshot_date share_fraction shares captured_at source alpha_rao alpha_evidence block_number block_hash genesis_hash spec_version code_hash metadata_sha256 updated_at".split(
    " ",
  );
const projection = "alpha-daily-members-v1";
/** Bounded logical reads behind the existing state-export credential. No
 * whole-source backup, receipt recovery or restore qualification is implied. */
export async function handleNominatorDailyExport(
  input: unknown,
  env: Env,
): Promise<Response> {
  const fail = (status: number, error: string) => reply({ error }, status);
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail(400, "invalid daily Alpha history request");
  if (!selectedD1Store(env, ALPHA_DAILY_TABLES))
    return fail(503, "daily Alpha history is not owned by D1");
  const value = parsed.data;
  try {
    const db = env.D1_STATE!;
    if (value.operation === "metadata") {
      const metadata = await db
        .prepare(
          "SELECT sha256,code_hash,spec_version,scale_hex FROM alpha_runtime_metadata WHERE sha256=?",
        )
        .bind(value.sha256)
        .first<Row>();
      if (!metadata) return fail(404, "runtime metadata is unobserved");
      const scale = z
        .string()
        .max(2 * 1024 * 1024 + 2)
        .regex(/^0x6d6574610e(?:[0-9a-f]{2})+$/)
        .parse(metadata.scale_hex);
      const spec = z
        .union([z.literal(454), z.literal(478)])
        .parse(metadata.spec_version);
      if (
        metadata.code_hash !== ALPHA_RUNTIMES[spec].code ||
        value.sha256 !== ALPHA_RUNTIMES[spec].metadata ||
        createHash("sha256")
          .update(Buffer.from(scale.slice(2), "hex"))
          .digest("hex") !== value.sha256
      )
        throw new Error("unqualified metadata original");
      return reply({ version: 1, projection, metadata });
    }
    if (value.operation === "days") {
      const start = Date.parse(`${value.from}T00:00:00Z`);
      const end = Date.parse(`${value.to}T00:00:00Z`);
      if (end < start || end - start > 30 * 86_400_000)
        return fail(400, "daily history ranges are limited to 31 UTC dates");
      const rows = (
        await db
          .prepare(
            `SELECT d.snapshot_date,p.*,EXISTS(SELECT 1 FROM alpha_runtime_metadata m WHERE m.sha256=p.metadata_sha256 AND m.code_hash=p.code_hash AND m.spec_version=p.spec_version) metadata_qualified FROM nominator_daily_captures d
        LEFT JOIN alpha_snapshot_passes p USING(captured_at)
        WHERE d.snapshot_date BETWEEN ? AND ? ORDER BY d.snapshot_date`,
          )
          .bind(value.from, value.to)
          .all<Row>()
      ).results;
      const heads = new Map(rows.map((row) => [row.snapshot_date, row]));
      const days = [];
      for (let at = start; at <= end; at += 86_400_000) {
        const day = new Date(at).toISOString().slice(0, 10);
        const row = heads.get(day);
        if (!row) {
          days.push({ day, status: "missing_unobserved" });
          continue;
        }
        if (row.metadata_qualified !== 1)
          throw new Error("missing capture metadata");
        const capture = AlphaCompleteCaptureSchema.parse(row);
        if (new Date(capture.captured_at).toISOString().slice(0, 10) !== day)
          throw new Error("capture day mismatch");
        days.push({
          day,
          status: "complete",
          rows: capture.expected_rows,
          provenance: alphaQuantityProvenance(capture),
        });
      }
      return reply({
        version: 1,
        projection,
        domain: "alpha_nonroot",
        day_basis: "observation_utc",
        days,
      });
    }
    if (value.cursor && value.captured_at === undefined)
      return fail(400, "continuation requires the selected capture identity");
    const cursor = value.cursor ?? ["", "", 0];
    // The head and page use the same native snapshot. A changed day selection
    // invalidates continuation; it cannot splice two full scans together.
    const results = await db.batch<Row>([
      db
        .prepare(
          `SELECT p.*,EXISTS(SELECT 1 FROM alpha_runtime_metadata m WHERE m.sha256=p.metadata_sha256 AND m.code_hash=p.code_hash AND m.spec_version=p.spec_version) metadata_qualified FROM nominator_daily_captures d LEFT JOIN alpha_snapshot_passes p USING(captured_at)
        WHERE d.snapshot_date=?`,
        )
        .bind(value.day),
      db
        .prepare(
          `SELECT ${MEMBER_FIELDS.join(",")} FROM nominator_positions_daily WHERE snapshot_date=?
        AND (coldkey,hotkey,netuid)>(?,?,?) ORDER BY coldkey,hotkey,netuid LIMIT 101`,
        )
        .bind(value.day, ...cursor),
    ]);
    const head = results[0].results[0];
    if (!head)
      return fail(
        404,
        "daily Alpha capture is missing or unobserved; pruning and unsupported coverage are not established",
      );
    if (head.metadata_qualified !== 1)
      throw new Error("missing capture metadata");
    const capture = AlphaCompleteCaptureSchema.parse(head);
    if (
      value.captured_at !== undefined &&
      value.captured_at !== capture.captured_at
    )
      return fail(412, "daily Alpha capture changed; restart this day");
    const page = results[1].results;
    const members = page.slice(0, 100).map((row) => {
      const quantity = alphaPositionQuantity(row, capture);
      if (quantity.quantity_status !== "qualified_snapshot")
        throw new Error("unqualified historical member");
      return row;
    });
    const last = members.at(-1);
    return reply({
      version: 1,
      projection,
      domain: "alpha_nonroot",
      day_basis: "observation_utc",
      day: value.day,
      captured_at: capture.captured_at,
      expected_rows: capture.expected_rows,
      provenance: alphaQuantityProvenance(capture),
      members,
      next_cursor:
        page.length > 100 && last
          ? [last.coldkey, last.hotkey, last.netuid]
          : null,
    });
  } catch {
    return fail(503, "daily Alpha history could not be qualified");
  }
}
