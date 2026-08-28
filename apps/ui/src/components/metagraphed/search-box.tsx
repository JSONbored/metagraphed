import { useState, useRef, useEffect, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ExternalLink, safeExternalUrl } from "@jsonbored/ui-kit";
import { Search as SearchIcon } from "lucide-react";
import { ApiError } from "@/lib/metagraphed/client";
import { searchResolveQuery, semanticSearchQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import { captureEvent } from "@/lib/analytics";
import { searchQuery, type SearchIndexHit } from "@/lib/metagraphed/search-query";
import type { ResolvedIdentifier, SemanticSearchResult } from "@/lib/metagraphed/types";

const RESULT_LIMIT = 8;

type ResultLinkData = {
  kind?: string;
  type?: string | null;
  netuid?: number | null;
  url?: string | null;
};

export type SearchResultDestination =
  | { kind: "subnet"; netuid: number }
  | { kind: "internal"; href: string }
  | { kind: "external"; href: string }
  | null;

function safeInternalPath(href?: string | null): string | undefined {
  return href?.startsWith("/") && !href.startsWith("//") ? href : undefined;
}

/** The destination has to respect the specific indexed resource, not merely
 * its owning subnet. A documentation match should open that documentation;
 * only a subnet record itself should default to the subnet overview. */
export function resultDestination(result: ResultLinkData): SearchResultDestination {
  const kind = (result.kind ?? result.type ?? "").toLowerCase();
  if (kind === "subnet" && result.netuid != null) {
    return { kind: "subnet", netuid: result.netuid };
  }
  const internal = safeInternalPath(result.url);
  if (internal) return { kind: "internal", href: internal };
  const external = safeExternalUrl(result.url ?? undefined);
  if (external) return { kind: "external", href: external };
  // Some older surface records have no direct URL. Their owning subnet is a
  // useful, honest fallback rather than rendering a decorative dead row.
  return result.netuid != null ? { kind: "subnet", netuid: result.netuid } : null;
}

/** Distinguishes a 429 (rate-limited) and 503 (AI disabled/unavailable) search rejection from a generic failure — same AI-endpoint family as ask-box's describeAskError. */
export function describeSearchError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Rate-limited — try again shortly.";
    if (error.status === 503) return error.message || "AI is temporarily unavailable.";
    // A route/proxy outage used to expose a bare server “Not Found” in the
    // homepage. It neither explains the user's next step nor reflects their
    // query, so reserve server copy for the one useful client error (400).
    if (error.status === 400) return error.message || "Couldn't search — try again.";
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

function ResultLink({
  destination,
  children,
  ariaLabel,
}: {
  destination: SearchResultDestination;
  children: React.ReactNode;
  ariaLabel?: string;
}) {
  const className = "block hover:bg-card";
  if (destination?.kind === "subnet") {
    return (
      <Link to="/subnets/$netuid" params={{ netuid: destination.netuid }} className={className}>
        {children}
      </Link>
    );
  }
  if (destination?.kind === "internal") {
    return (
      <a href={destination.href} className={className}>
        {children}
      </a>
    );
  }
  if (destination?.kind === "external") {
    return (
      <ExternalLink
        href={destination.href}
        bare
        ariaLabel={ariaLabel ?? "Open external result in a new tab"}
        className={className}
      >
        {children}
      </ExternalLink>
    );
  }
  return <>{children}</>;
}

function ResultRow({ result }: { result: SemanticSearchResult }) {
  const tags = [...result.categories, ...result.service_kinds].slice(0, 3);
  const destination = resultDestination(result);
  const content = (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-13 text-ink-strong">{resultLabel(result)}</p>
        {result.subtitle ? (
          <p className="truncate text-13 text-ink-muted">{result.subtitle}</p>
        ) : null}
        {tags.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="rounded border border-border px-1.5 py-0.5 text-10 text-ink-muted"
              >
                {tag}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 text-10 text-ink-muted">
        {resultMeta(result)}
        {destination?.kind === "external" ? <span aria-hidden="true"> ↗</span> : null}
      </span>
    </div>
  );

  return (
    <li>
      <ResultLink
        destination={destination}
        ariaLabel={
          destination?.kind === "external" ? `Open ${resultLabel(result)} in a new tab` : undefined
        }
      >
        {content}
      </ResultLink>
    </li>
  );
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
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-10 text-ink-muted">
            {identifierKindLabel(match.kind)}
          </span>
          <span className="truncate font-mono text-13 text-ink">
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
      <h3 className="text-13 text-ink-muted">{matches.length > 1 ? "Could be" : "Go to"}</h3>
      <ul className="mt-2 divide-y divide-border rounded border border-border bg-card">
        {matches.map((m) => (
          <IdentifierRow key={`${m.kind}:${m.value}`} match={m} />
        ))}
      </ul>
    </section>
  );
}

function SearchResults({ results }: { results: SemanticSearchResult[] }) {
  if (results.length === 0) {
    return <p className="mt-3 text-13 text-ink-muted">No matches — try a different phrase.</p>;
  }
  return (
    <ul className="mt-4 divide-y divide-border rounded border border-border bg-card">
      {results.map((r, i) => (
        // Results have no stable id in the schema; index is safe since this list
        // is fully replaced (not reordered/filtered in place) on every new query.
        <ResultRow key={i} result={r} />
      ))}
    </ul>
  );
}

export function keywordResultLabel(result: SearchIndexHit): string {
  return result.title ?? result.slug ?? "Untitled";
}

export function keywordResultMeta(result: SearchIndexHit): string {
  const kind = result.kind ?? result.type ?? "indexed item";
  return result.netuid != null ? `SN${result.netuid} · ${kind}` : kind;
}

function KeywordResultRow({ result }: { result: SearchIndexHit }) {
  const destination = resultDestination(result);
  const content = (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="truncate text-13 text-ink-strong">{keywordResultLabel(result)}</p>
        {result.subtitle ? (
          <p className="truncate text-13 text-ink-muted">{result.subtitle}</p>
        ) : null}
      </div>
      <span className="shrink-0 text-10 text-ink-muted">
        {keywordResultMeta(result)}
        {destination?.kind === "external" ? <span aria-hidden="true"> ↗</span> : null}
      </span>
    </div>
  );
  return (
    <li>
      <ResultLink
        destination={destination}
        ariaLabel={
          destination?.kind === "external"
            ? `Open ${keywordResultLabel(result)} in a new tab`
            : undefined
        }
      >
        {content}
      </ResultLink>
    </li>
  );
}

function KeywordResults({ results }: { results: SearchIndexHit[] }) {
  if (results.length === 0) return null;
  return (
    <ul className="mt-2 divide-y divide-border rounded border border-border bg-card">
      {results.map((result) => (
        <KeywordResultRow key={result.id} result={result} />
      ))}
    </ul>
  );
}

export function SearchBox({ variant = "default" }: { variant?: "default" | "landing" }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const semantic = useQuery({
    ...semanticSearchQuery(submitted, RESULT_LIMIT),
    retry: 0,
  });
  // RUN ALONGSIDE, not instead. Resolve is deterministic and needs no AI
  // binding; semantic needs both. An explorer's most common search -- a pasted
  // hash or address -- must never wait on, or fail because of, the embedding
  // path, so a 503 from semantic search leaves these matches intact.
  const resolved = useQuery({ ...searchResolveQuery(submitted), retry: 0 });
  // The compact index is deliberately requested only after semantic ranking
  // fails. This keeps the normal fast path to two requests, while an AI or
  // proxy failure still leaves people with useful registry results instead of
  // a dead-end error message.
  const indexSearch = useQuery({
    ...searchQuery(submitted, RESULT_LIMIT),
    enabled: Boolean(submitted) && semantic.isError,
    retry: 0,
  });
  const searchIsFetching = semantic.isFetching || (semantic.isError && indexSearch.isFetching);
  const matches = resolved.data?.data.matches ?? [];
  const indexedResults = indexSearch.data?.data ?? [];

  useEffect(() => {
    if (!searchIsFetching && startedAtRef.current != null) {
      setLatencyMs(Date.now() - startedAtRef.current);
      startedAtRef.current = null;
    }
  }, [searchIsFetching]);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) return;
    captureEvent("agent_live_test_run", { mode: "search" });
    startedAtRef.current = Date.now();
    setLatencyMs(null);
    // setState intentionally ignores an identical string. Refetching here
    // makes “try again” actually retry after a transient search failure.
    if (trimmed === submitted) {
      void semantic.refetch();
    } else {
      setSubmitted(trimmed);
    }
  }

  const landing = variant === "landing";

  return (
    <div className={classNames("mg-search-box", landing && "mg-search-box--landing")}>
      <form
        onSubmit={onSubmit}
        className={
          landing ? "mg-search-box-form" : "flex flex-col gap-2 sm:flex-row sm:items-start"
        }
      >
        <label className={classNames("flex-1", landing && "mg-search-box-field")}>
          <span className="sr-only">Search the subnet registry</span>
          {landing ? <SearchIcon className="mg-search-box-icon" aria-hidden="true" /> : null}
          <input
            type="text"
            required
            placeholder={landing ? "Block, subnet, or address" : "video generation"}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className={
              landing
                ? "mg-search-box-input"
                : "w-full rounded border border-border bg-card px-3 py-2 text-13 text-ink placeholder:text-ink-muted focus:outline-none focus:border-ink/30"
            }
          />
        </label>
        <button
          type="submit"
          disabled={searchIsFetching || !query.trim()}
          className={classNames(
            landing
              ? "mg-search-box-submit"
              : "shrink-0 rounded border border-accent/40 bg-accent/10 px-4 py-2 text-13 font-medium text-accent hover:bg-accent/15",
            landing
              ? "disabled:cursor-not-allowed"
              : "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {searchIsFetching ? "Searching…" : "Search"}
        </button>
      </form>

      {/* Identifier matches survive a semantic failure -- they are the whole
          point of resolving separately. */}
      {submitted ? <IdentifierMatches matches={matches} /> : null}

      {semantic.isError && indexSearch.isFetching ? (
        <p className="mt-3 text-13 text-ink-muted">Finding keyword matches…</p>
      ) : null}

      {semantic.isError && indexedResults.length > 0 ? (
        <section className="mt-3" aria-label="Keyword search matches">
          <p className="text-13 text-ink-muted">
            Semantic ranking is unavailable — showing keyword matches from the index.
          </p>
          <KeywordResults results={indexedResults} />
          {latencyMs != null ? <p className="mt-2 text-10 text-ink-muted">{latencyMs}ms</p> : null}
        </section>
      ) : null}

      {semantic.isError && !indexSearch.isFetching && indexedResults.length === 0 ? (
        <p role="alert" className="mt-3 font-mono text-13 text-health-warn">
          {describeSearchError(semantic.error)}
        </p>
      ) : null}

      {!semantic.isError && submitted && semantic.data ? (
        <>
          <SearchResults results={semantic.data.data.results} />
          {latencyMs != null ? <p className="mt-2 text-10 text-ink-muted">{latencyMs}ms</p> : null}
        </>
      ) : null}
    </div>
  );
}
