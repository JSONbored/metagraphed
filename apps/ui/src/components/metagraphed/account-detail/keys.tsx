import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankGrid, type RankGridItem } from "@jsonbored/ui-kit";
import {
  accountChildrenQuery,
  accountParentsQuery,
  accountPositionsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { relatedKeys } from "./account-detail-logic";

/**
 * Section 5 — the keys the chain ties to this account.
 *
 * The tie is named on every row, because a hotkey this coldkey stakes
 * through, a child it delegates to and a parent that delegates to it are
 * three different relationships and a bare list of addresses says none of
 * them.
 */
export function KeysSection({ ss58 }: { ss58: string }) {
  const positions = useQuery({ ...accountPositionsQuery(ss58), retry: 0 });
  const children = useQuery({ ...accountChildrenQuery(ss58), retry: 0 });
  const parents = useQuery({ ...accountParentsQuery(ss58), retry: 0 });

  const rows = relatedKeys(
    positions.data?.data.positions ?? [],
    children.data?.data.subnets?.flatMap((subnet) => subnet.entries) ?? [],
    parents.data?.data.subnets?.flatMap((subnet) => subnet.entries) ?? [],
  );

  const items: RankGridItem[] = rows.slice(0, 20).map((row) => ({
    key: row.key,
    label: row.label,
    value: row.role,
    share: row.value,
    href: row.href,
  }));

  return (
    <AnalyticsSection
      id="keys"
      name="Keys"
      question="Hotkeys, children and parents linked to this account."
      visual={
        items.length > 0 ? (
          <RankGrid items={items} cols={4} ariaLabel="Related keys" source="account-key" />
        ) : null
      }
      footnote={
        items.length > 0
          ? `${formatNumber(rows.length)} related keys · live chain`
          : "no hotkey, child or parent tie recorded for this account"
      }
    />
  );
}
