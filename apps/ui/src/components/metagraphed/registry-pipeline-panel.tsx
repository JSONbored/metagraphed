import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { registryPipelineQuery, fixtureQuery } from "@/lib/metagraphed/queries";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton, ErrorState } from "@/components/metagraphed/states";
import { formatNumber, formatRelative } from "@/lib/metagraphed/format";

const SOURCES_SHOWN = 8;

/**
 * The registry's own intake pipeline (#10300).
 *
 * `/api/v1/candidates`, `/api/v1/curation`, `/api/v1/profiles` and
 * `/api/v1/source-snapshots` were all published and rendered nowhere. #10300
 * listed them as "plausibly API-only... but it should be a recorded decision,
 * because right now 'no page exists' and 'no page should exist' are
 * indistinguishable from the outside".
 *
 * This is that decision, made the other way. They are the four stages of how a
 * surface gets into this registry -- discovered, curated, profiled, and the
 * snapshot of what each source actually said -- and the ops console is where
 * someone asks where intake has stalled.
 *
 * EACH STAGE REPORTS WHETHER IT WAS REACHABLE. A stage that could not be read
 * renders as unknown, never as zero: "no candidates" and "the candidates route
 * is down" are opposite findings, and a pipeline view that showed both as 0
 * would be worse than no view at all.
 */
export function RegistryPipelinePanel() {
  const { data, isLoading, isError, error, refetch } = useQuery(registryPipelineQuery());

  if (isLoading) return <Skeleton className="h-[220px] w-full" />;
  if (isError) return <ErrorState error={error} onRetry={() => void refetch()} />;

  const p = data?.data;
  if (!p) return <Skeleton className="h-[220px] w-full" />;

  return (
    <div className="space-y-6">
      <Panel as="section" dense>
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Stage
            label="candidates"
            reachable={p.candidates_reachable}
            value={formatNumber(p.candidate_count)}
            hint="Discovered surfaces awaiting verification."
          />
          <Stage
            label="superseded"
            reachable={p.candidates_reachable}
            value={formatNumber(p.superseded_count)}
            hint="Candidates replaced by a better source. NOT rejections — a supersede is the pipeline working, so it is counted apart from failures."
          />
          <Stage
            label="curated subnets"
            reachable={p.curation_reachable}
            value={formatNumber(p.curated_subnet_count)}
            hint="Subnets with a curation record. `coverage_level` (how much we have) and `curation_level` (how much a human vouched for) are two different ladders."
          />
          <Stage
            label="profiles"
            reachable={p.profiles_reachable}
            value={formatNumber(p.profile_count)}
            hint="Subnets with a built profile."
          />
        </div>
        <p className="mt-3 mg-type-label text-ink-muted">
          {formatNumber(p.gap_total)} open interface gaps across the curated subnets.
        </p>
      </Panel>

      <Panel as="section" dense>
        <h3 className="mb-3 mg-type-label text-ink-muted">Source snapshots</h3>
        {p.snapshots_reachable ? (
          <>
            <p className="mb-3 mg-type-data-sm text-ink-muted">
              {formatNumber(p.source_count)} source
              {p.source_count === 1 ? "" : "s"}
              {p.verification_result_count == null
                ? ""
                : ` · ${formatNumber(p.verification_result_count)} verification results`}
              {p.generated_at ? ` · generated ${formatRelative(p.generated_at)}` : ""}
            </p>
            <ul className="space-y-1">
              {p.sources.slice(0, SOURCES_SHOWN).map((s) => (
                <li key={s.id} className="flex gap-3 mg-type-data-sm">
                  <span className="min-w-0 flex-1 truncate text-ink">{s.id}</span>
                  <span className="shrink-0 tabular-nums text-ink-muted">
                    {formatNumber(s.record_count)} rows
                  </span>
                  {/* The hash, not just the date. Two captures with the same
                      hash saw the same bytes -- a timestamp cannot tell you
                      whether a re-capture actually changed anything. */}
                  <span
                    className="shrink-0 mg-type-label text-ink-muted"
                    title={s.hash ? `Content hash ${s.hash}` : "No content hash recorded."}
                  >
                    {s.hash ? s.hash.slice(0, 7) : "—"}
                  </span>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="mg-type-data-sm text-ink-muted">
            The source-snapshot route could not be read — this is unknown, not empty.
          </p>
        )}
      </Panel>
    </div>
  );
}

/**
 * One pipeline stage.
 *
 * An unreachable stage renders an em-dash and says so, rather than 0. The
 * distinction is the whole point of the panel: a stage with nothing in it and a
 * stage we could not read are opposite findings.
 */
function Stage({
  label,
  reachable,
  value,
  hint,
}: {
  label: string;
  reachable: boolean;
  value: string;
  hint: string;
}) {
  return (
    <div title={reachable ? hint : `${hint} (This stage could not be read — unknown, not zero.)`}>
      <div className="mg-type-label text-ink-muted">{label}</div>
      <div className="mg-type-data tabular-nums text-ink">{reachable ? value : "—"}</div>
      {!reachable ? <div className="mg-type-label text-ink-muted">unreadable</div> : null}
    </div>
  );
}

/**
 * `/api/v1/fixtures/{surface_id}` (#10300), published and rendered nowhere.
 *
 * Look up whether a surface has a captured fixture. AN ABSENT FIXTURE IS AN
 * ANSWER: the route 404s on a surface it never captured, and rendering that as
 * an error would make "we have not captured this yet" indistinguishable from
 * "the API is broken" — the same confusion #10222 fixed for lane health.
 */
export function FixtureLookupPanel() {
  const [input, setInput] = useState("");
  const [surfaceId, setSurfaceId] = useState<string | null>(null);
  const { data, isLoading, isError, error, refetch } = useQuery({
    ...fixtureQuery(surfaceId ?? ""),
    enabled: surfaceId !== null && surfaceId !== "",
  });

  return (
    <Panel as="section" dense>
      <h3 className="mb-3 mg-type-label text-ink-muted">Fixture lookup</h3>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setSurfaceId(input.trim());
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="surface id, e.g. allways-api-health"
          aria-label="Surface id"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1 mg-type-data-sm text-ink"
        />
        <button
          type="submit"
          className="rounded border border-border bg-card px-3 py-1 mg-type-caption font-medium text-ink-strong hover:border-accent/40"
        >
          Look up
        </button>
      </form>

      {surfaceId ? (
        isLoading ? (
          <Skeleton className="mt-3 h-12 w-full" />
        ) : isError ? (
          <ErrorState error={error} onRetry={() => void refetch()} />
        ) : data?.data.available ? (
          <p className="mt-3 mg-type-data-sm text-ink">
            Captured{data.data.captured_at ? ` ${formatRelative(data.data.captured_at)}` : ""}
            {data.data.response_status == null
              ? ""
              : ` · responded ${formatNumber(data.data.response_status)}`}
          </p>
        ) : (
          <p className="mt-3 mg-type-data-sm text-ink-muted">{data?.data.reason}</p>
        )
      ) : null}
    </Panel>
  );
}
