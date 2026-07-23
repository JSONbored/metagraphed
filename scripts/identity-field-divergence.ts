// Advisory (report-only) check: does a subnet's top-level identity field
// (`website_url` / `dashboard_url`) diverge from its own same-kind surface? The
// build (scripts/build-artifacts.mjs) resolves a profile's primary links as
// `subnet.<field> || firstSurfaceUrl(surfaces, kind)`, so a stale/generic
// top-level value (e.g. a third-party TaoMarketCap link) silently SHADOWS a
// more-specific curated surface of the same kind sitting in the same file
// (#6329). This flags that shadowing so the top-level field can be reconciled
// with — or nulled to defer to — the curated surface.
//
// This never fails the process — it is a hygiene report for a human to act on,
// not a registry validity check. `npm run validate:surface` stays the pass/fail
// gate for surface data; this is a separate advisory script so a divergent
// identity field never blocks a contributor PR.
//
//   npm run curation:identity-divergence
//   npm run curation:identity-divergence -- --json
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listJsonFiles, loadProviders, readJson, repoRoot } from "./lib.mjs";
import { isFirstPartySurface } from "./stale-gap-notes.mjs";

type Row = Record<string, unknown>;

// Top-level identity fields and the surface kind each falls back to, mirroring
// the `primaryLinks` resolution in build-artifacts.mjs
// (`subnet.<field> || firstSurfaceUrl(surfaces, kind)`).
const IDENTITY_FIELDS: { field: string; kind: string }[] = [
  { field: "website_url", kind: "website" },
  { field: "dashboard_url", kind: "dashboard" },
];

interface DivergentField {
  field: string;
  kind: string;
  top_level_url: unknown;
  surface_id: unknown;
  surface_url: unknown;
}

// Returns the divergent identity fields for a single subnet document, or [] if
// none. A field diverges when it is set (a falsy/absent field already defers to
// the surface fallback) AND the file has a first-party same-kind surface AND
// the top-level URL differs from it — i.e. the served profile shows something
// other than the subnet's own curated link (#6329). Only the subnet's OWN
// first-party surface is the "curated link" the served profile should prefer —
// a third-party aggregator's same-kind surface (e.g. TaoMarketCap's generic
// per-subnet dashboard) is not, and is sometimes deliberately retained as a
// directory entry (see tensorclaw.json), so comparing against it would
// false-positive. Same reasoning as stale-gap-notes' isFirstPartySurface.
export function findDivergentIdentityFields(
  document: Row,
  providersById: Map<unknown, Row>,
): DivergentField[] {
  const surfaces = (document.surfaces as Row[] | undefined) || [];
  const findings: DivergentField[] = [];
  for (const { field, kind } of IDENTITY_FIELDS) {
    const topLevel = document[field];
    if (!topLevel) continue;
    const surface = surfaces.find(
      (candidate) =>
        candidate.kind === kind &&
        isFirstPartySurface(candidate, providersById),
    );
    if (!surface) continue;
    if (surface.url !== topLevel) {
      findings.push({
        field,
        kind,
        top_level_url: topLevel,
        surface_id: surface.id,
        surface_url: surface.url,
      });
    }
  }
  return findings;
}

interface SubnetDivergence {
  slug: unknown;
  netuid: unknown;
  name: unknown;
  file: string;
  findings: DivergentField[];
}

interface DivergenceReport {
  subnet_count: number;
  finding_count: number;
  subnets: SubnetDivergence[];
}

export async function collectDivergentIdentityFields(): Promise<DivergenceReport> {
  const providersById = new Map(
    (await loadProviders()).map((provider: Row) => [provider.id, provider]),
  );
  const files: string[] = await listJsonFiles(
    path.join(repoRoot, "registry/subnets"),
  );
  const subnets: SubnetDivergence[] = [];
  for (const file of files) {
    const document: Row = await readJson(file);
    const findings = findDivergentIdentityFields(document, providersById);
    if (findings.length > 0) {
      subnets.push({
        slug: document.slug,
        netuid: document.netuid,
        name: document.name,
        file: path.basename(file),
        findings,
      });
    }
  }
  const findingCount = subnets.reduce(
    (sum, subnet) => sum + subnet.findings.length,
    0,
  );
  return {
    subnet_count: subnets.length,
    finding_count: findingCount,
    subnets,
  };
}

function renderReport(report: DivergenceReport): string {
  if (report.subnets.length === 0) {
    return "No divergent identity fields found.\n";
  }
  const lines = [
    `Divergent identity fields: ${report.finding_count} across ${report.subnet_count} subnet file(s).`,
    "This is an advisory report — it does not fail CI. Reconcile each top-level field with its curated surface, or null it to defer to the surface.",
    "",
  ];
  for (const subnet of report.subnets) {
    lines.push(`SN${subnet.netuid} ${subnet.name} (${subnet.file})`);
    for (const entry of subnet.findings) {
      lines.push(
        `  - ${entry.field}="${entry.top_level_url}" shadows surface "${entry.surface_id}" (${entry.surface_url})`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

if (isCliEntrypoint()) {
  const report = await collectDivergentIdentityFields();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }
}

function isCliEntrypoint(): boolean {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}
