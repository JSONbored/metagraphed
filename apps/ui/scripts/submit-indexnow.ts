// Submits changed URLs to IndexNow (Bing, Yandex, Seznam, Naver share one
// endpoint), so a new docs page or a newly registered subnet is crawled in
// hours rather than whenever the sitemap is next read.
//
//   node scripts/submit-indexnow.ts --changed <file-with-paths>   # a push
//   node scripts/submit-indexnow.ts --sitemap                     # full, manual
//   node scripts/submit-indexnow.ts --sitemap --dry-run           # print only
//
// The change signal is the git diff of a push to main, NOT the registry
// changelog: one publish reports ~2,837 modified artifacts because the
// 15-minute health probe rewrites nearly everything, and submitting unchanged
// URLs is what gets a host discounted. See lib/metagraphed/indexnow.ts.
//
// Most runs submit nothing. That is the intended behaviour — a quiet exit means
// the push changed no page content, not that the script failed.
import { readFileSync } from "node:fs";
import path from "node:path";

import { SITE_ORIGIN } from "../src/lib/metagraphed/identity.ts";
import {
  buildIndexNowPayload,
  INDEXNOW_ENDPOINT,
  urlsForChangedPaths,
} from "../src/lib/metagraphed/indexnow.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

function arg(name: string): string | null {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

/** The repository root, from this script's own location. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");

/**
 * A changed subnet file's netuid, read from the file itself.
 *
 * The file name is not the netuid and not the API slug: `apex.json` is slug
 * `sn-1` and page `/subnets/1`. Only the file's own `netuid` field ties the
 * three together, so that is what is read. A file that was deleted, or that
 * carries no netuid, resolves to null and is skipped.
 */
function netuidForSubnetFile(repoPath: string): number | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(REPO_ROOT, repoPath), "utf8")) as {
      netuid?: unknown;
    };
    return typeof raw.netuid === "number" && Number.isInteger(raw.netuid) ? raw.netuid : null;
  } catch {
    return null;
  }
}

async function sitemapUrls(): Promise<string[]> {
  const response = await fetch(`${SITE_ORIGIN}/sitemap.xml`);
  if (!response.ok) throw new Error(`sitemap.xml answered ${response.status}`);
  const xml = await response.text();
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1]!);
}

async function main(): Promise<void> {
  const key = process.env.INDEXNOW_KEY?.trim();
  if (!key) {
    // The key is public, but it still has to MATCH the committed key file, so
    // it is passed in rather than guessed from the filesystem.
    console.error("INDEXNOW_KEY is not set — nothing submitted.");
    process.exit(1);
  }

  let urls: string[];
  const changedFile = arg("--changed");
  if (changedFile) {
    const paths = readFileSync(changedFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    urls = urlsForChangedPaths(paths, SITE_ORIGIN, netuidForSubnetFile);
    console.log(`${paths.length} changed paths -> ${urls.length} public URLs`);
  } else if (args.includes("--sitemap")) {
    urls = await sitemapUrls();
    console.log(`sitemap -> ${urls.length} URLs`);
  } else {
    console.error("usage: submit-indexnow.ts (--changed <file> | --sitemap) [--dry-run]");
    process.exit(2);
    return;
  }

  const payload = buildIndexNowPayload(urls, SITE_ORIGIN, key);
  if (!payload) {
    console.log("No submittable URLs — nothing to do.");
    return;
  }

  console.log(`submitting ${payload.urlList.length} URLs for ${payload.host}`);
  for (const url of payload.urlList.slice(0, 20)) console.log(`  ${url}`);
  if (payload.urlList.length > 20) console.log(`  … ${payload.urlList.length - 20} more`);

  if (dryRun) {
    console.log("--dry-run: not submitted.");
    return;
  }

  const response = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload),
  });
  // 200 accepted, 202 accepted-pending-key-validation. Anything else is a real
  // failure and must fail the job rather than being logged and forgotten --
  // a submitter that cannot fail is not a submitter.
  if (response.status !== 200 && response.status !== 202) {
    console.error(`IndexNow answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    process.exit(1);
  }
  console.log(`IndexNow accepted the submission (${response.status}).`);
}

await main();
