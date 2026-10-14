import { captureUpsertStatements } from "./capture-family-d1.ts";
import { NOMINATOR_SCAN_RECEIPTS_RETENTION_MS } from "./nominator-scan-receipts.ts";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AlphaPoolEvidenceSchema,
  quoteAlphaPool,
} from "./alpha-share-value.ts";
import type { ProducerStatement } from "./producer-store.ts";
import { createD1Store, type D1StoreBinding } from "./d1-store.ts";

import {
  ALPHA_GENESIS as GENESIS,
  ALPHA_RUNTIMES as RUNTIMES,
} from "./alpha-runtime-identity.ts";
const sha = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const count = (max: number) => z.number().int().min(0).max(max);
const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const packet = z.strictObject({
  alpha_snapshot: z.strictObject({
    captured_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    block_number: count(0xffffffff),
    block_hash: hash,
    genesis_hash: z.literal(GENESIS),
    spec_version: z.union([z.literal(454), z.literal(478)]),
    code_hash: hash,
    metadata_sha256: z.string().regex(/^[0-9a-f]{64}$/),
    metadata_scale_hex: z
      .string()
      .max(2 * 1024 * 1024 + 2)
      .regex(/^0x6d6574610e(?:[0-9a-f]{2})+$/)
      .optional(),
    scanned_legacy: count(1_000_000),
    scanned_v2: count(1_000_000),
    total_rows: count(1_000_000),
    total_chunks: z.number().int().min(1).max(1000),
    index: count(999),
  }),
  rows: z
    .array(
      z.strictObject({
        coldkey: z
          .string()
          .min(1)
          .max(128)
          .refine((v) => new TextEncoder().encode(v).byteLength <= 128),
        hotkey: z
          .string()
          .min(1)
          .max(128)
          .refine((v) => new TextEncoder().encode(v).byteLength <= 128),
        netuid: z.number().int().min(1).max(65535),
        evidence: AlphaPoolEvidenceSchema,
      }),
    )
    .max(2500),
});

/** Internal authenticated capture protocol. Original metadata/code identity
 * qualifies semantics; specVersion alone never selects an arithmetic adapter. */
function qualified(value: unknown, now: number) {
  const parsed = packet.parse(value),
    s = parsed.alpha_snapshot;
  const runtime = RUNTIMES[s.spec_version];
  if (
    s.code_hash !== runtime.code ||
    s.metadata_sha256 !== runtime.metadata ||
    (s.metadata_scale_hex !== undefined &&
      sha(Buffer.from(s.metadata_scale_hex.slice(2), "hex")) !==
        s.metadata_sha256)
  )
    throw new TypeError(
      "Alpha runtime code or original metadata is unqualified",
    );
  if (
    !Number.isSafeInteger(now) ||
    now < s.captured_at ||
    s.index >= s.total_chunks ||
    parsed.rows.length > s.total_rows ||
    s.total_rows > s.scanned_legacy + s.scanned_v2 ||
    s.total_rows > s.total_chunks * 2500 ||
    (s.total_rows === 0
      ? s.total_chunks !== 1 || parsed.rows.length !== 0
      : parsed.rows.length === 0 || s.total_chunks > s.total_rows) ||
    (s.total_chunks === 1 && s.total_rows !== parsed.rows.length)
  )
    throw new TypeError("Alpha snapshot census or clock is invalid");
  const seen = new Set<string>();
  const rows = parsed.rows
    .map((row) => {
      const key = JSON.stringify([row.coldkey, row.hotkey, row.netuid]);
      if (seen.has(key))
        throw new TypeError("Alpha snapshot repeats a position");
      seen.add(key);
      const quote = quoteAlphaPool(row.evidence, s.spec_version);
      return {
        coldkey: row.coldkey,
        hotkey: row.hotkey,
        netuid: row.netuid,
        share_fraction: quote.shareFraction,
        shares: quote.evidence.share.legacy_bits,
        alpha_rao: quote.alphaRao,
        alpha_evidence: JSON.stringify(quote.evidence),
        captured_at: s.captured_at,
      };
    })
    .sort((a, b) =>
      JSON.stringify([a.coldkey, a.hotkey, a.netuid]) <
      JSON.stringify([b.coldkey, b.hotkey, b.netuid])
        ? -1
        : 1,
    );
  return { snapshot: s, rows };
}

/** Stage exact chunks, then publish the full Alpha source domain atomically.
 * Retries cannot recount chunks, partial passes never touch serving rows, and
 * lower finalized blocks cannot replace a selected higher snapshot. */
export async function writeAlphaSnapshotD1(
  db: D1StoreBinding,
  value: unknown,
  now: number,
) {
  const store = createD1Store(db);
  const { snapshot: s, rows } = qualified(value, now),
    at = s.captured_at;
  const owners = [...new Set(rows.map((r) => r.coldkey))].sort();
  const passColumns = [
    "captured_at",
    "block_number",
    "block_hash",
    "genesis_hash",
    "spec_version",
    "code_hash",
    "metadata_sha256",
    "scanned_legacy",
    "scanned_v2",
    "expected_rows",
    "expected_chunks",
  ];
  const passValues = [
    at,
    s.block_number,
    s.block_hash,
    s.genesis_hash,
    s.spec_version,
    s.code_hash,
    s.metadata_sha256,
    s.scanned_legacy,
    s.scanned_v2,
    s.total_rows,
    s.total_chunks,
  ];
  const digest = sha(
    JSON.stringify([
      [...passValues, s.index],
      rows.map((row) => {
        const e = JSON.parse(row.alpha_evidence);
        return [
          row.coldkey,
          row.hotkey,
          row.netuid,
          e.share.legacy_bits,
          e.share.v2?.mantissa ?? null,
          e.share.v2?.exponent ?? null,
          e.denominator.legacy_bits,
          e.denominator.v2?.mantissa ?? null,
          e.denominator.v2?.exponent ?? null,
          e.total_alpha_rao,
          e.pool_epoch,
          e.member_epoch,
        ];
      }),
    ]),
  );
  const identity = passColumns
    .slice(1)
    .map((c) => `alpha_snapshot_passes.${c}=excluded.${c}`)
    .join(" AND ");
  const pending = `EXISTS(SELECT 1 FROM alpha_snapshot_chunks c JOIN alpha_snapshot_passes p USING(captured_at) WHERE c.captured_at=${at} AND c.batch_index=${s.index} AND c.sha256='${digest}' AND c.applied=0 AND p.completed_at IS NULL)`;
  const complete = `EXISTS(SELECT 1 FROM alpha_snapshot_passes p WHERE p.captured_at=${at} AND p.completed_at IS NULL AND p.received_rows=p.expected_rows AND p.received_chunks=p.expected_chunks)`;
  const promote = `${complete} AND NOT EXISTS(SELECT 1 FROM alpha_snapshot_passes p WHERE p.selected=1 AND p.block_number>=${s.block_number})`;
  const statements: ProducerStatement[] = [
    ...(s.metadata_scale_hex !== undefined
      ? [
          {
            text: "INSERT INTO alpha_runtime_metadata(sha256,code_hash,spec_version,scale_hex) VALUES(?,?,?,?) ON CONFLICT(sha256) DO NOTHING",
            values: [
              s.metadata_sha256,
              s.code_hash,
              s.spec_version,
              s.metadata_scale_hex,
            ],
          },
        ]
      : []),
    {
      text: `INSERT INTO alpha_snapshot_passes(${passColumns.join(",")}) SELECT ${passColumns.map(() => "?").join(",")} WHERE EXISTS(SELECT 1 FROM alpha_snapshot_passes WHERE captured_at=${at}) OR (
        (SELECT COUNT(*) FROM alpha_snapshot_passes WHERE completed_at IS NULL)<2
        AND (SELECT COALESCE(SUM(expected_rows),0) FROM alpha_snapshot_passes WHERE completed_at IS NULL)+${s.total_rows}<=1000000)
        ON CONFLICT(captured_at) DO UPDATE SET expected_rows=CASE WHEN ${identity} THEN excluded.expected_rows ELSE NULL END`,
      values: passValues,
    },
    {
      text: `INSERT INTO alpha_snapshot_chunks(captured_at,batch_index,sha256,row_count,first_owner,last_owner)
      SELECT ?,?,CASE WHEN NOT EXISTS(SELECT 1 FROM alpha_snapshot_chunks WHERE captured_at=? AND batch_index<>? AND first_owner<=? AND last_owner>=?) THEN ? ELSE NULL END,?,?,?
      ON CONFLICT(captured_at,batch_index) DO UPDATE SET sha256=CASE WHEN alpha_snapshot_chunks.sha256=excluded.sha256 THEN excluded.sha256 ELSE NULL END`,
      values: [
        at,
        s.index,
        at,
        s.index,
        owners.at(-1) ?? null,
        owners[0] ?? null,
        digest,
        rows.length,
        owners[0] ?? null,
        owners.at(-1) ?? null,
      ],
    },
    ...(rows.length
      ? captureUpsertStatements(
          {
            table: "alpha_snapshot_rows",
            columns: [
              "captured_at",
              "coldkey",
              "hotkey",
              "netuid",
              "share_fraction",
              "shares",
              "alpha_rao",
              "alpha_evidence",
            ],
            conflict: ["captured_at", "coldkey", "hotkey", "netuid"],
          },
          rows,
          undefined,
          pending,
        )
      : []),
    {
      text: `UPDATE alpha_snapshot_passes SET received_rows=received_rows+?,received_chunks=received_chunks+1 WHERE captured_at=? AND ${pending}`,
      values: [rows.length, at],
    },
    {
      text: "UPDATE alpha_snapshot_chunks SET applied=1 WHERE captured_at=? AND batch_index=? AND sha256=?",
      values: [at, s.index, digest],
    },
    {
      text: `INSERT INTO nominator_positions(coldkey,hotkey,netuid,share_fraction,shares,captured_at,source,alpha_rao,alpha_evidence)
      SELECT coldkey,hotkey,netuid,share_fraction,shares,captured_at,'alpha',alpha_rao,alpha_evidence FROM alpha_snapshot_rows WHERE captured_at=? AND ${promote}
      ON CONFLICT(coldkey,hotkey,netuid) DO UPDATE SET share_fraction=excluded.share_fraction,shares=excluded.shares,captured_at=excluded.captured_at,source=excluded.source,alpha_rao=excluded.alpha_rao,alpha_evidence=excluded.alpha_evidence`,
      values: [at],
    },
    {
      text: `DELETE FROM nominator_positions WHERE source='alpha' AND captured_at<>? AND ${promote}`,
      values: [at],
    },
    {
      text: `INSERT INTO nominator_positions_passes(captured_at,expected_rows,received_rows,completed_at) SELECT ?,?,?,? WHERE ${promote} ON CONFLICT(captured_at) DO UPDATE SET expected_rows=excluded.expected_rows,received_rows=excluded.received_rows,completed_at=excluded.completed_at`,
      values: [at, s.total_rows, s.total_rows, now],
    },
    {
      text: `DELETE FROM nominator_scan_receipts WHERE captured_at<? AND ${promote}`,
      values: [at - NOMINATOR_SCAN_RECEIPTS_RETENTION_MS],
    },
    {
      text: `INSERT INTO nominator_scan_receipts(captured_at,coldkey,row_count)
        SELECT captured_at,coldkey,COUNT(*) FROM alpha_snapshot_rows WHERE captured_at=? AND ${promote}
        GROUP BY captured_at,coldkey ON CONFLICT(captured_at,coldkey) DO UPDATE SET row_count=excluded.row_count`,
      values: [at],
    },
    {
      text: `INSERT INTO archive_export_revisions(table_name,revision) SELECT 'nominator_positions',1 WHERE ${promote}
      ON CONFLICT(table_name) DO UPDATE SET revision=archive_export_revisions.revision+1`,
      values: [],
    },
    {
      text: `UPDATE alpha_snapshot_passes SET selected=CASE WHEN
        (SELECT COUNT(*) FROM nominator_positions WHERE source='alpha')=expected_rows
        AND NOT EXISTS(SELECT 1 FROM alpha_snapshot_rows r LEFT JOIN nominator_positions p
          ON p.coldkey=r.coldkey AND p.hotkey=r.hotkey AND p.netuid=r.netuid
          WHERE r.captured_at=${at} AND (p.source IS NOT 'alpha' OR p.captured_at IS NOT r.captured_at
            OR p.alpha_rao IS NOT r.alpha_rao OR p.alpha_evidence IS NOT r.alpha_evidence OR p.share_fraction IS NOT r.share_fraction))
        THEN 1 ELSE NULL END WHERE captured_at=? AND ${promote}`,
      values: [at],
    },
    {
      text: `UPDATE alpha_snapshot_passes SET completed_at=? WHERE captured_at=? AND ${complete}`,
      values: [now, at],
    },
    {
      text: "DELETE FROM alpha_snapshot_rows WHERE captured_at IN (SELECT captured_at FROM alpha_snapshot_passes WHERE completed_at IS NOT NULL)",
      values: [],
    },
    {
      text: "DELETE FROM alpha_snapshot_pools WHERE captured_at IN (SELECT captured_at FROM alpha_snapshot_passes WHERE completed_at IS NOT NULL)",
      values: [],
    },
  ];
  await store.transaction(statements);
  const receipt = await store.first<{
    sha256: string;
    applied: number;
    received_rows: number;
    received_chunks: number;
    completed_at: number | null;
    selected: number;
  }>(
    "SELECT c.sha256,c.applied,p.received_rows,p.received_chunks,p.completed_at,p.selected FROM alpha_snapshot_chunks c JOIN alpha_snapshot_passes p USING(captured_at) WHERE c.captured_at=? AND c.batch_index=?",
    [at, s.index],
  );
  if (!receipt || receipt.sha256 !== digest || receipt.applied !== 1)
    throw new Error("Alpha snapshot chunk was not durably acknowledged");
  return {
    ok: true,
    alpha_snapshot: {
      ...s,
      metadata_scale_hex: undefined,
      ...receipt,
      complete: receipt.completed_at !== null,
    },
    nominator_positions_written: rows.length,
    stores: ["d1"],
  };
}
