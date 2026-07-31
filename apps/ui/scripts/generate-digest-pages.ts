// Generates content/news/** from registry/generated/digests.json (#8705).
//
// STATIC, not fetched. Requirement 3 says digests are generated at build time
// and stored, never rendered per-request — and the point of the whole issue is
// search traffic, which wants real pages, not a client-side fetch. So a digest
// becomes an MDX page the same way content/docs/catalog.mdx and
// content/docs/limits.mdx already do, and a CI drift check keeps the pages and
// the store in agreement.
//
// The store is append-only (src/weekly-digest-store.ts), so a page this writes
// once will keep regenerating byte-identical forever. That is what makes the
// drift check meaningful rather than noisy.
//
// Committed generated output — re-run after the digest store changes:
//
//   node scripts/generate-digest-pages.ts
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { isoWeekStart } from "../../../src/weekly-digest-store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "../../..");
const STORE_PATH = path.join(REPO_ROOT, "registry/generated/digests.json");
const OUTPUT_DIR = path.join(__dirname, "../content/news");

interface DigestSentence {
  text: string;
  citations: string[];
}

interface DigestSource {
  id: string;
  url: string;
  title: string;
  summary: string;
  timestamp: string;
  tags: string[];
}

interface WeeklyDigest {
  netuid: number | null;
  year: number;
  week: number;
  slug: string;
  generated_at: string;
  sentences: DigestSentence[];
  sources: DigestSource[];
  substantive_count: number;
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** `sn8` / `network` — the URL segment and the directory name, one definition. */
function subjectSegment(netuid: number | null): string {
  return netuid === null ? "network" : `sn${netuid}`;
}

function subjectLabel(netuid: number | null): string {
  return netuid === null ? "The network" : `Subnet ${netuid}`;
}

/** `2026-W31` — the human form of the slug, uppercase W as ISO writes it. */
function weekLabel(digest: WeeklyDigest): string {
  return `${digest.year}-W${String(digest.week).padStart(2, "0")}`;
}

/** `28 July 2026` — UTC, spelled out, so no locale can change a published page. */
function formatDate(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isFinite(parsed.getTime())) return timestamp;
  return `${parsed.getUTCDate()} ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCFullYear()}`;
}

function escapeYaml(value: string): string {
  return value.replace(/"/g, '\\"');
}

/**
 * `20–26 July 2026` — the week the digest covers, in words.
 *
 * The dates come from isoWeekStart, the same function the store uses to decide
 * whether a week has ended, rather than from arithmetic repeated here. A page
 * whose stated span disagreed with the window its items were selected from
 * would be wrong in the one way a reader cannot check.
 */
function weekSpan(year: number, week: number): string {
  const start = isoWeekStart(year, week);
  const end = new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000);
  const startDay = `${start.getUTCDate()}`;
  const endDay = `${end.getUTCDate()}`;
  const startMonth = MONTHS[start.getUTCMonth()];
  const endMonth = MONTHS[end.getUTCMonth()];
  const endYear = end.getUTCFullYear();
  // Only repeat the month when the week straddles one, and the year when it
  // straddles a year boundary.
  if (start.getUTCFullYear() !== endYear) {
    return `${startDay} ${startMonth} ${start.getUTCFullYear()} – ${endDay} ${endMonth} ${endYear}`;
  }
  if (startMonth !== endMonth) {
    return `${startDay} ${startMonth} – ${endDay} ${endMonth} ${endYear}`;
  }
  return `${startDay}–${endDay} ${startMonth} ${endYear}`;
}

/**
 * One digest page.
 *
 * The sources section is not decoration — requirement 5 makes it the thing that
 * lets a reader audit every claim in one click, so it lists every cited item
 * with its own link and date, and the count in the heading is the real length
 * of that list rather than a number written beside it.
 */
function digestPage(digest: WeeklyDigest): string {
  const label = subjectLabel(digest.netuid);
  const week = weekLabel(digest);
  const title = `${label} — ${week}`;
  const span = weekSpan(digest.year, digest.week);

  // NOT the body sentences. Fumadocs renders `description` as the page's
  // subtitle directly above the body, so reusing the prose printed the same
  // sentence twice on every page. This says what the page IS; the body says
  // what happened.
  const description = `What changed for ${label.toLowerCase()} during ${week} (${span}), with every claim linked to the item behind it.`;

  const body = digest.sentences.map((sentence) => sentence.text).join("\n\n");

  const sources = digest.sources
    .map(
      (source) =>
        `- [${source.title || source.id}](${source.url}) — ${formatDate(source.timestamp)}`,
    )
    .join("\n");

  // A subnet digest links back to the subnet it is about. Without it the page
  // is a dead end — a reader who arrives from search has nowhere to go for the
  // context the digest deliberately does not restate.
  const backlink =
    digest.netuid === null
      ? "[Browse all subnets](/subnets)"
      : `[Subnet ${digest.netuid} overview](/subnets/${digest.netuid})`;

  return [
    "---",
    `title: "${escapeYaml(title)}"`,
    `description: "${escapeYaml(description)}"`,
    "---",
    "",
    `**${span}**`,
    "",
    `${body}`,
    "",
    `## Generated from ${digest.sources.length} source${digest.sources.length === 1 ? "" : "s"}`,
    "",
    "Every sentence above is derived by counting and dating these items. Nothing else went into this page.",
    "",
    sources,
    "",
    "---",
    "",
    `${backlink} · [All weekly digests](/news)`,
    "",
  ].join("\n");
}

/**
 * The archive index.
 *
 * Requirement 4 asks for archive pages that paginate rather than duplicate.
 * With the current volume one page is the honest answer — pagination over a
 * handful of entries would be structure without content. The grouping below is
 * what pagination would split on when it is needed.
 */
function indexPage(digests: WeeklyDigest[]): string {
  const bySubject = new Map<string, WeeklyDigest[]>();
  for (const digest of digests) {
    const segment = subjectSegment(digest.netuid);
    const bucket = bySubject.get(segment);
    if (bucket) bucket.push(digest);
    else bySubject.set(segment, [digest]);
  }

  const sections = [...bySubject.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([segment, entries]) => {
      const sorted = [...entries].sort((a, b) => b.slug.localeCompare(a.slug));
      const label = subjectLabel(sorted[0].netuid);
      const links = sorted
        .map(
          (digest) =>
            `- [${weekLabel(digest)}](/news/${segment}/${digest.slug}) — ${digest.sources.length} source${digest.sources.length === 1 ? "" : "s"}`,
        )
        .join("\n");
      return `### ${label}\n\n${links}`;
    })
    .join("\n\n");

  const empty =
    "No digests have been published yet. A week is only written up once it has ended and carries enough substantive activity to be worth reading.";

  return [
    "---",
    'title: "Weekly digests"',
    'description: "What changed, week by week, for each Bittensor subnet and for the network — written only from our own primary-source feed items, with every claim linked to the item behind it."',
    "---",
    "",
    "Each digest covers one ISO week and is written only from this registry's own feed items — registry changes, chain governance activity, incidents, and subnet repo releases. Every sentence cites the items it rests on, and each page lists them in full.",
    "",
    "A week is published only after it has ended, and only when it carried enough substantive activity to be worth reading. Quiet weeks get no page rather than a thin one. A published digest is never rewritten.",
    "",
    digests.length === 0 ? empty : sections,
    "",
  ].join("\n");
}

async function main() {
  const raw = await readFile(STORE_PATH, "utf8").catch(() => null);
  const store = raw ? (JSON.parse(raw) as { digests?: WeeklyDigest[] }) : { digests: [] };
  const digests = Array.isArray(store.digests) ? store.digests : [];

  // Rebuilt from scratch: a digest removed from the store (a retraction) must
  // not leave an orphaned page behind, which an incremental write would.
  await rm(OUTPUT_DIR, { recursive: true, force: true });
  await mkdir(OUTPUT_DIR, { recursive: true });

  const format = (source: string) => prettier.format(source, { parser: "mdx" });

  await writeFile(path.join(OUTPUT_DIR, "index.mdx"), await format(indexPage(digests)), "utf8");

  for (const digest of digests) {
    const dir = path.join(OUTPUT_DIR, subjectSegment(digest.netuid));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${digest.slug}.mdx`), await format(digestPage(digest)), "utf8");
  }

  console.log(`Wrote ${digests.length + 1} page(s) to ${path.relative(process.cwd(), OUTPUT_DIR)}`);
}

await main();
