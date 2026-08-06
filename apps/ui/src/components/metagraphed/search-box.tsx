import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ApiError } from "@/lib/metagraphed/client";
import { searchResolveQuery, semanticSearchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { captureEvent } from "@/lib/analytics";
import type {
  ResolvedIdentifier,
  SemanticSearchResult,
} from "@/lib/metagraphed/types";

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
        <p className="truncate mg-type-caption-lg text-ink-strong">{resultLabel(result)}</p>
        {result.subtitle ? (
          <p className="truncate mg-type-caption text-ink-muted">{result.subtitle}</p>
        ) : null}
        {tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded border border-border px-1.5 py-0.5 mg-type-data-sm text-ink-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 mg-type-data-sm text-ink-muted">{resultMeta(result)}</span>
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

/** Human label for a resolved kind — the word a user would use for it. */
export function identifierKindLabel(kind: ResolvedIdentifier["kind"]): string {
  switch (kind) {
    case "account":
      return "Account";
    case "block":
      return "Block";
    case "extrinsic":
      return "Extrinsic";
    case "evm-account":
      return "EVM address";
    case "subnet":
      return "Subnet";
    case "neuron":
      return "Neuron";
  }
}

/** A resolved value, shortened in the middle so both ends stay readable — the
 * ends are what a user recognises in a hash or an address. */
export function shortenIdentifier(value: string): string {
  return value.length > 24 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function IdentifierRow({ match }: { match: ResolvedIdentifier }) {
  return (
    <li>
      <a href={match.ui_path} className="block px-3 py-2 hover:bg-card">
        <div className="flex items-center gap-2">
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 mg-type-data-sm text-ink-muted">
            {identifierKindLabel(match.kind)}
          </span>
          <span className="truncate font-mono mg-type-caption text-ink">
            {shortenIdentifier(match.value)}
          </span>
        </div>
      </a>
    </li>
  );
}

/**
 * Where the query could lead, shown ABOVE corpus results.
 *
 * A user who pasted a hash is not looking for a subnet whose description
 * happens to score well, so these come first. They are NOT shown instead:
 * `exact` is a claim about SHAPE, not existence — the route looks nothing up,
 * so a well-formed hash for a block that does not exist still resolves here.
 * Keeping the corpus results visible means that case degrades to "here is what
 * else matched" rather than a dead end.
 */
function IdentifierMatches({ matches }: { matches: ResolvedIdentifier[] }) {
  if (matches.length === 0) return null;
  return (
    <section className="mt-4">
      <h3 className="mg-type-caption text-ink-muted">
        {matches.length > 1 ? "Could be" : "Go to"}
      </h3>
      <ul className="mt-2 divide-y divide-border rounded-md border border-border bg-card">
        {matches.map((m) => (
          <IdentifierRow key={`${m.kind}:${m.value}`} match={m} />
        ))}
      </ul>
    </section>
  );
}

function SearchResults({ results }: { results: SemanticSearchResult[] }) {
  if (results.length === 0) {
    return (
      <p className="mt-3 mg-type-caption text-ink-muted">No matches — try a different phrase.</p>
    );
  }
  return (
    <ul className="mt-4 divide-y divide-border rounded-md border border-border bg-card">
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
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const { data, isFetching, isError, error } = useQuery({
    ...semanticSearchQuery(submitted, RESULT_LIMIT),
    retry: 0,
  });
  // RUN ALONGSIDE, not instead. Resolve is deterministic and needs no AI
  // binding; semantic needs both. An explorer's most common search -- a pasted
  // hash or address -- must never wait on, or fail because of, the embedding
  // path, so a 503 from semantic search leaves these matches intact.
  const resolved = useQuery({ ...searchResolveQuery(submitted), retry: 0 });
  const matches = resolved.data?.data.matches ?? [];

  useEffect(() => {
    if (!isFetching && startedAtRef.current != null) {
      setLatencyMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
    }
  }, [isFetching]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    captureEvent("agent_live_test_run", { mode: "search" });
    startedAtRef.current = Date.now();
    setLatencyMs(null);
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
            className="w-full rounded-md border border-border bg-card px-3 py-2 mg-type-caption-lg text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30"
          />
        </label>
        <button
          type="submit"
          disabled={isFetching || !query.trim()}
          className={classNames(
            "shrink-0 rounded-md border border-accent/40 bg-accent/10 px-4 py-2 mg-type-caption-lg font-medium text-accent hover:bg-accent/15",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {isFetching ? "Searching…" : "Search"}
        </button>
      </form>

      {/* Identifier matches survive a semantic failure -- they are the whole
          point of resolving separately. */}
      {submitted ? <IdentifierMatches matches={matches} /> : null}

      {isError ? (
        <p role="alert" className="mt-3 font-mono mg-type-caption text-health-warn">
          {describeSearchError(error)}
        </p>
      ) : null}

      {!isError && submitted && data ? (
        <>
          <SearchResults results={data.data.results} />
          {latencyMs != null ? (
            <p className="mt-2 mg-type-data-sm text-ink-muted">{latencyMs}ms</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
