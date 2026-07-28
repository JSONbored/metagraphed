import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { Panel } from "@/components/metagraphed/primitives";

interface Playbook {
  slug: string;
  title: string;
  hint: string;
}

// #8383: the four playbooks in content/docs/playbooks/ — static here because
// the set only changes when a new playbook is authored (a docs PR), not at
// runtime, unlike AgentResourceGrid's API-driven cards.
const PLAYBOOKS: Playbook[] = [
  {
    slug: "evaluate-a-subnet-before-staking",
    title: "Evaluate a subnet before staking",
    hint: "Health, economics, and stake concentration before staking into it.",
  },
  {
    slug: "monitor-my-validator",
    title: "Monitor my validator",
    hint: "Current standing, 30-day trend, and who's staking to it.",
  },
  {
    slug: "find-a-subnet-for-my-app",
    title: "Find a subnet for my app",
    hint: "A plain-language task to a callable subnet's base URL.",
  },
  {
    slug: "audit-an-account-history",
    title: "Audit an account's history",
    hint: "Reconstruct what one SS58 address has actually done on-chain.",
  },
];

/**
 * Step 5 of /agents: task-oriented recipes, each an executed-and-transcripted
 * doc under content/docs/playbooks/ AND a parameterized MCP prompt template —
 * this grid is the docs-side half of that cross-link.
 */
export function AgentPlaybookGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {PLAYBOOKS.map((p) => (
        <Panel key={p.slug} interactive flush className="relative min-w-0">
          <div className="flex items-start gap-3 p-4">
            <div className="min-w-0 flex-1">
              {/* `before:absolute before:inset-0` stretches the link's hit
                  area to the whole card (Panel itself can't be `as={Link}` —
                  its props aren't typed against the router's `to`/`params`). */}
              <Link
                to="/docs/$"
                params={{ _splat: `playbooks/${p.slug}` }}
                className="mg-type-caption-lg font-medium text-ink-strong before:absolute before:inset-0"
              >
                {p.title}
              </Link>
              <p className="mt-0.5 mg-type-caption text-ink-muted">{p.hint}</p>
            </div>
            <ArrowRight aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-muted" />
          </div>
        </Panel>
      ))}
    </div>
  );
}
