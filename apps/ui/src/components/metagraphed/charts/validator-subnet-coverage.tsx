import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { RankedRails, type RankedRailItem } from "@jsonbored/ui-kit";
import { validatorsQuery } from "@/lib/metagraphed/queries";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { formatNumber } from "@/lib/metagraphed/format";
import { EmptyState } from "@/components/metagraphed/states";

// #3495: the global validators payload, ranked by how many subnets each
// validator serves. Pure consumer of validatorsQuery() — no new query/route.
// The payload is server-capped (top validators by stake, top 10 subnets by
// stake per validator), so the detail row is the top of each list, not all of it.

const MAX_VALIDATORS = 15;

export function ValidatorSubnetCoverage() {
  const validators = useSuspenseQuery(
    validatorsQuery({ sort: "total_stake", limit: MAX_VALIDATORS }),
  ).data.data.validators;

  const items = useMemo<RankedRailItem[]>(
    () =>
      validators
        .map((v) => {
          const top = [...(v.subnets ?? [])]
            .sort((a, b) => b.stake_tao - a.stake_tao)
            .map((s) => `SN${s.netuid}`);
          return {
            key: `validator:${v.hotkey}`,
            label: resolveAddress(v.hotkey).display,
            value: v.subnet_count || top.length,
            href: `/validators/${v.hotkey}`,
            detail: [{ key: "subnets", label: "top subnets", value: top.join(", ") || "—" }],
          };
        })
        .filter((i) => i.value > 0)
        .sort((a, b) => b.value - a.value),
    [validators],
  );

  if (items.length === 0) {
    return <EmptyState title="No validator participation data yet" />;
  }

  return (
    <RankedRails
      items={items}
      formatValue={(v) => formatNumber(v)}
      columns={{ value: "Subnets", name: "Validator", track: "served" }}
      limit={10}
      ariaLabel="Validators ranked by subnets served"
      source="validator-subnet-coverage"
    />
  );
}
