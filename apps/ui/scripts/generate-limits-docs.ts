// Generates content/docs/limits.mdx from the rate-limit configs that actually
// enforce (#8610). The issue's acceptance line is "every enforced limit on the
// page matches tier config as code", and the only way to mean that is to
// GENERATE the page from the configs rather than to write numbers down beside
// them -- a hand-maintained pricing table is wrong the first time a ceiling
// moves, and wrong in the direction that matters, since a caller plans against
// what the page says.
//
// It reads the five live `*_TIERED_RATE_LIMIT` objects directly, not a parallel
// registry describing them. tests/api-tiers.test.ts already binds those objects
// to the Cloudflare bindings in wrangler.jsonc, so the chain runs
// page -> config -> binding with nothing restating anything.
//
// Committed generated output, same convention as content/docs/catalog.mdx
// (scripts/generate-catalog-docs.ts) -- re-run after a ceiling changes:
//
//   node scripts/generate-limits-docs.ts
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import prettier from "prettier";
import { API_TIERS, TIER_DAILY_UNITS, TIER_RATE_MULTIPLIER } from "../../../src/api-tiers.ts";
import { AI_TIERED_RATE_LIMIT } from "../../../src/ai-search.ts";
import { MCP_TIERED_RATE_LIMIT } from "../../../src/mcp-server.ts";
import {
  DATA_TIERED_RATE_LIMIT,
  WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
} from "../../../workers/api.ts";
import { STATE_QUERY_TIERED_RATE_LIMIT } from "../../../workers/request-handlers/rpc-proxy.ts";
import type { TieredRateLimitConfig } from "../../../workers/tiered-rate-limit.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = path.join(__dirname, "../content/docs/limits.mdx");

/**
 * The tiered surfaces, in the order a reader meets them.
 *
 * `config` is the real object the Worker rate-limits against; only the prose
 * label and the "what it is" column are written here, because those are the
 * parts no config can supply.
 */
const SURFACES: { label: string; what: string; config: TieredRateLimitConfig }[] = [
  {
    label: "REST API",
    what: "Everything under `/api/v1` — registry, chain, and analytics reads.",
    config: DATA_TIERED_RATE_LIMIT,
  },
  {
    label: "MCP server",
    what: "Tool calls from an agent connected to the MCP endpoint.",
    config: MCP_TIERED_RATE_LIMIT,
  },
  {
    label: "AI search",
    what: "`/api/v1/ask` and semantic search — LLM-backed, so the ceiling is lower.",
    config: AI_TIERED_RATE_LIMIT,
  },
  {
    label: "State queries",
    what: "Live chain reads proxied to an RPC node.",
    config: STATE_QUERY_TIERED_RATE_LIMIT,
  },
  {
    label: "Webhook subscriptions",
    what: "Creating and managing webhook subscriptions.",
    config: WEBHOOK_SUBSCRIPTION_TIERED_RATE_LIMIT,
  },
];

function frontmatter(): string {
  return [
    "---",
    "title: Limits and access",
    "description: Per-minute ceilings for every surface, the daily unit budget, what each tier gets, and how to move up one. Generated from the rate-limit config that enforces them.",
    "---",
    "",
    "",
  ].join("\n");
}

/** `1,500` — thousands separated, so a five-digit ceiling is readable at a glance. */
function num(value: number): string {
  return value.toLocaleString("en-US");
}

function perMinuteTable(): string {
  const header = [
    "| Surface | What it covers | No key | Free | Community | Paid |",
    "| ------- | -------------- | -----: | ---: | --------: | ---: |",
  ];
  const rows = SURFACES.map((surface) => {
    const cells = API_TIERS.map((tier) => num(surface.config.tiers[tier].limit));
    return `| **${surface.label}** | ${surface.what} | ${num(surface.config.anonymous.limit)} | ${cells.join(" | ")} |`;
  });
  return [...header, ...rows].join("\n");
}

function multiplierLine(): string {
  return API_TIERS.map((tier) => `\`${tier}\` is ${TIER_RATE_MULTIPLIER[tier]}×`).join(", ");
}

function dailyTable(): string {
  const header = ["| Tier | Daily budget |", "| ---- | -----------: |"];
  const rows = API_TIERS.map((tier) => {
    const units = TIER_DAILY_UNITS[tier];
    return `| \`${tier}\` | ${units === undefined ? "uncapped" : `${num(units)} units`} |`;
  });
  return [...header, ...rows].join("\n");
}

function body(): string {
  return `All numbers on this page are generated from the configuration that enforces them. If a ceiling here disagrees with what you observe, that is a bug — please [open an issue](https://github.com/JSONbored/metagraphed/issues/new).

Most of the API needs no key at all. A key raises your per-minute ceiling; a tier above \`free\` raises it further.

## Per-minute ceilings

Requests per minute, per surface. Each surface has its own burst profile — an LLM-backed \`/ask\` cannot absorb what a cached artifact read can — so the ceilings differ by surface, not just by tier.

${perMinuteTable()}

The tier columns are multiples of the keyed ceiling: ${multiplierLine()}. \`free\` is deliberately 1× — every key issued today is on \`free\`, and introducing tiers must not retroactively tighten anyone.

## Daily budget

The per-minute ceiling bounds bursts. The daily budget bounds volume, and unlike the per-minute limit it is **per account, shared across every surface** — one budget covering everything you do, rather than a separate allowance per surface that could be exhausted five separate times.

It counts *cost units*, not requests: a cached artifact read costs less than an LLM-backed call. The budget resets at UTC midnight.

${dailyTable()}

\`free\` is uncapped daily on purpose, for the same reason its multiplier is 1×: a daily quota is a paid-model control, not a new restriction on people who already hold a key. The per-minute ceiling still applies.

## Moving up a tier

- **Free** — issue yourself a key. No application, no review.
- **Community** — for people actively contributing to the registry: surface submissions that land, subnet enrichment, fixes. Ask in an issue or a PR you already have open; it is granted against a contribution record, not an application form.
- **Paid** — [open an issue](https://github.com/JSONbored/metagraphed/issues/new) describing your workload and we will work out what you need.

## When you hit a limit

A rejected request returns **429** with headers describing what you hit:

| Header | Meaning |
| ------ | ------- |
| \`x-ratelimit-limit\` | The ceiling you hit |
| \`x-ratelimit-remaining\` | Always \`0\` on a 429 — the limit was reached, by definition |
| \`x-ratelimit-reset\` | When capacity returns |
| \`x-ratelimit-policy\` | The limit and its window, as \`limit;w=seconds\` |
| \`x-ratelimit-scope\` | \`daily-quota\` if you exhausted the day's budget, otherwise the per-minute limiter |
| \`x-ratelimit-tier\` | The tier the limit was applied at |
| \`retry-after\` | Seconds to wait |

Two things worth knowing about the values:

- On a **per-minute** rejection, \`x-ratelimit-reset\` is an upper bound — now plus the window — not the exact window boundary. Cloudflare's rate-limiting primitive returns only allowed/blocked, so there is no exact reset instant to report. We would rather say so than fabricate precision.
- On a **daily-quota** rejection, \`x-ratelimit-reset\` is exact: the next UTC midnight. Check \`x-ratelimit-scope\` before deciding how long to back off — retrying in 60 seconds against an exhausted daily budget will simply fail again.

## Keys

Keep a key out of client-side code and out of version control — anything shipped to a browser is public. If a key is exposed, issue a new one and revoke the old one; revocation takes effect immediately. Rotating on a schedule is reasonable, and rotating on exposure is not optional.
`;
}

async function main() {
  const raw = `${frontmatter()}${body()}`;
  const formatted = await prettier.format(raw, { parser: "mdx" });
  await writeFile(OUTPUT_PATH, formatted, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), OUTPUT_PATH)}`);
}

await main();
