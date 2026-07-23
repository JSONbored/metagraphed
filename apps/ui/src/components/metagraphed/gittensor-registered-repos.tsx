import { useQuery } from "@tanstack/react-query";
import { BrandIcon } from "@jsonbored/ui-kit";
import { adapterQuery } from "@/lib/metagraphed/queries";

// Gittensor-specific extra (netuid 74 only — see subnets.$netuid.tsx's gate).
// Compact, capped preview of Gittensor's registered repositories, not folded
// into ResourceExplorer's surfaces list: these are ecosystem member projects
// with emission-share/maintainer-cut metadata, not infrastructure endpoints,
// so mixing them into the surfaces grid would muddy both concepts and (at
// 19 entries) flood the page. Mirrors leaderboards.tsx's BoardCard pattern
// for visual consistency — same compact ranked-row shape, same
// self-contained "hide on error/empty" discovery-extra behavior — and reuses
// its already-live /api/v1/adapters/:slug data (dimensions.master_repositories,
// refreshed by scripts/snapshot-adapters.mjs's snapshotGittensor()) rather
// than inventing a new endpoint.

const ROWS_SHOWN = 6;

interface MasterRepoRow {
  repository: string;
  emission_share?: number;
  issue_discovery_share?: number;
  maintainer_cut?: number;
}

interface GittensorMasterRepositories {
  top_emission_repositories?: MasterRepoRow[];
  repository_count?: number;
}

export function GittensorRegisteredRepos({ slug }: { slug: string }) {
  const { data: res, isError } = useQuery(adapterQuery(slug));
  // The adapter envelope nests the actual snapshot (and its `dimensions`) one
  // level deeper than AdapterSnapshot's loose typing suggests: `data.snapshot
  // .dimensions`, not `data.dimensions` -- verified directly against the real
  // /api/v1/adapters/gittensor response, not assumed from the registry file's
  // own on-disk shape (which is what `data.snapshot` mirrors).
  const dimensions = (res?.data as { snapshot?: { dimensions?: unknown } })?.snapshot
    ?.dimensions as { master_repositories?: GittensorMasterRepositories } | undefined;
  const master = dimensions?.master_repositories;
  const rows = (master?.top_emission_repositories ?? []).slice(0, ROWS_SHOWN);

  // Discovery extra — never break the subnet page. Hide entirely on error or
  // until there's at least one row to show (matches leaderboards.tsx).
  if (isError || rows.length === 0) return null;

  const total = master?.repository_count;

  return (
    <div id="registered-repos" className="rounded-xl border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="mg-type-micro text-ink-muted">Registered repositories</span>
        {total ? (
          <span className="shrink-0 font-mono text-[10px] text-ink-muted tabular-nums">
            {total} total
          </span>
        ) : null}
      </div>
      <ol className="space-y-0.5">
        {rows.map((row, i) => {
          const repoUrl = `https://github.com/${row.repository}`;
          const sharePct = typeof row.emission_share === "number" ? row.emission_share * 100 : null;
          return (
            <li key={row.repository}>
              <a
                href={repoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mg-row-hover flex items-center justify-between gap-2 rounded-md px-2 py-1.5"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <span className="w-4 shrink-0 text-right font-mono text-[10px] text-ink-muted tabular-nums">
                    {i + 1}
                  </span>
                  <BrandIcon size={18} name={row.repository} repoUrl={repoUrl} fallback={i + 1} />
                  <span className="truncate text-sm text-ink-strong">{row.repository}</span>
                </span>
                <span className="shrink-0 font-mono text-[12px] tabular-nums text-ink-muted">
                  {sharePct !== null ? `${sharePct.toFixed(1)}%` : "—"}
                </span>
              </a>
            </li>
          );
        })}
      </ol>
      {total && total > rows.length ? (
        <a
          href="https://gittensor.io/repositories"
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2 block text-center text-xs text-accent hover:underline"
        >
          View all {total} registered repositories →
        </a>
      ) : null}
    </div>
  );
}
