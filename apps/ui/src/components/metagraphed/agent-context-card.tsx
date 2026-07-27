import { useQuery } from "@tanstack/react-query";
import { Check, ClipboardCopy, Link2 } from "lucide-react";
import { ExternalLink, SectionLabel } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { Skeleton } from "@/components/metagraphed/states";
import { useCopy } from "@/hooks/use-copy";
import { agentMarkdownQuery } from "@/lib/metagraphed/agent-doc.functions";
import { classNames } from "@/lib/metagraphed/format";
import type { AgentResources } from "@/lib/metagraphed/types";

/**
 * The one filled call-to-action on the page. Everything else here is a
 * hairline/ghost control, which is what makes this one readable as "start
 * here" — see the accent-as-a-mark note in CONTRIBUTING.md's visual grammar.
 */
function CopyMarkdownCta({ markdown }: { markdown: string | undefined }) {
  const { copied, copy } = useCopy({ label: "agent prompt" });
  return (
    <button
      type="button"
      onClick={() => markdown && copy(markdown)}
      disabled={!markdown}
      className={classNames(
        "inline-flex shrink-0 items-center gap-2 rounded-md border border-accent bg-accent px-4 py-2",
        "mg-type-caption-lg font-medium text-paper transition-opacity",
        "hover:opacity-90 disabled:pointer-events-none disabled:opacity-50",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-paper",
      )}
    >
      {copied ? (
        <Check className="size-4 shrink-0" aria-hidden />
      ) : (
        <ClipboardCopy className="size-4 shrink-0" aria-hidden />
      )}
      {copied ? "Copied" : "Copy markdown"}
    </button>
  );
}

function CopyUrlButton({ url }: { url: string }) {
  const { copied, copy } = useCopy({ label: "agent prompt URL" });
  return (
    <button
      type="button"
      onClick={() => copy(url)}
      className={classNames(
        "inline-flex shrink-0 items-center gap-2 rounded-md border border-border bg-card px-4 py-2",
        "mg-type-caption-lg font-medium text-ink-strong transition-colors hover:border-accent/60",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
      )}
    >
      {copied ? (
        <Check className="size-4 shrink-0 text-health-ok" aria-hidden />
      ) : (
        <Link2 className="size-4 shrink-0 text-ink-muted" aria-hidden />
      )}
      {copied ? "Copied" : "Copy URL"}
    </button>
  );
}

/**
 * Step 1 of /agents: the paste-once context bundle, shown rather than linked.
 *
 * The page's whole promise is "hand this to an agent and it can use
 * metagraphed" — so the prompt's actual text is on screen, scrollable, next to
 * the button that copies it. A reader can audit what they are about to paste
 * into their own system prompt before they paste it, which a bare link to
 * agent.md never let them do.
 */
export function AgentContextCard({ agent }: { agent: AgentResources["copyable_agent"] }) {
  const { data: markdown, isPending, isError } = useQuery(agentMarkdownQuery());

  return (
    <Panel flush>
      <div className="flex flex-col gap-4 border-b border-border/70 p-4 md:flex-row md:items-start md:justify-between md:p-6">
        <div className="min-w-0 max-w-2xl">
          <SectionLabel>One-file context bundle</SectionLabel>
          <h3 className="mt-1 font-display text-base font-semibold text-ink-strong">
            Hand this to an agent and it can use metagraphed.
          </h3>
          <p className="mt-1 mg-type-caption-lg leading-relaxed text-ink-muted">
            {agent.description}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <CopyMarkdownCta markdown={markdown} />
          <CopyUrlButton url={agent.url} />
        </div>
      </div>

      <div className="p-4 md:p-6">
        {isPending ? (
          <Skeleton className="h-64 w-full" />
        ) : isError || !markdown ? (
          // The prompt is still fetchable by hand, so a failed preview must not
          // read as a broken page — point at the source and move on.
          <p className="mg-type-caption-lg text-ink-muted">
            Preview unavailable right now — read it at{" "}
            <ExternalLink href={agent.url} className="text-ink-strong">
              {agent.url.replace("https://", "")}
            </ExternalLink>
            .
          </p>
        ) : (
          <pre className="max-h-96 overflow-auto rounded border border-border bg-paper p-4 font-mono mg-type-data leading-relaxed text-ink">
            {markdown}
          </pre>
        )}
      </div>
    </Panel>
  );
}
