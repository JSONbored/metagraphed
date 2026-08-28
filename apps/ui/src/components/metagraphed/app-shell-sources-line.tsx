import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "@jsonbored/ui-kit";
import { useHydrated } from "@/hooks/use-hydrated";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";
import { freshnessQuery } from "@/lib/metagraphed/queries";

/** `sources N · stale N · openapi` -- the one liveness line in the chrome. */
export default function SourcesLine() {
  const hydrated = useHydrated();
  const freshness = useQuery({ ...freshnessQuery(), retry: 0, enabled: hydrated });
  const f = hydrated ? freshness.data?.data : undefined;
  // This line intentionally waits until the footer is near the viewport. A
  // missing reading at that point is still unknown, not a clean zero — zero
  // stale sources and zero registered sources are both meaningful claims.
  const loading = !hydrated || freshness.isPending;
  const unavailable = freshness.isError;
  const stale = f?.stale_count;
  const sources = f?.sources?.length;
  const value = (reading: number | undefined) => (loading || unavailable ? "—" : (reading ?? "—"));
  return (
    <span
      aria-busy={loading || undefined}
      aria-live="polite"
      title={unavailable ? "Freshness data is temporarily unavailable" : undefined}
    >
      <span>
        sources <span className="text-ink-strong">{value(sources)}</span>
      </span>
      <span aria-hidden="true">·</span>
      <span>
        stale{" "}
        <span className={classNames(stale ? "text-health-warn" : "text-ink-strong")}>
          {value(stale)}
        </span>
      </span>
      <span aria-hidden="true">·</span>
      <ExternalLink
        bare
        href={`${API_BASE}/api/v1/openapi.json`}
        className="hover:text-ink-strong transition-colors"
      >
        openapi
      </ExternalLink>
      {loading ? <span className="sr-only">Freshness data is loading.</span> : null}
      {unavailable ? <span className="sr-only">Freshness data is unavailable.</span> : null}
    </span>
  );
}
