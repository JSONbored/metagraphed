import { useQuery } from "@tanstack/react-query";
import { subnetOwnerCaptureQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, EmptyState, ErrorState } from "@/components/metagraphed/states";
import type { OwnerCaptureUid } from "@/lib/metagraphed/types";

/**
 * How much of a subnet's emission reaches its owner (#10929).
 *
 * THIS CARD IS ONE STEP FROM AN ACCUSATION AND HAS TO STAY ON THE RIGHT SIDE
 * OF IT. Three rules, each of which the render enforces rather than assumes:
 *
 * 1. NOTHING IS CALLED CAPTURE OR TAKE. The measurement is "emission landed on
 *    UIDs the declared owner coldkey holds". What the owner keeps depends on
 *    who is staked behind those validators and on any cut inside the subnet's
 *    own code — neither is visible here. The label says "attributed".
 * 2. THE BLIND SPOTS RENDER BESIDE THE NUMBER, not in a docs link. A reader
 *    who sees 62% and not the three layers it excludes has been misled by
 *    omission, and the payload carries them precisely so this card can show
 *    them.
 * 3. A HIGH NOMINATOR SHARE IS NOT STYLED AS A WARNING. It is a measured
 *    fraction with four innocent explanations before a suspicious one, so it
 *    renders in the same neutral type as every other figure. `take: null`
 *    renders as an em dash — no Delegates entry is not a 0% commission.
 */
export function SubnetOwnerCapturePanel({ netuid }: { netuid: number }) {
  const { data, isLoading, isError, error, refetch } = useQuery(
    subnetOwnerCaptureQuery(netuid, "30d"),
  );

  if (isLoading) return <Skeleton className="h-[200px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const card = data?.data ?? null;
  if (!card || card.points.length === 0) {
    return (
      <EmptyState
        title="No owner-capture reading yet"
        description="The daily per-UID rollup has not been captured for this subnet over the selected window."
      />
    );
  }

  // Points arrive newest-first from the route.
  const latest = card.points[0];

  return (
    <Panel>
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <Figure
          label="protocol cut (L1)"
          value={latest.owner_cut_share}
          hint="The 18% every subnet pays and none of them chooses. Reconstructed — SubnetOwnerCut is unset on chain."
        />
        <Figure
          label="attributed to owner UIDs (L2)"
          value={latest.owner_attributed_share}
          hint="Emission that landed on UIDs held by the declared owner coldkey. Attributed, not kept — see what this cannot see, below."
        />
        <Figure
          label="both layers"
          value={latest.owner_combined_share}
          hint="L1 + L2 over one denominator. This is arithmetic over two chain readings, not a finding about the team."
        />
      </div>

      {card.owner_uids.length > 0 && (
        <div className="mt-4">
          <div className="text-13 text-ink-muted">Owner-held UIDs ({card.owner_uids.length})</div>
          <ul className="mt-2 space-y-1">
            {card.owner_uids.map((uid) => (
              <li key={String(uid.uid)} className="text-13 text-ink-muted">
                <span className="text-ink-strong">UID {uid.uid}</span>
                {uid.validator_permit ? " · validator" : " · miner"}
                {" · take "}
                {uid.take == null ? "—" : `${(uid.take * 100).toFixed(1)}%`}
                {uid.nominator_share == null
                  ? ""
                  : ` · ${(uid.nominator_share * 100).toFixed(1)}% of its stake is not the owner's`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Never collapsed behind a link. See rule 2 above. */}
      <div className="mt-4 border-t border-border/60 pt-3">
        <div className="text-13 text-ink-muted">What this measurement cannot see</div>
        <ul className="mt-1 space-y-1">
          {card.blind_spots.map((spot) => (
            <li key={spot.layer} className="text-13 text-ink-muted">
              <span className="text-ink-strong">{spot.layer}</span> — {spot.summary}
            </li>
          ))}
        </ul>
      </div>
    </Panel>
  );
}

/** A share rendered as a percentage, or an em dash. NEVER 0% for a null — a
 * day nothing was emitted and a day the owner received nothing are different
 * facts, and only one of them is a statement about the owner. */
export function percentOrDash(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

/** The line under an owner-held UID. Extracted so the null-take rule is
 * testable without rendering the tree. */
export function takeLabel(uid: OwnerCaptureUid): string {
  return uid.take == null ? "—" : `${(uid.take * 100).toFixed(1)}%`;
}

function Figure({
  label,
  value,
  hint,
}: {
  label: string;
  value: number | null | undefined;
  hint: string;
}) {
  return (
    <div>
      <div className="text-13 text-ink-muted">{label}</div>
      <div className="text-13 text-ink-strong">{percentOrDash(value)}</div>
      <div className="text-13 text-ink-muted">{hint}</div>
    </div>
  );
}
