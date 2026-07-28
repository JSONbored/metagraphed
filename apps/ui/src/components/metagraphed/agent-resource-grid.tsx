import {
  Bot,
  Terminal,
  FileCode2,
  Database,
  BookOpen,
  Sparkles,
  Boxes,
  Package,
} from "lucide-react";
import { CopyButton, ExternalLink } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { classNames } from "@/lib/metagraphed/format";
import type { AgentResource } from "@/lib/metagraphed/types";

const KIND_META = {
  agent: { icon: Bot, tone: "text-accent" },
  skill: { icon: Sparkles, tone: "text-accent" },
  index: { icon: BookOpen, tone: "text-ink-muted" },
  guide: { icon: BookOpen, tone: "text-ink-muted" },
  contract: { icon: FileCode2, tone: "text-ink-muted" },
  api: { icon: Boxes, tone: "text-ink-muted" },
  data: { icon: Database, tone: "text-ink-muted" },
} satisfies Record<string, { icon: typeof Bot; tone: string }>;

function kindMeta(kind: string) {
  return Object.hasOwn(KIND_META, kind) ? KIND_META[kind as keyof typeof KIND_META] : KIND_META.api;
}

// One-line reason a given resource is worth reaching for, keyed by its
// stable `id` from /api/v1/agent-resources. Resources without an entry here
// (a future addition to the index) still render, just without the second
// line — never blocked on this map staying exhaustive.
const RESOURCE_HINT: Record<string, string> = {
  "agent-workflows": "Copyable REST/npm/Python/MCP call examples, one per workflow.",
  llms: "The llms.txt convention — a directory of every doc page as plain links.",
  "llms-full": "The full corpus concatenated into one file, for agents that ingest in bulk.",
  openapi: "Every route, typed. Point any OpenAPI codegen at it for a typed client.",
  "agent-catalog": "Every callable service in the registry, in one paginated list.",
  "coverage-depth": "How complete each subnet's registry entry is, scored.",
  "semantic-search": "Vector search over subnets and surfaces — the REST form of Search above.",
  ask: "Grounded Q&A with citations — the REST form of Ask above.",
  graphql: "Shaped queries over the registry instead of stitching multiple REST calls.",
  fixtures: "Real request/response pairs captured live, for writing tests against.",
  lineage: "Cross-network lineage — which mainnet subnet a testnet one mirrors.",
  datasets: "The whole registry as flat CSV, for a notebook or a spreadsheet.",
};

const ICON_BY_ID: Partial<Record<string, typeof Package>> = {
  "agent-catalog": Terminal,
};

/**
 * Step 4 of /agents: everything that isn't the context bundle, an MCP/SDK/
 * skill install, or the live query card — llms.txt, the OpenAPI contract,
 * GraphQL, fixtures, lineage, bulk CSV. Allways calls its equivalent
 * "Deeper integrations" and keeps it to three quiet cards because it only has
 * three more things to say; metagraphed's registry surfaces far more, so this
 * is a denser grid rather than a stretched-thin single row, with a one-line
 * reason per card instead of the flat 13-row link table it replaces.
 */
export function AgentResourceGrid({ resources }: { resources: AgentResource[] }) {
  // Step 1 (agent.md) and step 2 (the skill install) already surface those
  // two resources with far more context than a grid card could — listing
  // them again here would be the exact redundancy Allways avoids by only
  // putting the context bundle in step 1.
  const rest = resources.filter((r) => r.kind !== "agent" && r.kind !== "skill");

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {rest.map((r) => {
        const meta = kindMeta(r.kind);
        const Icon = ICON_BY_ID[r.id] ?? meta.icon;
        return (
          <Panel key={r.id} flush className="min-w-0">
            <div className="flex items-start gap-3 p-4">
              <Icon className={classNames("mt-0.5 size-4 shrink-0", meta.tone)} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="mg-type-caption-lg font-medium text-ink-strong">{r.title}</p>
                {RESOURCE_HINT[r.id] ? (
                  <p className="mt-0.5 mg-type-caption text-ink-muted">{RESOURCE_HINT[r.id]}</p>
                ) : null}
                <ExternalLink
                  href={r.url}
                  className="mt-1.5 inline-flex mg-type-data text-ink-muted hover:text-ink-strong"
                >
                  {r.url.replace("https://api.metagraph.sh", "")}
                </ExternalLink>
              </div>
              <CopyButton value={r.url} label={`${r.title} URL`} compact />
            </div>
          </Panel>
        );
      })}
    </div>
  );
}
