#!/usr/bin/env node
// Adapter data-quality guard (beta-roadmap Finding 1 — belt-and-suspenders).
//
// An adapter snapshot can silently degrade when GitHub auth breaks or rate
// limits hit: dimensions fall back to unauthenticated HTML scraping and lose
// their machine-readable metadata (captured_count -> 0, html_fallback_count up,
// status -> "html-fallback", error -> "Bad credentials" / 401). Publishing or
// committing that degraded data poisons the completeness/provenance story.
//
// This guard inspects every committed adapter and rejects degradation. It runs
// STRICT (exit 1) in production / auth-required contexts so a broken token
// fails the publish loudly; otherwise it WARNS (exit 0) so a locally-degraded
// snapshot doesn't block ordinary PR validation.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

const ADAPTER_DIR = "registry/adapters/latest";

// Returns a list of human-readable degradation issues for one adapter snapshot
// (empty when the adapter is healthy). Exported for unit testing.
export function inspectAdapter(adapter: Row): string[] {
  const issues: string[] = [];
  const dimensions: Row =
    adapter && adapter.dimensions && typeof adapter.dimensions === "object"
      ? (adapter.dimensions as Row)
      : {};

  for (const [name, dimValue] of Object.entries(dimensions)) {
    if (!dimValue || typeof dimValue !== "object") continue;
    const dim = dimValue as Row;

    // Broken GitHub auth surfaced on the dimension.
    if (
      dim.status_code === 401 ||
      /bad credentials/i.test(String(dim.error ?? "")) ||
      /bad credentials/i.test(String(dim.fallback_reason ?? ""))
    ) {
      issues.push(
        `${name}: auth failure (status_code=${dim.status_code ?? "?"}, error=${dim.error ?? "?"})`,
      );
    }

    // Dimension itself fell back to HTML scraping (no machine-readable capture).
    if (dim.status === "html-fallback") {
      issues.push(`${name}: status=html-fallback`);
    }

    // Repository metadata degraded to all-HTML-fallback: nothing captured via
    // the API, everything scraped from HTML.
    if (
      typeof dim.captured_count === "number" &&
      typeof dim.html_fallback_count === "number" &&
      dim.captured_count === 0 &&
      dim.html_fallback_count > 0
    ) {
      issues.push(
        `${name}: captured_count=0 with html_fallback_count=${dim.html_fallback_count} (all HTML-fallback)`,
      );
    }
  }

  return issues;
}

function main(): number {
  const strict =
    process.env.METAGRAPH_REQUIRE_ADAPTER_AUTH === "1" ||
    process.env.METAGRAPH_PRODUCTION_BUILD === "1";

  let files: string[];
  try {
    files = readdirSync(ADAPTER_DIR).filter((f) => f.endsWith(".json"));
  } catch {
    console.log(
      `validate:adapters — no adapter directory at ${ADAPTER_DIR}; nothing to check.`,
    );
    return 0;
  }

  const degraded: { slug: string; issues: string[] }[] = [];
  for (const file of files) {
    const slug = file.replace(/\.json$/, "");
    let adapter: Row;
    try {
      adapter = JSON.parse(readFileSync(join(ADAPTER_DIR, file), "utf8"));
    } catch (error) {
      degraded.push({
        slug,
        issues: [`unreadable: ${(error as Error).message}`],
      });
      continue;
    }
    const issues = inspectAdapter(adapter);
    if (issues.length) degraded.push({ slug, issues });
  }

  if (!degraded.length) {
    console.log(
      `validate:adapters — ${files.length} adapter(s) OK; no auth / HTML-fallback degradation.`,
    );
    return 0;
  }

  const label = strict ? "ERROR" : "WARNING";
  console.error(
    `validate:adapters — ${degraded.length} of ${files.length} adapter(s) degraded (${label}):`,
  );
  for (const { slug, issues } of degraded) {
    console.error(`  • ${slug}`);
    for (const issue of issues) console.error(`      - ${issue}`);
  }

  if (strict) {
    console.error(
      "\nStrict mode (METAGRAPH_PRODUCTION_BUILD / METAGRAPH_REQUIRE_ADAPTER_AUTH set): " +
        "refusing to publish degraded adapter data. Re-snapshot with a valid GITHUB_TOKEN.",
    );
    return 1;
  }
  console.error(
    "\nNon-strict mode: warning only. Re-run `npm run adapters:snapshot` with a valid " +
      "GITHUB_TOKEN to capture full metadata before publishing.",
  );
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
