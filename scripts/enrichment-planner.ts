// The two decisions that determine whether an "Enrich SN<n>" issue gets filed
// (#8676). Split out of scripts/enrichment-issues.ts so they can be tested:
// that file is a top-level-await CLI, so importing it runs it.
//
// Both decisions exist because the generator produced an unbreakable loop. The
// identical "Enrich SN51 lium.io — add SSE stream" was filed four times
// (#5179, #6653, #7615, #8662): the weekly cron saw no OPEN issue for SN51 and
// made another one, every Wednesday, forever.

export type Row = Record<string, unknown>;

/**
 * Parse `(netuid, kind)` pairs out of existing issue titles.
 *
 * Keyed by pair rather than by netuid: closing "SN51 — add SSE stream" must not
 * also suppress a future "SN51 — add OpenAPI spec" if an OpenAPI candidate
 * later appears. One answered question stays answered; a genuinely new one can
 * still be asked.
 */
export function parseAskedPairs(
  titles: string[],
  kindLabels: Record<string, string>,
): Set<string> {
  const asked = new Set<string>();
  for (const title of titles) {
    const match = /Enrich SN(\d+)\b/.exec(title);
    if (!match) continue;
    for (const [kind, label] of Object.entries(kindLabels)) {
      if (title.includes(label)) asked.add(`${match[1]}:${kind}`);
    }
  }
  return asked;
}

/**
 * Which kinds this subnet should actually be asked about.
 *
 * `missing_kinds` only means "the manifest has no surface of that kind" -- it
 * says nothing about whether one exists to find. 124 of 129 subnets are
 * "missing" sse because most Bittensor subnets do not publish an event stream,
 * so that gap is permanently true and the queue could never drain.
 *
 * The queue already carries the evidence, so we gate on it. That cuts the
 * eligible set from 125 subnets to 42 and takes sse to zero on its own, rather
 * than by hardcoding an exclusion -- no subnet has an sse candidate, which is
 * exactly why nobody could ever close those issues.
 */
export function plannedKindsFor(
  entry: Row,
  inScopeKinds: string[],
  asked: Set<string>,
  valuePriority: string[],
): string[] {
  const netuid = entry.netuid as number;
  const evidence = new Set([
    ...(((entry.candidate_evidence_summary as Row | undefined)
      ?.kinds_with_candidates as string[] | undefined) || []),
    ...((entry.direct_submission_kinds as string[] | undefined) || []),
  ]);
  return ((entry.missing_kinds as string[] | undefined) || [])
    .filter((kind) => inScopeKinds.includes(kind))
    .filter((kind) => evidence.has(kind))
    .filter((kind) => !asked.has(`${netuid}:${kind}`))
    .sort((a, b) => valuePriority.indexOf(a) - valuePriority.indexOf(b));
}
