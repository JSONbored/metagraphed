import { Check, FileText } from "lucide-react";
import { useCopy } from "@/hooks/use-copy";
import { classNames } from "@/lib/metagraphed/format";

/**
 * Copies a doc page's clean-markdown export (fumadocs-mdx's remarkLLMs
 * `_markdown`, wired in source.config.ts) -- the same content an LLM/agent
 * would want, without the rendered page's JSX/React shell.
 */
export function CopyMarkdownButton({ markdown }: { markdown: string | undefined }) {
  const { copied, copy } = useCopy({ label: "page as Markdown" });

  return (
    <button
      type="button"
      onClick={() => markdown && copy(markdown)}
      disabled={!markdown}
      className={classNames(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded border border-border bg-card px-2.5 py-1.5 text-[12px] text-ink-muted",
        "hover:text-ink-strong hover:border-ink/30 transition-colors disabled:opacity-50 disabled:pointer-events-none",
      )}
    >
      {copied ? (
        <Check className="size-3.5 shrink-0 text-health-ok" aria-hidden="true" />
      ) : (
        <FileText className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      {copied ? "Copied" : "Copy as Markdown"}
    </button>
  );
}
