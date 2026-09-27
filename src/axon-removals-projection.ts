// Compact classified transitions in the existing D1 artifact table. A cold
// request reads one small object, never weeks of neuron membership. Window
// filtering happens at read time, including across UTC date boundaries.
import { z } from "zod";
import { selectedD1Store } from "./d1-store.ts";
import {
  deriveAxonRemovals,
  type DerivedAxonRemovals,
  type NeuronAxonDayRow,
  isoDaysAgo,
} from "./axon-removal-derivation.ts";

export const AXON_REMOVAL_PROJECTION_KEY = "derived/axon-removals/v1.json";
// The existing projection tick runs every thirty minutes. One missed tick is
// not hidden: after forty-five minutes the original source reader takes over.
export const AXON_REMOVAL_PROJECTION_MAX_AGE_MS = 45 * 60_000;
export const AXON_PROJECTION_LOOKBACK_DAYS = 31;
const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ProjectionSchema = z.strictObject({
  version: z.literal(1),
  generatedAt: z.number().int().positive(),
  removals: z.array(
    z.strictObject({
      netuid: z.number().int().nonnegative(),
      uid: z.number().int().nonnegative(),
      hotkey: z.string().min(1),
      removed_on: DateSchema,
      previous_axon: z.string().min(1),
      kind: z.enum(["stopped-announcing", "moved-unroutable"]),
      current_axon: z.string().nullable(),
    }),
  ),
  excluded: z.array(
    z.strictObject({
      kind: z.enum(["uid-reuse", "pending"]),
      date: DateSchema,
    }),
  ),
});

export async function readAxonRemovalProjection(
  env: unknown,
  windowDays: number,
  nowMs: number,
): Promise<DerivedAxonRemovals | null> {
  // The compact network projection owns only the chain's 7d/30d windows.
  if (windowDays !== 7 && windowDays !== 30) return null;
  const db = selectedD1Store(env, ["neuron_daily"]);
  if (!db) return null;
  try {
    const rows = await db.query<{ payload: string }>(
      "SELECT payload FROM generated_artifacts WHERE key=?",
      [AXON_REMOVAL_PROJECTION_KEY],
    );
    if (!rows.length) return null;
    const parsed = ProjectionSchema.safeParse(JSON.parse(rows[0].payload));
    if (!parsed.success) return null;
    const value = parsed.data;
    const age = nowMs - value.generatedAt;
    if (age < 0 || age > AXON_REMOVAL_PROJECTION_MAX_AGE_MS) return null;
    const sinceDate = isoDaysAgo(nowMs, windowDays);
    const removals = value.removals.filter(
      (row) => row.removed_on >= sinceDate,
    );
    const excluded = value.excluded.filter((row) => row.date >= sinceDate);
    return {
      removals,
      derivation: {
        method: "axon-state-diff",
        lookback_days: AXON_PROJECTION_LOOKBACK_DAYS,
        excluded_uid_reuse: excluded.filter((row) => row.kind === "uid-reuse")
          .length,
        pending_confirmation: excluded.filter((row) => row.kind === "pending")
          .length,
        moved_unroutable: removals.filter(
          (row) => row.kind === "moved-unroutable",
        ).length,
      },
    };
  } catch {
    // An unreadable projection must never manufacture a zero or hide an outage.
    return null;
  }
}

/** Persist only a completely classified source read. */
export async function writeAxonRemovalProjection(
  env: unknown,
  rows: NeuronAxonDayRow[],
  nowMs: number,
): Promise<void> {
  const db = selectedD1Store(env, ["neuron_daily"]);
  if (!db) return;
  const excluded: { kind: "uid-reuse" | "pending"; date: string }[] = [];
  const derived = deriveAxonRemovals(rows, {
    lookbackDays: AXON_PROJECTION_LOOKBACK_DAYS,
    onExcluded: (kind, date) => excluded.push({ kind, date }),
  });
  const payload = JSON.stringify({
    version: 1,
    generatedAt: nowMs,
    removals: derived.removals,
    excluded,
  });
  // D1 has a per-row bound; retain the previous complete projection on growth.
  if (new TextEncoder().encode(payload).byteLength > 1_500_000)
    throw new Error("Axon projection exceeds its storage budget");
  await db.run(
    "INSERT INTO generated_artifacts(key,payload,updated_at) VALUES(?,?,?) " +
      "ON CONFLICT(key) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at",
    [AXON_REMOVAL_PROJECTION_KEY, payload, new Date(nowMs).toISOString()],
  );
}
