// enrichment-issues: generate "Enrich SN<n>" contributor tasks from the LIVE
// enrichment queue (issue #427), deduped against the open issues already on the
// tracker. This is the scalable home for the gittensor-farmer work surface —
// pull the live gaps, never hardcode (mirrors the #427 epic + CONTRIBUTING).
//
//   node scripts/enrichment-issues.mjs --dry-run            # default: print plan
//   node scripts/enrichment-issues.mjs --write --limit 20   # create up to 20
//   node scripts/enrichment-issues.mjs --kinds openapi,subnet-api --limit 15
//
// --write shells out to `gh issue create` (needs gh auth). Each issue mirrors
// the established format: title "Enrich SN<n> <name> — add <kinds>", body links
// the surface:add command + CONTRIBUTING, labels gittensor:priority +
// good first issue + help wanted, and references the #427 tracker.
import { execFileSync } from "node:child_process";

const args = new Set(process.argv.slice(2));
const write = args.has("--write");
const dryRun = !write;
const getOpt = (name, fallback) => {
  const hit = [...args].find((a) => a.startsWith(`${name}=`));
  if (hit) return hit.slice(name.length + 1);
  const idx = process.argv.indexOf(name);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};

const API_BASE =
  process.env.METAGRAPH_LIVE_BASE_URL || "https://api.metagraph.sh";
const TRACKER = 427;
const LABELS = ["gittensor:priority", "good first issue", "help wanted"];
const LIMIT = Number(getOpt("--limit", "20"));
// Default to the operational gaps (the remaining volume); identity gaps
// (source-repo/website) are nearly exhausted by the existing tracker issues.
const KINDS = getOpt("--kinds", "openapi,subnet-api,data-artifact,sse")
  .split(",")
  .map((k) => k.trim())
  .filter(Boolean);

// Highest agent value first — a callable API + its spec beat artifacts/streams.
const VALUE_PRIORITY = [
  "subnet-api",
  "openapi",
  "data-artifact",
  "sse",
  "source-repo",
  "website",
  "docs",
  "sdk",
];

// Human phrasing + the surface:add --kind value for each gap kind.
const KIND_LABEL = {
  "source-repo": "source repository",
  website: "official website",
  docs: "documentation",
  openapi: "OpenAPI/Swagger spec",
  "subnet-api": "public API endpoint",
  "data-artifact": "public data artifact",
  sse: "SSE stream",
  sdk: "SDK",
};

function formatMarkdownValue(value) {
  const markdownCharacters = new Set("\\&<>{}[]()#*_`|.!+-");
  let safeValue = "";

  for (const char of String(value ?? "")) {
    const codePoint = char.codePointAt(0);
    if (char === "\r") {
      safeValue += "\\r";
    } else if (char === "\n") {
      safeValue += "\\n";
    } else if (char === "\t") {
      safeValue += "\\t";
    } else if (char === "@") {
      safeValue += "@\u200b";
    } else if (codePoint < 0x20 || codePoint === 0x7f) {
      safeValue += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    } else if (markdownCharacters.has(char)) {
      safeValue += `\\${char}`;
    } else {
      safeValue += char;
    }
  }

  return safeValue;
}

function formatTitleValue(value, { maxLength = 120 } = {}) {
  return formatMarkdownValue(value)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

async function fetchJson(path) {
  const res = await fetch(`${API_BASE}${path}`);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

// netuids that already have an open "Enrich SN<n>" issue — skip them so we never
// pile a second task on a subnet the tracker already covers.
function coveredNetuids() {
  try {
    const out = execFileSync(
      "gh",
      [
        "issue",
        "list",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "title",
        "-q",
        ".[].title",
      ],
      { encoding: "utf8" },
    );
    const covered = new Set();
    for (const title of out.split("\n")) {
      const m = /Enrich SN(\d+)\b/.exec(title);
      if (m) covered.add(Number(m[1]));
    }
    return covered;
  } catch (error) {
    console.warn(
      `warning: could not read open issues for dedup (${error.message}); proceeding WITHOUT dedup.`,
    );
    return new Set();
  }
}

function issueBody(netuid, name, kinds) {
  const kindList = kinds.map((k) => KIND_LABEL[k] || k).join(", ");
  const primary = kinds[0];
  return `Part of #${TRACKER}.

**Subnet ${netuid} — ${formatMarkdownValue(name)}** is missing from the registry: **${kindList}**. Research whether the subnet exposes ${kinds.length > 1 ? "these" : "this"}, find the real public link(s), and submit them.

### Find it
Search for the subnet's official ${kindList} (project site / GitHub / docs / Bittensor). Confirm each link is real, public, no-auth, and genuinely SN${netuid}'s — cross-reference the subnet name + Bittensor. ⚠️ Many subnets simply don't expose a public API yet, and on-chain identity links are often **stale/dead** — verify each link actually resolves before submitting. If the subnet genuinely exposes no such public surface, comment here so a maintainer can close it.

### Submit — one candidate per surface, one file
First find the provider slug for the team/operator behind the surface (a wrong slug is the #1 validation failure): \`npm run providers:list\`. Then generate one candidate file:
\`\`\`bash
npm run surface:add -- --netuid ${netuid} --kind ${primary} \\
  --url <real-public-url> --source-url <link-that-proves-it> \\
  --provider <slug> --submitted-by <your-login> --write
\`\`\`

Open a PR touching **exactly one** \`registry/candidates/community/*.json\` file — the review gate validates + reviews it.

**Rules:** a real \`url\` that resolves · a \`source_url\` that proves it's official · one file · no generated artifacts · \`public_safe: true\` · \`auth_required: false\`. Full guide: [CONTRIBUTING → Community submissions](https://github.com/JSONbored/metagraphed/blob/main/CONTRIBUTING.md#community-submissions).`;
}

const queue =
  (await fetchJson(`/api/v1/review/enrichment-queue?limit=128`)).data?.queue ||
  [];
const covered = coveredNetuids();

const planned = [];
for (const entry of queue) {
  if (planned.length >= LIMIT) break;
  const netuid = entry.netuid;
  if (covered.has(netuid)) continue;
  const missing = (entry.missing_kinds || [])
    .filter((k) => KINDS.includes(k))
    // Lead with the highest-value surface so the surface:add command targets
    // it: a callable API + its spec matter more to agents than artifacts/streams.
    .sort((a, b) => VALUE_PRIORITY.indexOf(a) - VALUE_PRIORITY.indexOf(b));
  if (!missing.length) continue;
  // One issue per subnet; ask for its top 2 in-scope missing kinds (the
  // surface:add command targets the first).
  const kinds = missing.slice(0, 2);
  planned.push({
    netuid,
    name: entry.name || `Subnet ${netuid}`,
    kinds,
    title:
      `Enrich SN${netuid} ${formatTitleValue(entry.name)}`.trim() +
      ` — add ${kinds.map((k) => KIND_LABEL[k] || k).join(" + ")}`,
  });
}

console.log(
  JSON.stringify(
    {
      mode: dryRun ? "dry-run" : "write",
      api_base: API_BASE,
      queue_size: queue.length,
      already_covered: covered.size,
      kinds_in_scope: KINDS,
      limit: LIMIT,
      planned_count: planned.length,
      planned: planned.map((p) => ({ netuid: p.netuid, title: p.title })),
    },
    null,
    2,
  ),
);

if (dryRun) {
  console.log(
    "\n(dry-run — no issues created. Re-run with --write to create them.)",
  );
} else {
  let created = 0;
  for (const p of planned) {
    const labelArgs = LABELS.flatMap((l) => ["--label", l]);
    try {
      const url = execFileSync(
        "gh",
        [
          "issue",
          "create",
          "--title",
          p.title,
          "--body",
          issueBody(p.netuid, p.name, p.kinds),
          ...labelArgs,
        ],
        { encoding: "utf8" },
      ).trim();
      created += 1;
      console.log(`created: ${url}`);
    } catch (error) {
      console.error(`failed SN${p.netuid}: ${error.message}`);
    }
  }
  console.log(`\nCreated ${created}/${planned.length} enrichment issues.`);
}
