import { useQuery } from "@tanstack/react-query";
import { AnalyticsSection, RankGrid, type RankGridItem } from "@jsonbored/ui-kit";
import {
  accountChildrenQuery,
  accountParentsQuery,
  accountPositionsQuery,
} from "@/lib/metagraphed/queries";
import { formatNumber } from "@/lib/metagraphed/format";
import { useNearViewport } from "@/hooks/use-near-viewport";
import { ErrorState } from "@/components/metagraphed/states";
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
  const { ref, nearViewport } = useNearViewport("320px 0px");
  const positions = useQuery({ ...accountPositionsQuery(ss58), enabled: nearViewport, retry: 0 });
  const children = useQuery({ ...accountChildrenQuery(ss58), enabled: nearViewport, retry: 0 });
  const parents = useQuery({ ...accountParentsQuery(ss58), enabled: nearViewport, retry: 0 });
  const loading = nearViewport && (positions.isPending || children.isPending || parents.isPending);
  const unavailable = positions.isError || children.isError || parents.isError;

  const rows =
    loading || unavailable
      ? []
      : relatedKeys(
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
      visualRef={ref}
      visual={
        !nearViewport || loading ? (
          <RankGrid
            items={[]}
            cols={4}
            ariaLabel="Related keys"
            source="account-key"
            loading
            loadingItems={4}
          />
        ) : unavailable ? (
          <ErrorState
            error={positions.error ?? children.error ?? parents.error}
            onRetry={() =>
              void Promise.all([positions.refetch(), children.refetch(), parents.refetch()])
            }
            context="related key relationships"
          />
        ) : items.length > 0 ? (
          <RankGrid items={items} cols={4} ariaLabel="Related keys" source="account-key" />
        ) : null
      }
      empty={
        !nearViewport || loading
          ? false
          : unavailable
            ? false
            : "No hotkey, child, or parent tie recorded for this account."
      }
      footnote={
        !nearViewport
          ? "hotkey, child and parent relationships · live chain"
          : loading
            ? "Loading live key relationships"
            : unavailable
              ? "Related keys unavailable · live chain"
              : items.length > 0
                ? `${formatNumber(rows.length)} related keys · live chain`
                : "No hotkey, child, or parent tie recorded for this account"
      }
    />
  );
}
