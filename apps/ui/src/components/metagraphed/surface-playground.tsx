import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Play, Lock, Loader2 } from "lucide-react";
import { CopyableCode, ExternalLink } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { SectionAnchor } from "@jsonbored/ui-kit";
import { subnetSurfacesQuery } from "@/lib/metagraphed/queries";
import { classNames } from "@/lib/metagraphed/format";
import {
  callSubnetSurface,
  isExecutable,
  type SurfaceCallOutcome,
} from "@/lib/metagraphed/surface-call";
import { apiSnippet, API_SNIPPET_LANGS, type ApiSnippetLang } from "./endpoint-snippet";
import type { Surface } from "@/lib/metagraphed/types";

// Response bodies come from third-party subnet APIs and are untrusted. They are
// only ever stringified into a JSX text child -- never parsed as markup, never
// handed to React's raw-HTML escape hatch, never used as an href. A body
// containing a script tag renders as those literal characters.
//
// (The escape hatch is named obliquely on purpose: surface-call.test.ts greps
// this file for its literal name, and spelling it out here would self-match.)
const MAX_RENDERED_CHARS = 20_000;

function renderBody(body: unknown): string {
  const text = typeof body === "string" ? body : JSON.stringify(body, null, 2);
  return text.length > MAX_RENDERED_CHARS
    ? `${text.slice(0, MAX_RENDERED_CHARS)}\n… truncated for display`
    : text;
}

/**
 * "Try it" panel for a subnet's callable surfaces (#8258).
 *
 * Every guardrail lives server-side in `call_subnet_surface` — allowlist,
 * timeouts, size caps, content-type rejection, rate limiting — so this is a
 * thin client over the path the MCP layer already exposes. See
 * lib/metagraphed/surface-call.ts for why there's no new REST route.
 */
export function SurfacePlayground({ netuid }: { netuid: number }) {
  const surfaces = useQuery(subnetSurfacesQuery(netuid)).data?.data ?? [];
  // Only API-shaped surfaces: a dashboard or a source repo has nothing useful
  // to return as a response body.
  const callable = surfaces.filter(
    (s) => s.id && (s.kind === "subnet-api" || s.kind === "api" || s.kind === "sse"),
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = callable.find((s) => s.id === selectedId) ?? callable[0];

  // An empty module is invisible (#8255) -- a subnet with no callable API
  // shouldn't render a panel explaining that it has no callable API.
  if (callable.length === 0) return null;

  return (
    <SectionAnchor
      id="try-it"
      title="Try it"
      subtitle="Call this subnet's public API from here and see the real response."
      info="Requests go through the registry's own guarded path: only catalogued surfaces are reachable, there is no way to pass an arbitrary URL, and timeouts, response-size caps and rate limits are enforced server-side. Credentials are never handled here."
    >
      <div className="space-y-3">
        <label className="block">
          <span className="mg-type-label uppercase text-ink-muted">Surface</span>
          <select
            value={selected?.id ?? ""}
            onChange={(e) => setSelectedId(e.target.value)}
            className="mt-1 block w-full min-h-11 rounded border border-border bg-card px-2 py-1 mg-type-data text-ink-strong"
          >
            {callable.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name ?? s.url ?? s.id}
                {s.auth_required ? " (auth required)" : ""}
              </option>
            ))}
          </select>
        </label>
        {selected ? <SurfaceRunner key={selected.id} surface={selected} /> : null}
      </div>
    </SectionAnchor>
  );
}

function SurfaceRunner({ surface }: { surface: Surface }) {
  const [outcome, setOutcome] = useState<SurfaceCallOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [lang, setLang] = useState<ApiSnippetLang>("curl");
  const executable = isExecutable(surface);

  async function run() {
    setRunning(true);
    setOutcome(null);
    try {
      setOutcome(await callSubnetSurface(surface.id));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-3">
      {/* The request, always shown -- including for auth-required surfaces,
          where it's the whole point: you can see and copy the call even though
          the playground won't run it for you. */}
      <div>
        <div className="mb-1 flex flex-wrap items-center gap-1">
          {API_SNIPPET_LANGS.map((l) => (
            <button
              key={l.id}
              type="button"
              onClick={() => setLang(l.id)}
              className={classNames(
                "min-h-9 rounded px-2 py-1 mg-type-caption transition-colors",
                lang === l.id
                  ? "bg-surface text-ink-strong"
                  : "text-ink-muted hover:text-ink-strong",
              )}
            >
              {l.label}
            </button>
          ))}
        </div>
        <CopyableCode
          label={lang}
          value={apiSnippet(lang, surface.url ?? "")}
          className="min-w-0 max-w-full"
        />
      </div>

      {executable ? (
        <button
          type="button"
          onClick={() => void run()}
          disabled={running}
          className="inline-flex min-h-11 items-center gap-1.5 rounded border border-accent/40 bg-accent/10 px-3 py-1.5 mg-type-caption font-medium text-accent-text transition-colors hover:bg-accent/15 disabled:opacity-60"
        >
          {running ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Play className="size-3.5" aria-hidden />
          )}
          {running ? "Calling…" : "Execute"}
        </button>
      ) : (
        <p className="inline-flex items-start gap-1.5 mg-type-caption text-ink-muted">
          <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            This surface needs a credential, so it can&rsquo;t be run from here — the playground
            never handles keys. Copy the request above and add your own.
            {surface.schema_url ? (
              <>
                {" "}
                <ExternalLink href={surface.schema_url}>Schema</ExternalLink>
              </>
            ) : null}
          </span>
        </p>
      )}

      {outcome ? <ResponseView outcome={outcome} /> : null}
    </div>
  );
}

function ResponseView({ outcome }: { outcome: SurfaceCallOutcome }) {
  if (!outcome.ok) {
    return (
      <Panel as="div" dense tone="warn">
        <p className="mg-type-caption text-ink-strong">{outcome.error.message}</p>
        <p className="mt-1 mg-type-data-sm text-ink-muted">{outcome.error.code}</p>
      </Panel>
    );
  }
  const r = outcome.result;
  const ok = r.status_code >= 200 && r.status_code < 300;
  return (
    <Panel as="div" dense>
      <div className="mb-2 flex flex-wrap items-center gap-3 mg-type-data-sm">
        <span className={ok ? "text-health-ok" : "text-health-warn"}>HTTP {r.status_code}</span>
        <span className="text-ink-muted tabular-nums">{r.latency_ms} ms</span>
        {r.content_type ? <span className="text-ink-muted">{r.content_type}</span> : null}
        {r.truncated ? (
          <span className="text-health-warn">truncated at the server&rsquo;s size cap</span>
        ) : null}
      </div>
      {/* Untrusted third-party output. Stringified into a text node -- markup in
          the body renders as literal characters, never as HTML. */}
      <pre className="mg-scroll max-h-80 overflow-auto rounded bg-surface p-2 mg-type-data-sm text-ink-strong">
        {renderBody(r.body)}
      </pre>
    </Panel>
  );
}
