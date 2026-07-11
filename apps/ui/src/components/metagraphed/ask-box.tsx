import { useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { ApiError } from "@/lib/metagraphed/client";
import { askQuestion } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { ExternalLink } from "@jsonbored/ui-kit";
import type { AskAnswerData, AskCitation } from "@/lib/metagraphed/types";

/** Distinguishes a 429 (rate-limited) and 503 (AI disabled/unavailable) ask rejection from a generic failure. */
export function describeAskError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Rate-limited — try again shortly.";
    if (error.status === 503) return error.message || "AI is temporarily unavailable.";
    return error.message || "Couldn't get an answer — try again.";
  }
  return "Couldn't get an answer — try again.";
}

/** Relevance score (0-1 per the ask-answer schema) as a rounded percentage; "—" for a non-finite/out-of-range value. */
export function formatScore(score: number): string {
  return Number.isFinite(score) && score >= 0 && score <= 1 ? `${Math.round(score * 100)}%` : "—";
}

/** A citation's display title, falling back to its 1-based ref when the registry has no title. */
export function citationLabel(citation: AskCitation): string {
  return citation.title ?? `Citation ${citation.ref}`;
}

/** The netuid + score meta string next to a citation, omitting the netuid segment when it's null. */
export function citationMeta(citation: AskCitation): string {
  const netuidPrefix = citation.netuid != null ? `SN${citation.netuid} · ` : "";
  return `${netuidPrefix}${formatScore(citation.score)}`;
}

function CitationRow({ citation }: { citation: AskCitation }) {
  return (
    <li className="flex items-center justify-between gap-3 px-3 py-2">
      <ExternalLink href={citation.url ?? ""} className="min-w-0 text-[12px]">
        {citationLabel(citation)}
      </ExternalLink>
      <span className="shrink-0 font-mono text-[10px] text-ink-muted">
        {citationMeta(citation)}
      </span>
    </li>
  );
}

/** "N source(s) · model" meta line, singular/plural correct at exactly 1. */
export function sourceCountLabel(contextCount: number, model: string): string {
  return `${contextCount} source${contextCount === 1 ? "" : "s"} · ${model}`;
}

function AskResult({ result }: { result: AskAnswerData }) {
  return (
    <div className="mt-4 space-y-3 rounded-lg border border-accent/30 bg-accent-surface p-4">
      <p className="text-[13px] leading-relaxed text-ink-strong">{result.answer}</p>
      {result.citations.length > 0 ? (
        <ul className="divide-y divide-border rounded border border-border bg-card">
          {result.citations.map((c: AskCitation) => (
            <CitationRow key={c.ref} citation={c} />
          ))}
        </ul>
      ) : null}
      <p className="font-mono text-[10px] text-ink-muted">
        {sourceCountLabel(result.context_count, result.model)}
      </p>
    </div>
  );
}

export function AskBox() {
  const [question, setQuestion] = useState("");
  const mutation = useMutation({
    mutationFn: (q: string) => askQuestion(q),
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = question.trim();
    if (!trimmed) return;
    mutation.mutate(trimmed);
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <label className="flex-1">
          <span className="sr-only">Ask a question about Bittensor subnets</span>
          <textarea
            rows={2}
            required
            placeholder="Which subnet does image generation?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            className="w-full resize-none rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30"
          />
        </label>
        <button
          type="submit"
          disabled={mutation.isPending || !question.trim()}
          className={classNames(
            "shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-[13px] font-medium text-accent hover:bg-accent/15",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {mutation.isPending ? "Asking…" : "Ask"}
        </button>
      </form>

      {mutation.isError ? (
        <p role="alert" className="mt-3 font-mono text-[12px] text-health-warn">
          {describeAskError(mutation.error)}
        </p>
      ) : null}

      {mutation.data ? <AskResult result={mutation.data} /> : null}
    </div>
  );
}
