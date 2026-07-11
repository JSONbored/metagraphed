import { useState } from "react";
import { CopyableCode } from "@jsonbored/ui-kit";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";

// Copy-paste "how do I call this" snippets for a GET against a metagraphed
// endpoint. Mirrors the backend generateServiceSnippets forms (#351) — curl /
// fetch / requests — kept single-line so they render and copy cleanly through
// CopyableCode. Extracted from the subnet profile API panel so every entity
// page (account / block / extrinsic) can offer the same dev affordance (#1350).

export const API_SNIPPET_LANGS = [
  { id: "url", label: "URL" },
  { id: "curl", label: "curl" },
  { id: "js", label: "JavaScript" },
  { id: "python", label: "Python" },
] as const;
export type ApiSnippetLang = (typeof API_SNIPPET_LANGS)[number]["id"];

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function apiSnippet(lang: ApiSnippetLang, url: string): string {
  switch (lang) {
    case "curl":
      return `curl -sS ${shellSingleQuote(url)}`;
    case "js":
      return `fetch(${JSON.stringify(url)}).then((r) => r.json())`;
    case "python":
      return `requests.get(${JSON.stringify(url)}).json()`;
    case "url":
    default:
      return url;
  }
}

export interface EndpointSnippetRow {
  label: string;
  path: string;
}

/**
 * A language picker (URL / curl / JS / Python) plus one copyable snippet per
 * row. `path` is appended to API_BASE; pass `/api/v1/...` for enveloped routes
 * or `/metagraph/*.json` for raw artifacts.
 */
export function EndpointSnippet({ rows }: { rows: EndpointSnippetRow[] }) {
  const [lang, setLang] = useState<ApiSnippetLang>("url");
  return (
    <>
      <div
        className="mb-3 inline-flex rounded border border-border bg-card p-0.5"
        role="tablist"
        aria-label="Snippet language"
      >
        {API_SNIPPET_LANGS.map((l) => (
          <button
            key={l.id}
            type="button"
            role="tab"
            aria-selected={lang === l.id}
            onClick={() => setLang(l.id)}
            className={classNames(
              "rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider transition-colors",
              lang === l.id ? "bg-ink-strong text-paper" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {rows.map((r) => (
          <CopyableCode
            key={r.label}
            label={r.label}
            value={apiSnippet(lang, `${API_BASE}${r.path}`)}
            truncate={false}
            className="w-full"
          />
        ))}
      </div>
      {lang === "python" ? (
        <p className="mt-2 font-mono text-[10px] text-ink-muted">
          requires <code className="text-ink-strong">pip install requests</code>
        </p>
      ) : null}
    </>
  );
}
