import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@/lib/metagraphed/client";
import { semanticSearchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import type { SemanticSearchResult } from "@/lib/metagraphed/types";

const RESULT_LIMIT = 8;

/** Distinguishes a 429 (rate-limited) and 503 (AI disabled/unavailable) search rejection from a generic failure — same AI-endpoint family as ask-box's describeAskError. */
export function describeSearchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Rate-limited — try again shortly.";
    if (error.status === 503) return error.message || "AI is temporarily unavailable.";
    return error.message || "Couldn't search — try again.";
  }
  return "Couldn't search — try again.";
}

/** Relevance score (0-1) as a rounded percentage; "—" for a non-finite/out-of-range value. */
export function formatScore(score: number): string {
  return Number.isFinite(score) && score >= 0 && score <= 1 ? `${Math.round(score * 100)}%` : "—";
}

/** A result's display title, falling back to its subnet slug when the registry has no title. */
export function resultLabel(result: SemanticSearchResult): string {
  return result.title ?? result.slug ?? "Untitled";
}

/** The netuid + score meta string next to a result, omitting the netuid segment when it's null. */
export function resultMeta(result: SemanticSearchResult): string {
  const netuidPrefix = result.netuid != null ? `SN${result.netuid} · ` : "";
  return `${netuidPrefix}${formatScore(result.score)}`;
}

function ResultRow({ result }: { result: SemanticSearchResult }) {
  const tags = [...result.categories, ...result.service_kinds].slice(0, 3);
  const content = (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-[13px] text-ink-strong">{resultLabel(result)}</p>
        {result.subtitle ? (
          <p className="truncate text-[11px] text-ink-muted">{result.subtitle}</p>
        ) : null}
        {tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-ink-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 font-mono text-[10px] text-ink-muted">{resultMeta(result)}</span>
    </div>
  );

  if (result.netuid != null) {
    return (
      <li>
        <Link
          to="/subnets/$netuid"
          params={{ netuid: result.netuid }}
          className="block hover:bg-card"
        >
          {content}
        </Link>
      </li>
    );
  }
  return <li>{content}</li>;
}

function SearchResults({ results }: { results: SemanticSearchResult[] }) {
  if (results.length === 0) {
    return <p className="mt-3 text-[12px] text-ink-muted">No matches — try a different phrase.</p>;
  }
  return (
    <ul className="mt-4 divide-y divide-border rounded-lg border border-border bg-card">
      {results.map((r, i) => (
        // Results have no stable id in the schema; index is safe since this list
        // is fully replaced (not reordered/filtered in place) on every new query.
        <ResultRow key={i} result={r} />
      ))}
    </ul>
  );
}

export function SearchBox() {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data, isFetching, isError, error } = useQuery({
    ...semanticSearchQuery(submitted, RESULT_LIMIT),
    retry: 0,
  });

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    setSubmitted(trimmed);
  }

  return (
    <div>
      <form onSubmit={onSubmit} className="flex flex-col gap-2 sm:flex-row sm:items-start">
        <label className="flex-1">
          <span className="sr-only">Search the subnet registry</span>
          <input
            type="text"
            required
            placeholder="video generation"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full rounded-lg border border-border bg-card px-3 py-2 text-[13px] text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30"
          />
        </label>
        <button
          type="submit"
          disabled={isFetching || !query.trim()}
          className={classNames(
            "shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-4 py-2 text-[13px] font-medium text-accent hover:bg-accent/15",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isFetching ? "Searching…" : "Search"}
        </button>
      </form>

      {isError ? (
        <p role="alert" className="mt-3 font-mono text-[12px] text-health-warn">
          {describeSearchError(error)}
        </p>
      ) : null}

      {!isError && submitted && data ? <SearchResults results={data.data.results} /> : null}
    </div>
  );
}
