import { useNavigate, useSearch } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { SectionLabel, Skeleton } from "@jsonbored/ui-kit";
import { AsyncPanel, Panel } from "@/components/metagraphed/primitives";
import { ApiSourceFooter } from "@/components/metagraphed/api-source-footer";
import { EmissionNetworkSummary } from "@/components/metagraphed/emission-network-summary";
import {
  EmissionPipelineTable,
  type EmissionTableSearch,
} from "@/components/metagraphed/emission-pipeline-table";
import { measuredFields } from "@/lib/metagraphed/emission-pipeline";
import { emissionPipelineQuery } from "@/lib/metagraphed/queries";
import type { EmissionPipeline } from "@/lib/metagraphed/types";

/**
 * /chain/emissions (#8745) — the v440 emission-pipeline decomposition.
 *
 * One request serves the whole page: the payload is ~130 rows and the
 * aggregate is network-wide, so filtering and sorting happen client-side
 * against the single pinned sample rather than re-fetching per view.
 */
function EmissionsBody() {
  // The route's zod schema and EmissionTableSearch describe the same five
  // fields; the assertion is only bridging the router's inferred literal
  // types onto the table's exported interface, which the schema in
  // chain.emissions.tsx keeps in step.
  const search = useSearch({ from: "/chain/emissions" }) as EmissionTableSearch;
  const navigate = useNavigate({ from: "/chain/emissions" });
  const { data: res } = useSuspenseQuery(emissionPipelineQuery());
  const pipeline = res.data;

  const setSearch = (patch: Partial<EmissionTableSearch>) =>
    navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...patch }) as never,
      resetScroll: false,
    });

  return (
    <>
      <VerificationNotice pipeline={pipeline} />

      <EmissionNetworkSummary pipeline={pipeline} />

      <div id="emissions-subnets" className="mt-6">
        <SectionLabel as="h2">Per-subnet decomposition</SectionLabel>
        <p className="mt-1 mb-3 max-w-3xl mg-type-caption text-ink-muted">
          Read a row left to right and it is the pipeline itself: the published price share, then
          the miner-burn reweighting, then the gate, then the share of block emission the subnet
          actually receives — followed by how that TAO arrives.
        </p>
        <EmissionPipelineTable subnets={pipeline.subnets} search={search} setSearch={setSearch} />
      </div>

      <Provenance pipeline={pipeline} />
    </>
  );
}

/**
 * `verification.verified: false` means the reconstruction did not reproduce
 * the chain. The API is explicit that such a response "is not defensible and
 * must not be presented as fact", so the page says so at the top rather than
 * rendering the numbers as if nothing were wrong.
 */
function VerificationNotice({ pipeline }: { pipeline: EmissionPipeline }) {
  if (pipeline.verification.verified) return null;
  const failed = pipeline.verification.checks.filter((check) => !check.ok);
  return (
    <Panel as="section" tone="warn" className="mb-4">
      <h2 className="mg-type-label text-ink-strong">These figures did not reproduce the chain</h2>
      <p className="mt-1 text-sm text-ink">
        Every share below is reconstructed from chain storage, and this capture&apos;s identity
        checks did not pass. Treat the numbers as unverified — do not cite them.
      </p>
      {failed.length > 0 ? (
        <ul className="mt-2 space-y-1 mg-type-caption text-ink-muted">
          {failed.map((check) => (
            <li key={check.name}>
              <code className="mg-type-data">{check.name}</code>
              {check.detail ? ` — ${check.detail}` : null}
            </li>
          ))}
        </ul>
      ) : null}
    </Panel>
  );
}

/** What was read from the chain versus derived — the issue's "every figure is
 * traceable to its block height" requirement, made explicit rather than left
 * for a reader to assume. */
function Provenance({ pipeline }: { pipeline: EmissionPipeline }) {
  const measured = measuredFields(pipeline);
  const passed = pipeline.verification.checks.filter((check) => check.ok);
  return (
    <Panel as="section" className="mt-6">
      <SectionLabel as="h2">How these numbers were produced</SectionLabel>
      <p className="mt-2 max-w-3xl text-sm text-ink">
        The chain publishes the pipeline&apos;s inputs, not its output, so most fields here are
        reconstructed rather than read.{" "}
        {measured.length > 0 ? (
          <>
            Read directly from chain storage:{" "}
            {measured.map((field, index) => (
              <span key={field}>
                {index > 0 ? ", " : ""}
                <code className="mg-type-data">{field}</code>
              </span>
            ))}
            . Everything else is derived from those.
          </>
        ) : (
          <>This capture carries no per-field provenance.</>
        )}
      </p>
      {passed.length > 0 ? (
        <>
          <h3 className="mt-3 mg-type-label text-ink-muted">Identities checked on this response</h3>
          <ul className="mt-1 space-y-1 mg-type-caption text-ink-muted">
            {passed.map((check) => (
              <li key={check.name}>
                <code className="mg-type-data">{check.name}</code>
                {check.detail ? ` — ${check.detail}` : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Panel>
  );
}

export function ChainEmissionsPage() {
  return (
    <>
      <p className="mb-6 max-w-3xl mg-type-caption-lg text-ink-muted">
        A subnet&apos;s published emission share is a price signal, not a payout. What it actually
        receives is decided in stages — reweighted by miner burn, then passed through a gate that
        moves share between subnets — and the TAO that results arrives through two channels. This
        page is that pipeline, stage by stage. Nothing is withheld along the way: every subnet below
        competes for a share of block emission that is released in full.
      </p>

      <AsyncPanel context="emission pipeline" fallback={<EmissionsSkeleton />}>
        <EmissionsBody />
      </AsyncPanel>

      <ApiSourceFooter paths={["/api/v1/chain/emission-pipeline"]} />
    </>
  );
}

function EmissionsSkeleton() {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
        <Skeleton className="h-20" />
      </div>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Skeleton className="h-48" />
        <Skeleton className="h-48" />
      </div>
      <Skeleton className="h-96 w-full" />
    </div>
  );
}
