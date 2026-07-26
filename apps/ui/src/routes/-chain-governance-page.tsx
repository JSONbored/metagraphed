import { useNavigate, useSearch } from "@tanstack/react-router";
import {
  ActionBar,
  DownloadCsvButton,
  ShareButton,
  Skeleton,
  TableSkeleton,
} from "@jsonbored/ui-kit";
import { AsyncPanel } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { buildUrl } from "@/lib/metagraphed/client";
import { classNames } from "@/lib/metagraphed/format";
import { ChainTabActions } from "./-chain-hub";
import { SudoKeyCard, SudoTable, sudoQueryParams } from "./-sudo-index-page";
import {
  AdminChangesTable,
  NetworkParametersCard,
  adminChangesQueryParams,
} from "./-admin-changes-index-page";

/**
 * Governance tab — /sudo and /admin-changes merged (#8291, part of #8244).
 *
 * These were two separate top-level routes rendering near-identical tables
 * (same columns, same filters, byte-identical search schemas) over two
 * different root-origin sources. Subtensor has no Council or Senate, so Sudo
 * plus AdminUtils IS the whole governance surface — it belongs on one page
 * with a source toggle, not two pages a visitor has to know to compare.
 *
 * The toggle lives in the URL (`?view=`) so a link to either half is
 * shareable and the browser back button steps between them.
 */
type GovernanceView = "sudo" | "admin";

const VIEWS: ReadonlyArray<{ id: GovernanceView; label: string; blurb: string }> = [
  {
    id: "sudo",
    label: "Sudo",
    blurb:
      "Root-origin (Sudo) calls. Subtensor has no Council or Senate, so Sudo is the whole root-origin surface, plus the account currently holding the key.",
  },
  {
    id: "admin",
    label: "Admin changes",
    blurb:
      "AdminUtils config changes — subtensor's own admin pallet for subnet hyperparameters and network-wide config, newest first.",
  },
];

export function ChainGovernancePage() {
  const search = useSearch({ from: "/chain/governance" });
  const navigate = useNavigate({ from: "/chain/governance" });
  const view: GovernanceView = search.view === "admin" ? "admin" : "sudo";

  const csvUrl =
    view === "sudo"
      ? buildUrl("/api/v1/sudo", sudoQueryParams(search))
      : buildUrl("/api/v1/governance/config-changes", adminChangesQueryParams(search));

  const setView = (next: GovernanceView) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, view: next }) as never,
      resetScroll: false,
    });

  const active = VIEWS.find((v) => v.id === view)!;

  return (
    <>
      <ChainTabActions>
        <div
          role="tablist"
          aria-label="Governance source"
          className="mr-auto inline-flex items-center gap-1 rounded-md border border-border bg-surface p-0.5"
        >
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              role="tab"
              aria-selected={v.id === view}
              onClick={() => setView(v.id)}
              className={classNames(
                "rounded px-2.5 py-1 mg-type-caption font-medium transition-colors mg-focus-ring",
                v.id === view ? "bg-card text-ink-strong" : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
        <ActionBar>
          <DownloadCsvButton url={csvUrl} bare />
          <ShareButton bare />
        </ActionBar>
      </ChainTabActions>

      <p className="mb-6 max-w-3xl mg-type-caption-lg text-ink-muted">{active.blurb}</p>

      {view === "admin" ? (
        <>
          {/* #6997: the change log is a history of config-change events and
              never showed the CURRENT live values those changes move. Own
              AsyncPanel so a slow RPC read never blocks the artifact-backed
              table below. */}
          <AsyncPanel
            context="network parameters"
            fallback={
              <div className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
                <Skeleton className="h-20" />
              </div>
            }
          >
            <NetworkParametersCard />
          </AsyncPanel>
          <div className="min-w-0">
            <AsyncPanel context="admin changes" fallback={<TableSkeleton rows={10} columns={6} />}>
              <AdminChangesTable />
            </AsyncPanel>
          </div>
        </>
      ) : (
        <>
          {/* Was a masthead KPI on the old /sudo page. Kept, not dropped: it is
              the one piece of live state here, and the call log is meaningless
              without knowing who currently holds the key. */}
          <SudoKeyCard />
          <div className="min-w-0">
            <AsyncPanel context="sudo calls" fallback={<Skeleton className="h-96 w-full" />}>
              <SudoTable />
            </AsyncPanel>
          </div>
        </>
      )}

      <ApiSourceFooter
        paths={
          view === "sudo"
            ? ["/api/v1/sudo", "/api/v1/sudo/key"]
            : ["/api/v1/governance/config-changes", "/api/v1/network/parameters"]
        }
        artifacts={
          view === "sudo" ? ["/metagraph/sudo.json"] : ["/metagraph/governance/config-changes.json"]
        }
      />
    </>
  );
}
