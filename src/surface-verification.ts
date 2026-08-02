// Machine verification of CATALOGUED surfaces from probe evidence (#8689).
//
// Before this, `machine-verified` was a tier the codebase could compute but that
// nothing could ever produce -- the live registry reported exactly ZERO of them
// against 623 eligible operational surfaces, with 550 sitting at
// `candidate-discovered` and 540 of those never verified at all.
//
// The cause was two halves of a working system that were never wired together.
// `scripts/lib.ts`'s flattenSurfaces derives `last_verified_at` from
// `surface.verification.verified_at` inside `registry/subnets/<slug>.json` -- a
// HAND-EDITED field. Meanwhile the 15-minute cron prober
// (`src/health-prober.ts`) has been probing every catalogued surface
// continuously and accumulating real per-day uptime history, and none of that
// evidence could reach the field that decides the tier. Verification was
// therefore a manual registry edit, which is why almost nothing had it.
//
// WHY NOT scripts/verify-candidates.ts. That verifier is real and good, but it
// is an INTAKE check: it probes `registry/candidates/**` -- things not yet
// promoted into the registry -- and its compact artifact is keyed by
// `candidate_id`. Joining its 2,050 rows against the 623 catalogued surfaces
// matches 18 of them (7 by id, 18 through the candidates file by URL), because
// once a candidate is promoted its surface gets a different id and its URL
// leaves the candidates corpus. It cannot verify the catalogue because it does
// not probe the catalogue. The health prober does, and covers all of it.
//
// The evidence therefore comes from the prober's per-surface `day_count`,
// `samples` and `uptime_ratio` over a 90-day window — the shape
// `GET /api/v1/subnets/{netuid}/uptime` serves. #9096 moved the SCHEDULED
// snapshot of that evidence off a GitHub Actions bot-PR lane and onto the
// daily Worker cron in src/surface-verification-sync.ts, which reads the same
// window straight from D1 and writes the `generated/surface-health.json` R2
// store; `scripts/sync-surface-verification.ts` remains the way to refresh the
// committed `registry/verification/surface-health.json` seed by hand. Both
// writers share the extractor and assembler at the bottom of this file, and
// flattenSurfaces reads whichever copy loadSurfaceProbeEvidence resolved
// (store first, committed seed second). Still committed rather than fetched
// unconditionally at build time because this repo's builds are byte-for-byte
// deterministic (tests/artifacts.test.ts asserts it) and an unconditional
// network call inside the build would end that — the store read is
// credential-gated for exactly that reason.

/** One surface's probe record, as snapshotted from the uptime endpoint. */
export interface SurfaceProbeRecord {
  /** Distinct UTC days that carry at least one probe sample. */
  day_count: number;
  /** Total probe samples in the window. */
  samples: number;
  /** Fraction of samples that were healthy, 0..1. */
  uptime_ratio: number;
  /** Most recent healthy probe, ISO. Becomes `verified_at` on a pass. */
  last_ok: string | null;
  /** Latest per-surface classification from the prober, when it has one. */
  classification?: string | null;
}

/**
 * The promotion bar.
 *
 * Deliberately three independent conditions rather than one blended score,
 * because each rules out a different way of being wrong:
 *
 *   - MIN_DAYS guards against a surface that looks perfect for an hour. Seven
 *     distinct days means a weekly maintenance window or a weekend-only outage
 *     has had a chance to show up.
 *   - MIN_SAMPLES guards against a surface the prober has barely reached. At
 *     one probe per 15 minutes a healthy surface accrues ~96/day, so 100 is
 *     roughly a single full day's worth -- low enough that a surface added
 *     mid-window still qualifies once it has served a week, high enough that a
 *     handful of lucky probes cannot carry it.
 *   - MIN_UPTIME is 0.99 rather than 1.0 on purpose. Requiring perfection would
 *     mean a single transient network blip in ninety days permanently blocks
 *     promotion, which punishes surfaces for OUR probe's flakiness. At ~96
 *     probes/day over 7 days, 0.99 still allows only ~6 failures.
 *
 * 0.99 is placed at a measured knee, not picked round. The live 90-day uptime
 * distribution across the 618 surfaces that clear the day/sample bars
 * (2026-07-29):
 *
 *     1.000        150     ratio >= 0.999 : 228 verified
 *     0.999+        78     ratio >= 0.99  : 463
 *     0.99-0.999   235     ratio >= 0.98  : 497
 *     0.95-0.99     60     ratio >= 0.95  : 523
 *     0.90-0.95     18     ratio >= 0.90  : 541
 *     0.50-0.90     35
 *     <0.50         42
 *
 * The healthy population is one mass running from 0.99 to 1.000 (463 of 618).
 * Relaxing to 0.98 buys only 34 more surfaces while reaching into the band
 * where a surface fails 1-5% of probes; tightening to 0.999 discards 235
 * surfaces that are plainly fine. The bar sits in the gap between those.
 */
export const MIN_VERIFY_DAYS = 7;
export const MIN_VERIFY_SAMPLES = 100;
export const MIN_VERIFY_UPTIME = 0.99;

/**
 * Classifications that DEMOTE a surface immediately, without waiting for the
 * per-kind freshness TTL (#1006) to age its verification out.
 *
 * Staleness and deadness are different failures. A stale verification means
 * "we have not looked recently"; a dead surface means "we looked, and it is
 * gone". Letting a confirmed-dead surface coast on a verified_at until its TTL
 * expires would keep advertising it as machine-verified for days after we knew
 * better -- which is the exact complaint in #8658's title.
 */
export const DEMOTING_CLASSIFICATIONS = new Set(["dead", "unsafe"]);

/**
 * Has the prober CONFIRMED this surface dead (or unsafe)?
 *
 * Separate from `verifyFromProbeEvidence` returning false, because "not
 * verified" and "confirmed gone" call for different handling: the first simply
 * withholds a promotion, the second must revoke one that already exists --
 * including a hand-authored verification, since live evidence outranks a
 * historical hand-edit when they disagree about whether a thing still exists.
 *
 * Absence of evidence is NOT death. A surface with no probe record at all is
 * unknown, not dead, and must not be demoted on that basis.
 */
export function isProbeDemoted(
  record: SurfaceProbeRecord | null | undefined,
): boolean {
  const classification = record?.classification;
  return (
    typeof classification === "string" &&
    DEMOTING_CLASSIFICATIONS.has(classification)
  );
}

export interface VerificationVerdict {
  verified: boolean;
  /** ISO instant to use as `verified_at`; null when not verified. */
  verifiedAt: string | null;
  /** Why, in a form that can be stored as evidence and read by a human. */
  reason: string;
}

/**
 * Decide whether probe evidence verifies a surface.
 *
 * Pure and total: any missing/degenerate input is "not verified" with a stated
 * reason, never a throw and never an accidental pass. A surface we know nothing
 * about must not be promoted by the absence of bad news.
 */
export function verifyFromProbeEvidence(
  record: SurfaceProbeRecord | null | undefined,
): VerificationVerdict {
  if (!record) {
    return { verified: false, verifiedAt: null, reason: "no probe evidence" };
  }
  const classification = record.classification ?? null;
  if (classification && DEMOTING_CLASSIFICATIONS.has(classification)) {
    return {
      verified: false,
      verifiedAt: null,
      reason: `classified ${classification}`,
    };
  }
  const days = Number(record.day_count);
  const samples = Number(record.samples);
  const uptime = Number(record.uptime_ratio);
  if (!Number.isFinite(days) || days < MIN_VERIFY_DAYS) {
    return {
      verified: false,
      verifiedAt: null,
      reason: `observed on ${Number.isFinite(days) ? days : 0} of ${MIN_VERIFY_DAYS} required days`,
    };
  }
  if (!Number.isFinite(samples) || samples < MIN_VERIFY_SAMPLES) {
    return {
      verified: false,
      verifiedAt: null,
      reason: `${Number.isFinite(samples) ? samples : 0} of ${MIN_VERIFY_SAMPLES} required samples`,
    };
  }
  if (!Number.isFinite(uptime) || uptime < MIN_VERIFY_UPTIME) {
    return {
      verified: false,
      verifiedAt: null,
      reason: `uptime ${Number.isFinite(uptime) ? uptime.toFixed(4) : "unknown"} below ${MIN_VERIFY_UPTIME}`,
    };
  }
  // `last_ok` is the instant the evidence actually attests to. Falling back to
  // "now" would date the verification to whenever the sync ran rather than to
  // the last time we genuinely saw the surface healthy, and that difference is
  // what the per-kind freshness TTL measures against.
  if (!record.last_ok) {
    return {
      verified: false,
      verifiedAt: null,
      reason: "meets thresholds but has no last_ok instant to attest to",
    };
  }
  return {
    verified: true,
    verifiedAt: record.last_ok,
    reason: `${days}d, ${samples} samples, uptime ${uptime.toFixed(4)}`,
  };
}

/**
 * The `verification` block to stamp on a verified surface.
 *
 * `method` records HOW, so a reader can tell a probe-derived verification from
 * a maintainer's hand-vetted one and weigh them differently. Health data is
 * probe-derived only (a house rule -- never hand-set), and this keeps that
 * property legible at the point of use.
 */
export function probeVerificationBlock(verdict: VerificationVerdict): {
  verified_at: string;
  method: string;
  evidence: string;
} | null {
  if (!verdict.verified || !verdict.verifiedAt) return null;
  return {
    verified_at: verdict.verifiedAt,
    method: "live-cron-prober",
    evidence: verdict.reason,
  };
}

// --- The snapshot artifact both writers produce (#9096) ----------------------
//
// Extracted here so the Worker cron (src/surface-verification-sync.ts, which
// replaced the retired sync-surface-verification.yml bot-PR lane) and the CLI
// seed refresher (scripts/sync-surface-verification.ts) share ONE record
// extractor and ONE artifact assembler. These feed `machine-verified`, so a
// fork between the two writers would silently change surface TRUST LEVELS
// rather than merely producing a different-looking file.

type UptimeRow = Record<string, unknown>;

/**
 * Extract per-surface probe records from ONE subnet's uptime payload — the
 * exact shape `formatUptime` (src/health-serving.ts) returns, which is what
 * both `GET /api/v1/subnets/{netuid}/uptime` serves and what `loadSubnetUptime`
 * returns directly from D1.
 *
 * Field-for-field the mapping the retired lane's script performed:
 *   - `samples` / `uptime_ratio` fall back to the surface's `reliability` block
 *     (formatUptime sets both at the top level today, so the fallback is belt
 *     and braces against a future shape change, not a live path);
 *   - `last_ok` prefers a per-surface instant and otherwise takes the payload's
 *     own `observed_at`, because the uptime rollup carries no last_ok of its
 *     own and the window's observation instant is what the evidence attests to;
 *   - `classification` is passed through only when it is a string.
 *
 * Writes INTO the supplied map so a caller sweeping every subnet accumulates
 * one flat surface_id-keyed record set, exactly as the script's loop did.
 */
export function collectSurfaceProbeRecords(
  data: unknown,
  into: Record<string, SurfaceProbeRecord>,
): Record<string, SurfaceProbeRecord> {
  const payload = (data ?? {}) as UptimeRow;
  const surfaces = Array.isArray(payload.surfaces)
    ? (payload.surfaces as UptimeRow[])
    : [];
  for (const surface of surfaces) {
    const surfaceId = surface?.surface_id;
    if (typeof surfaceId !== "string" || !surfaceId) continue;
    const reliability = (surface.reliability as UptimeRow | undefined) || {};
    into[surfaceId] = {
      day_count: Number(surface.day_count ?? 0),
      samples: Number(surface.samples ?? reliability.sample_count ?? 0),
      uptime_ratio: Number(
        surface.uptime_ratio ?? reliability.uptime_ratio ?? 0,
      ),
      last_ok:
        typeof surface.last_ok === "string"
          ? surface.last_ok
          : typeof payload.observed_at === "string"
            ? (payload.observed_at as string)
            : null,
      classification:
        typeof surface.classification === "string"
          ? surface.classification
          : null,
    };
  }
  return into;
}

export interface SurfaceHealthArtifact {
  schema_version: 1;
  generated_at: string;
  notes: string;
  source: "live-cron-prober";
  subnets_reached: number;
  subnets_total: number;
  surface_count: number;
  verified_count: number;
  unverified_reasons: Record<string, number>;
  surfaces: Record<string, SurfaceProbeRecord>;
}

/**
 * Assemble the surface-health snapshot from a surface_id-keyed record set.
 *
 * Surface ids are sorted and re-inserted in order so the object's key order is
 * stable across runs — the retired lane depended on that for a readable git
 * diff, and the cron depends on it for its content digest.
 */
export function buildSurfaceHealthArtifact({
  records,
  subnetsReached,
  subnetsTotal,
  generatedAt,
}: {
  records: Record<string, SurfaceProbeRecord>;
  subnetsReached: number;
  subnetsTotal: number;
  generatedAt: string;
}): SurfaceHealthArtifact {
  const surfaceIds = Object.keys(records).sort();
  let verified = 0;
  const reasons: Record<string, number> = {};
  for (const id of surfaceIds) {
    const verdict = verifyFromProbeEvidence(records[id]);
    if (verdict.verified) verified += 1;
    else {
      // Bucket by the failing CONDITION, not the formatted reason, so the
      // summary stays a fixed small set instead of one bucket per distinct
      // number.
      const bucket = verdict.reason.replace(/[\d.]+/g, "N");
      reasons[bucket] = (reasons[bucket] || 0) + 1;
    }
  }
  return {
    schema_version: 1,
    generated_at: generatedAt,
    notes:
      "Per-surface probe evidence from the live cron prober, snapshotted for " +
      "deterministic Git review. Consumed by scripts/lib.ts flattenSurfaces to " +
      "derive machine verification; see src/surface-verification.ts for the bar.",
    source: "live-cron-prober",
    subnets_reached: subnetsReached,
    subnets_total: subnetsTotal,
    surface_count: surfaceIds.length,
    verified_count: verified,
    unverified_reasons: reasons,
    surfaces: Object.fromEntries(surfaceIds.map((id) => [id, records[id]])),
  };
}

// Key-sorted stringify, matching the local-copy convention in
// github-signals-core.ts / operational-surfaces-sync.ts — this module must stay
// importable from both a Worker bundle and a Node script, so it pulls in
// nothing.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
}

/**
 * Content identity of the snapshot with the volatile `generated_at` excluded —
 * the cron's write-only-when-changed gate, equivalent to the retired
 * workflow's `git diff --quiet` gate.
 *
 * `last_ok` is NOT excluded even though it moves with every prober run: it is
 * the instant a verification attests to, so a changed last_ok is a real
 * content change that downstream freshness TTLs measure against.
 */
export function surfaceHealthContentDigest(
  artifact: SurfaceHealthArtifact,
): string {
  return stableStringify({ ...artifact, generated_at: null });
}
