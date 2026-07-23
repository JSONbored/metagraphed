// Advisory (report-only) check: does a subnet's curation.gap_notes still claim a
// surface kind is missing when surfaces[] already carries a first-party surface
// of that kind? Community-submitted-surface PRs add a surface but have no reason
// to also touch the unrelated curation.gap_notes array, so notes drift stale.
//
// This never fails the process — it is a hygiene report for a human to act on
// (edit or drop the note), not a registry validity check. `npm run
// validate:surface` stays the pass/fail gate for surface data; this is a
// separate advisory script so a stale note never blocks a contributor PR.
//
//   npm run curation:stale-notes
//   npm run curation:stale-notes -- --json
import path from "node:path";
import { pathToFileURL } from "node:url";
import { listJsonFiles, loadProviders, readJson, repoRoot } from "./lib.ts";

// Keyword → surface kind, checked in this order against a gap_notes entry that
// already matches the "No verified ... yet" shape. Order only matters where a
// note could plausibly contain more than one keyword; the observed corpus
// (issue #5738) has no such overlap, but "openapi" is checked ahead of the
// generic "docs" match since some notes read "... OpenAPI/Swagger surface".
const KIND_KEYWORDS = [
  { kind: "sse", pattern: /\bsse\b|event stream/i },
  { kind: "openapi", pattern: /openapi|swagger/i },
  { kind: "subnet-api", pattern: /subnet api/i },
  { kind: "data-artifact", pattern: /data artifact/i },
  { kind: "source-repo", pattern: /source repository/i },
  { kind: "docs", pattern: /docs (url|site)|documentation/i },
  { kind: "dashboard", pattern: /dashboard/i },
  { kind: "website", pattern: /website/i },
];

// A gap_notes entry only describes a still-missing surface when it reads "No
// verified <thing> yet" — other note shapes (404 observations, identity
// disputes, auth-boundary explanations) are not "not yet found" claims and are
// left alone.
export function classifyGapNote(note) {
  if (typeof note !== "string" || !note.startsWith("No verified")) {
    return null;
  }
  if (!/\byet\b/i.test(note)) {
    return null;
  }
  for (const { kind, pattern } of KIND_KEYWORDS) {
    if (pattern.test(note)) return kind;
  }
  return null;
}

// A surface only contradicts a gap note if it is the subnet's OWN first-party
// surface. A third-party aggregator's wrapper around a subnet's data (e.g.
// TaoMarketCap's generic per-subnet API) is not the same claim as "the subnet
// publishes its own API" — see registry/subnets/oneoneone.json (#5738).
export function isFirstPartySurface(surface, providersById) {
  const provider = providersById.get(surface.provider);
  return provider?.kind === "subnet-team";
}

// Returns the stale gap_notes entries for a single subnet document, or [] if
// none of its notes are contradicted by its own surfaces[].
export function findStaleGapNotes(document, providersById) {
  const notes = document.curation?.gap_notes || [];
  const surfaces = document.surfaces || [];
  const stale = [];
  for (const note of notes) {
    const kind = classifyGapNote(note);
    if (!kind) continue;
    const contradicting = surfaces.find(
      (surface) =>
        surface.kind === kind && isFirstPartySurface(surface, providersById),
    );
    if (contradicting) {
      stale.push({ note, kind, surface_id: contradicting.id });
    }
  }
  return stale;
}

export async function collectStaleGapNotes() {
  const providersById = new Map(
    (await loadProviders()).map((provider) => [provider.id, provider]),
  );
  const files = await listJsonFiles(path.join(repoRoot, "registry/subnets"));
  const subnets = [];
  for (const file of files) {
    const document = await readJson(file);
    const stale = findStaleGapNotes(document, providersById);
    if (stale.length > 0) {
      subnets.push({
        slug: document.slug,
        netuid: document.netuid,
        name: document.name,
        file: path.basename(file),
        stale_notes: stale,
      });
    }
  }
  const staleNoteCount = subnets.reduce(
    (sum, subnet) => sum + subnet.stale_notes.length,
    0,
  );
  return {
    subnet_count: subnets.length,
    stale_note_count: staleNoteCount,
    subnets,
  };
}

function renderReport(report) {
  if (report.subnets.length === 0) {
    return "No stale curation.gap_notes found.\n";
  }
  const lines = [
    `Stale curation.gap_notes: ${report.stale_note_count} across ${report.subnet_count} subnet file(s).`,
    "This is an advisory report — it does not fail CI. Edit or drop each stale note by hand.",
    "",
  ];
  for (const subnet of report.subnets) {
    lines.push(`SN${subnet.netuid} ${subnet.name} (${subnet.file})`);
    for (const entry of subnet.stale_notes) {
      lines.push(
        `  - [${entry.kind}] "${entry.note}" — contradicted by surface "${entry.surface_id}"`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

if (isCliEntrypoint()) {
  const report = await collectStaleGapNotes();
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderReport(report));
  }
}

function isCliEntrypoint() {
  return process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false;
}
