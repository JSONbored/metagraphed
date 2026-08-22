import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { CompositionBreakdown, type CompositionSlice } from "@jsonbored/ui-kit";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { formatNumber, formatTao } from "@/lib/metagraphed/format";
import { buildValidatorIdentityIndex } from "@/lib/metagraphed/validator-identities";

/** Matches the directory's own ceiling so all three views read one cache entry. */
const ALL_VALIDATORS_LIMIT = 2000;

/** Enough named operators to show the shape without turning a bar into a legend. */
const RANKED_OPERATORS = 10;

/**
 * How the network's validation stake divides between operators.
 *
 * This is the one honest part-to-whole on the page, and the only thing here
 * entitled to categorical colour. Stake is denominated in TAO for every key,
 * so unlike a subnet's alpha these values genuinely share a unit and genuinely
 * sum — the comparison a stacked bar claims to make is real.
 *
 * It also answers a question the ranked list cannot. A rail scaled against the
 * largest operator tells you tao.bot is the biggest; it does not tell you the
 * top ten hold most of the network. Past the first few rows every bar is a
 * stub against an empty track, because the distribution is a power law and a
 * linear rail has nothing left to say about its tail.
 */
export function ValidatorStakeConcentration() {
  const { data } = useSuspenseQuery(
    validatorsQuery({ sort: "total_stake", limit: ALL_VALIDATORS_LIMIT, subnets: false }),
  );

  const index = useMemo(
    () => buildValidatorIdentityIndex(data.data.validators ?? []),
    [data.data.validators],
  );

  const slices = useMemo<CompositionSlice[]>(() => {
    const ranked = index.identities.slice(0, RANKED_OPERATORS);
    const accounted = ranked.reduce((sum, identity) => sum + identity.totalStakeTao, 0);
    // The remainder is measured against the FULL observed total, not against
    // the named subset — every key this snapshot reported is in the whole,
    // including the ones declaring no identity.
    const remainder = Math.max(0, index.observedStakeTao - accounted);

    const parts: CompositionSlice[] = ranked.map((identity) => ({
      id: identity.name,
      label: identity.name,
      value: identity.totalStakeTao,
      valueLabel: formatTao(identity.totalStakeTao),
    }));

    if (remainder > 0) {
      const others = Math.max(0, index.identities.length - ranked.length) + index.unnamed.length;
      parts.push({
        id: "__rest__",
        // Named as what it is. "Other" carrying a ramp colour would read as a
        // category of its own; it is a remainder, and it draws neutral.
        // Short, because the legend cell truncates before the bar does and a
        // clipped "564 other keys and oper…" is worse than no sentence.
        label: `${formatNumber(others)} others`,
        value: remainder,
        valueLabel: formatTao(remainder),
        residual: true,
      });
    }
    return parts;
  }, [index]);

  if (slices.length < 2) return null;

  const topShare =
    index.observedStakeTao > 0
      ? slices.filter((slice) => !slice.residual).reduce((sum, slice) => sum + slice.value, 0) /
        index.observedStakeTao
      : 0;

  return (
    <CompositionBreakdown
      ariaLabel={`Share of observed validator stake held by the ${RANKED_OPERATORS} largest named operators, against every other key`}
      slices={slices}
      footnote={`The ${RANKED_OPERATORS} largest named operators hold ${(topShare * 100).toFixed(1)}% of ${formatTao(index.observedStakeTao)} in observed validator stake.`}
    />
  );
}
