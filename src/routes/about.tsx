import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/metagraphed/app-shell";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { ExternalLink } from "@/components/metagraphed/external-link";
import { PageHeading } from "@/components/metagraphed/states";
import { API_BASE, GITHUB_REPO } from "@/lib/metagraphed/config";

export const Route = createFileRoute("/about")({
  head: () => ({
    meta: [
      { title: "About — Metagraphed" },
      { name: "description", content: "Methodology, scope boundaries, and contribution model for the Metagraphed Bittensor registry." },
    ],
  }),
  component: AboutPage,
});

function AboutPage() {
  return (
    <AppShell>
      <PageHeading
        eyebrow="About"
        title="Methodology & scope"
        description="Metagraphed extends the native Bittensor metagraph with public interface and health metadata. Unofficial — not a block explorer."
      />
      <div className="prose prose-sm max-w-3xl text-ink space-y-6">
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">What this is</h2>
          <p className="text-sm leading-relaxed">
            A builder-facing public registry and explorer for Bittensor subnets: APIs, OpenAPI schemas, docs, repos, dashboards,
            data artifacts, SSE streams, endpoint health, schema drift, freshness, source evidence, providers, and curation gaps.
            Inspired by Cosmos Directory and adapted for the heterogeneous, app-layer shape of Bittensor subnets.
          </p>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">What this is not</h2>
          <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
            <li>Not a block explorer, wallet app, validator dashboard, or operator console.</li>
            <li>Not an OpenTensor/Bittensor product. Unofficial registry only.</li>
            <li>No private keys, PATs, or token-gated data are ever requested or displayed.</li>
            <li>Endpoint pool eligibility is metadata only — proxy routing is future-scoped.</li>
          </ul>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">Curation levels</h2>
          <ul className="text-sm leading-relaxed list-disc pl-5 space-y-1">
            <li><b>Native</b> — sourced directly from the Bittensor chain.</li>
            <li><b>Candidate-discovered</b> — leads from public sources, not verified.</li>
            <li><b>Machine-verified</b> — reachable and shape-checked by automated probes.</li>
            <li><b>Maintainer-reviewed</b> — a human reviewer accepted the overlay.</li>
            <li><b>Adapter-backed</b> — a typed adapter publishes live metrics (e.g. SN7, SN74).</li>
          </ul>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">Contributing</h2>
          <p className="text-sm leading-relaxed">
            Corrections, new candidate leads, and maintainer review happen through the public repo. There is no in-app submission flow.
          </p>
          <div className="mt-2 text-xs">
            <ExternalLink href={GITHUB_REPO}>{GITHUB_REPO}</ExternalLink>
          </div>
        </section>
        <section>
          <h2 className="font-display text-sm font-semibold uppercase tracking-wider text-ink-strong">API & artifacts</h2>
          <div className="space-y-2">
            <CopyableCode label="api" value={`${API_BASE}/api/v1`} truncate={false} className="w-full" />
            <CopyableCode label="openapi" value={`${API_BASE}/api/v1/openapi.json`} truncate={false} className="w-full" />
            <CopyableCode label="artifacts" value={`${API_BASE}/metagraph/`} truncate={false} className="w-full" />
          </div>
        </section>
      </div>
    </AppShell>
  );
}
