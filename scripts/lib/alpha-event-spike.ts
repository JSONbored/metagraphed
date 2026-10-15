// Offline evidence spike for #10835. This never writes positions or advances a
// producer cursor. Source quantities remain raw; the existing canonical quote
// helper is the sole owner of same-hash legacy/V2/epoch arithmetic.
import { z } from "zod";
import { Buffer } from "node:buffer";
import {
  ALPHA_GENESIS,
  ALPHA_RUNTIMES,
} from "../../src/alpha-runtime-identity.ts";
import { quoteAlphaPool } from "../../src/alpha-share-value.ts";
import {
  normalizeAccountId32Field,
  decodeSs58,
  encodeAccountId32,
} from "../../src/ss58.ts";

const hash = z.string().regex(/^0x[0-9a-f]{64}$/);
const sha = z.string().regex(/^[0-9a-f]{64}$/);
const height = z.number().int().min(0).max(0xffffffff);
const clock = z.number().int().positive().max(8_640_000_000_000_000);
const runtime = z.strictObject({
  spec_version: z.number().int().positive(),
  code_hash: hash,
  metadata_sha256: sha,
});
const header = z.strictObject({
  block_number: height,
  block_hash: hash,
  parent_hash: hash,
  timestamp_ms: clock,
});
const censusBlock = header.extend({
  event_count: z.number().int().min(0).max(20_000),
  runtime,
});
export const AlphaSpikeManifestSchema = z.strictObject({
  version: z.literal(1),
  evidence_kind: z.enum(["synthetic", "retained"]),
  genesis_hash: z.literal(ALPHA_GENESIS),
  source_sha256: sha,
  // This is a declared independent census, not an authentication mechanism.
  census_provenance: z.string().min(1).max(2048),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  before: header,
  after: header,
  blocks: z.array(censusBlock).min(1).max(10_000),
});
const event = z.strictObject({
  event_index: z.number().int().min(0).max(19_999),
  pallet: z.string().min(1).max(128),
  method: z.string().min(1).max(128),
  args: z.string().max(2 * 1024 * 1024),
});
const canonical = z.strictObject({
  hotkey: z.string().max(64),
  coldkey: z.string().max(64),
  netuid: z.number().int().min(0).max(65535),
  evidence: z.unknown(),
  alpha_rao: z
    .string()
    .regex(/^(0|[1-9]\d*)$/)
    .max(20),
});
export const AlphaSpikeBlockSchema = header.extend({
  runtime,
  events: z.array(event).max(20_000),
  canonical_state: z.array(canonical).max(20_000),
});
export type AlphaSpikeManifest = z.infer<typeof AlphaSpikeManifestSchema>;
export type AlphaSpikeBlock = z.infer<typeof AlphaSpikeBlockSchema>;

function account(value: unknown): string | null {
  if (typeof value === "string" && value.length > 64) return null;
  const decoded = decodeSs58(value);
  if (decoded?.prefix === 42) return encodeAccountId32(decoded.publicKey, 42);
  return normalizeAccountId32Field(value);
}
// Retain unsafe numeric operand tokens as strings when the native parser
// supplies their original source. Older parsers explicitly mark that operand
// unavailable; neither path permits rounded quantities to become state.
function rawArguments(text: string): unknown {
  return JSON.parse(
    text,
    (_key: string, value: unknown, context?: { source?: string }) =>
      typeof value === "number" && !Number.isSafeInteger(value)
        ? (context?.source ?? { unavailable_numeric_source: true })
        : value,
  );
}

function netuid(value: unknown): number | null {
  // Peel the runtime NetUid newtype, without recursively guessing field names.
  if (Array.isArray(value) && value.length === 1) value = value[0];
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 65535
    ? value
    : null;
}
function unsigned64(value: unknown): boolean {
  if (Array.isArray(value) && value.length === 1) value = value[0];
  if (typeof value === "number")
    return Number.isSafeInteger(value) && value >= 0;
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)$/.test(value) &&
    value.length <= 20 &&
    BigInt(value) <= (1n << 64n) - 1n
  );
}

const originalState = [
  "Alpha/AlphaV2 member originals",
  "TotalHotkeyShares/TotalHotkeySharesV2 denominator",
  "TotalHotkeyAlpha",
];
const methods = new Set([
  "StakeAdded",
  "StakeRemoved",
  "StakeMoved",
  "StakeSwapped",
  "StakeTransferred",
  "SharePoolDenominatorReconciled",
]);
const runtimeKnown = (
  value: z.infer<typeof runtime>,
): value is typeof value & { spec_version: 454 | 478 } =>
  (value.spec_version === 454 || value.spec_version === 478) &&
  value.code_hash === ALPHA_RUNTIMES[value.spec_version].code &&
  value.metadata_sha256 === ALPHA_RUNTIMES[value.spec_version].metadata;

export class AlphaEventSpike {
  private manifest: AlphaSpikeManifest;
  private at = 0;
  private previous: z.infer<typeof header>;
  private rows = 0;
  private touched = new Set<string>();
  private unsupported = new Map<string, number>();
  private observations: Record<string, unknown>[] = [];
  private checks = 0;
  private dayStart: number;
  private failed = false;
  private malformed = 0;
  private observationBytes = 0;

  constructor(input: unknown) {
    this.manifest = AlphaSpikeManifestSchema.parse(input);
    this.dayStart = Date.parse(`${this.manifest.day}T00:00:00Z`);
    if (
      !Number.isFinite(this.dayStart) ||
      new Date(this.dayStart).toISOString().slice(0, 10) !== this.manifest.day
    )
      throw new Error("Invalid UTC day");
    this.previous = this.manifest.before;
    if (
      this.previous.timestamp_ms >= this.dayStart ||
      this.manifest.after.timestamp_ms < this.dayStart + 86_400_000
    )
      throw new Error("Adjacent headers do not bound the complete UTC day");
    const total = this.manifest.blocks.reduce((n, b) => n + b.event_count, 0);
    if (total > 2_000_000)
      throw new Error(
        "Event census exceeds the two-million-row analysis budget",
      );
  }

  accept(input: unknown) {
    if (this.failed)
      throw new Error("Analysis is poisoned by a previous refusal");
    try {
      this.acceptBlock(input);
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }

  private acceptBlock(input: unknown) {
    const block = AlphaSpikeBlockSchema.parse(input);
    const expected = this.manifest.blocks[this.at];
    if (
      !expected ||
      ["block_number", "block_hash", "parent_hash", "timestamp_ms"].some(
        (key) =>
          block[key as keyof typeof block] !==
          expected[key as keyof typeof expected],
      ) ||
      ["spec_version", "code_hash", "metadata_sha256"].some(
        (key) =>
          block.runtime[key as keyof typeof block.runtime] !==
          expected.runtime[key as keyof typeof expected.runtime],
      )
    )
      throw new Error("Block differs from pinned census");
    if (
      block.block_number !== this.previous.block_number + 1 ||
      block.parent_hash !== this.previous.block_hash ||
      block.timestamp_ms < this.previous.timestamp_ms ||
      block.timestamp_ms < this.dayStart ||
      block.timestamp_ms >= this.dayStart + 86_400_000
    )
      throw new Error(
        "Duplicate, unordered, missing, reorged or out-of-day block",
      );
    if (
      block.events.length !== expected.event_count ||
      block.events.some((row, index) => row.event_index !== index)
    )
      throw new Error("Event order or complete census differs");
    this.rows += block.events.length;
    const qualified = runtimeKnown(block.runtime);
    for (const row of block.events) {
      if (row.pallet !== "SubtensorModule") continue;
      if (
        !qualified ||
        !methods.has(row.method) ||
        (row.method === "SharePoolDenominatorReconciled" &&
          block.runtime.spec_version !== 478)
      ) {
        const key = `${block.runtime.spec_version}:${row.method}`;
        this.unsupported.set(key, (this.unsupported.get(key) ?? 0) + 1);
        continue;
      }
      let args: unknown;
      try {
        args = rawArguments(row.args);
      } catch {
        args = null;
      }
      const fields = Array.isArray(args)
        ? args
        : row.method === "SharePoolDenominatorReconciled" &&
            args &&
            typeof args === "object"
          ? [
              (args as Record<string, unknown>).hotkey,
              (args as Record<string, unknown>).netuid,
            ]
          : [];
      const pools: string[] = [];
      const missing: string[] = [...originalState];
      if (block.runtime.spec_version === 478)
        missing.push("AlphaSharePoolEpoch", "AlphaShareEpoch");
      const add = (hot: unknown, net: unknown) => {
        const hotkey = account(hot),
          id = netuid(net);
        if (hotkey === null || id === null)
          missing.push("decodable pool identity");
        else if (id === 0)
          missing.push("root leg requires separate root-state semantics");
        else {
          const key = `${hotkey}:${id}`;
          pools.push(key);
        }
      };
      let operands: string[];
      switch (row.method) {
        case "StakeAdded":
        case "StakeRemoved":
          operands = [
            "coldkey",
            "hotkey",
            "tao_amount",
            "alpha_amount",
            "netuid",
            "fee",
          ];
          add(fields[1], fields[4]);
          break;
        case "StakeMoved":
          operands = [
            "coldkey",
            "origin_hotkey",
            "origin_netuid",
            "destination_hotkey",
            "destination_netuid",
            "tao_amount",
          ];
          add(fields[1], fields[2]);
          add(fields[3], fields[4]);
          break;
        case "StakeSwapped":
          operands = [
            "coldkey",
            "hotkey",
            "origin_netuid",
            "destination_netuid",
            "tao_amount",
          ];
          add(fields[1], fields[2]);
          add(fields[1], fields[3]);
          break;
        case "StakeTransferred":
          operands = [
            "origin_coldkey",
            "destination_coldkey",
            "hotkey",
            "origin_netuid",
            "destination_netuid",
            "tao_amount",
          ];
          add(fields[2], fields[3]);
          add(fields[2], fields[4]);
          break;
        default:
          operands = ["hotkey", "netuid"];
          add(fields[0], fields[1]);
          break;
      }
      const validOperands =
        fields.length === operands.length &&
        operands.every((name, index) =>
          name.includes("hotkey") || name.includes("coldkey")
            ? account(fields[index]) !== null
            : name.includes("netuid")
              ? netuid(fields[index]) !== null
              : unsigned64(fields[index]),
        );
      if (!validOperands) {
        this.malformed++;
        missing.push("complete well-typed pinned event operands");
      } else for (const pool of pools) this.touched.add(pool);
      const observation = {
        block_number: block.block_number,
        block_hash: block.block_hash,
        event_index: row.event_index,
        method: row.method,
        runtime: block.runtime,
        operands,
        raw_args: row.args,
        pools: validOperands ? [...new Set(pools)] : [],
        typed_operands_valid: validOperands,
        missing_state: missing,
        event_only_derivable: false,
      };
      this.observationBytes += Buffer.byteLength(JSON.stringify(observation));
      if (this.observationBytes > 64 * 1024 * 1024)
        throw new Error("Per-event report exceeds its byte budget");
      this.observations.push(observation);
    }
    const members = new Set<string>();
    for (const state of block.canonical_state) {
      const hotkey = account(state.hotkey),
        coldkey = account(state.coldkey);
      const key = `${coldkey}:${hotkey}:${state.netuid}`;
      if (
        !qualified ||
        hotkey === null ||
        coldkey === null ||
        state.netuid === 0 ||
        members.has(key)
      )
        throw new Error("Canonical state identity is unsupported or repeated");
      members.add(key);
      if (
        quoteAlphaPool(state.evidence, block.runtime.spec_version as 454 | 478)
          .alphaRao !== state.alpha_rao
      )
        throw new Error("Same-hash canonical quantity differs");
      if (++this.checks > 100_000)
        throw new Error("Canonical comparison exceeds its row budget");
    }
    this.previous = block;
    this.at++;
  }

  finish(actualSourceSha256: string) {
    if (this.failed)
      throw new Error("Analysis is poisoned by a previous refusal");
    const after = this.manifest.after;
    if (
      actualSourceSha256 !== this.manifest.source_sha256 ||
      this.at !== this.manifest.blocks.length ||
      after.block_number !== this.previous.block_number + 1 ||
      after.parent_hash !== this.previous.block_hash
    )
      throw new Error("Source digest or complete window proof differs");
    return {
      version: 1,
      evidence_kind: this.manifest.evidence_kind,
      day: this.manifest.day,
      source_sha256: actualSourceSha256,
      census_provenance: this.manifest.census_provenance,
      declared_window_verified: true,
      block_count: this.at,
      event_count: this.rows,
      known_event_touched_pool_count: this.touched.size,
      known_event_touched_pools: [...this.touched].sort(),
      // No claim that all state mutations emit one of these events. These are
      // observed event touches, not a census of every pool whose value changed.
      complete_state_mutation_pool_count: null,
      event_only_producer_qualified: false,
      authentic_day_evidence_verified: false,
      independent_custody_verified: false,
      chain_finality_verified: false,
      complete_event_universe_verified: false,
      unsupported_subtensor_methods: Object.fromEntries(
        [...this.unsupported].sort(),
      ),
      canonical_same_hash_checks: this.checks,
      malformed_supported_events: this.malformed,
      events: this.observations,
    };
  }
}
