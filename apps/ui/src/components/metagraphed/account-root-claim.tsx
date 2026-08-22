import { useQuery } from "@tanstack/react-query";
import { accountRootClaimQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";

/**
 * `/api/v1/accounts/{ss58}/root-claim` (#10300), published and rendered
 * nowhere.
 *
 * What this account's root stake would do in a swap, and which hotkeys it
 * reaches. The panel exists because of one thing the payload says about
 * itself:
 *
 * `field_sources` MARKS THE HOTKEY LIST AS RECONSTRUCTED, not measured. The
 * claim type is read from chain storage; the hotkey list is inferred. Rendering
 * them the same way would present an inference with the authority of a reading,
 * which is the whole failure mode `field_sources` exists to prevent -- so the
 * provenance is shown next to the thing it qualifies, not buried in a footer.
 */
export function AccountRootClaim({ ss58 }: { ss58: string }) {
  const { data, isLoading, isError, error, refetch } = useQuery(accountRootClaimQuery(ss58));

  if (isLoading) return <Skeleton className="h-[90px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const c = data?.data;
  // No root claim is a real answer for most accounts, not a gap — rendered as
  // a plain statement rather than an error or an empty-state alarm.
  if (!c || !c.claim_kind) {
    return (
      <Panel as="section">
        <p className="text-10 text-ink-muted">This account has no root-claim state recorded.</p>
      </Panel>
    );
  }

  return (
    <Panel as="section">
      <div className="grid grid-cols-2 gap-x-6 gap-y-3">
        <div>
          <div className="text-11 text-ink-muted">claim type</div>
          <div className="text-11 text-ink" title="Read from SubtensorModule.RootClaimType.">
            {c.claim_kind}
          </div>
        </div>
        <div>
          <div className="text-11 text-ink-muted">hotkeys reached</div>
          <div className="text-11 tabular-nums text-ink">{formatNumber(c.hotkeys.length)}</div>
        </div>
      </div>

      {/* The provenance sits beside the figure it qualifies. A reconstructed
          list is inferred from other state, not read from it. */}
      {c.hotkeys_source && c.hotkeys_source !== "measured" ? (
        <p className="mt-3 text-11 text-ink-muted">
          The hotkey list is <strong>{c.hotkeys_source}</strong> — inferred from other state rather
          than read from chain storage, unlike the claim type above.
        </p>
      ) : null}

      {c.queried_at ? (
        <p className="mt-2 text-11 text-ink-muted">Read {formatRelative(c.queried_at)}.</p>
      ) : null}
    </Panel>
  );
}
