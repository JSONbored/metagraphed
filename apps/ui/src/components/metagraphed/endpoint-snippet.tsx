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

// #8381: Python's dict/bool/None literal syntax differs from JSON's just
// enough (True/False/None vs true/false/null) that a raw JSON.stringify()
// isn't valid Python source -- close enough for a copy-paste snippet's small,
// flat request bodies (there is no bare "true"/"false"/"null" substring risk
// inside a JSON string VALUE here in practice, since Ask mode's own body is
// just `{ question: <text> }`), without pulling in a real Python-repr library
// for what is, and is expected to stay, a single-field request.
function pythonLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/\btrue\b/g, "True")
    .replace(/\bfalse\b/g, "False")
    .replace(/\bnull\b/g, "None");
}

/**
 * `options.body` (when present) implies a JSON POST -- every existing GET-only
 * call site simply never passes it, so this stays additive/back-compatible.
 */
export function apiSnippet(
  lang: ApiSnippetLang,
  url: string,
  options: { body?: unknown } = {},
): string {
  const { body } = options;
  if (body === undefined) {
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
  switch (lang) {
    case "curl":
      return `curl -sS -X POST -H 'content-type: application/json' -d ${shellSingleQuote(JSON.stringify(body))} ${shellSingleQuote(url)}`;
    case "js":
      return `fetch(${JSON.stringify(url)}, {\n  method: "POST",\n  headers: { "content-type": "application/json" },\n  body: JSON.stringify(${JSON.stringify(body)}),\n}).then((r) => r.json())`;
    case "python":
      return `requests.post(${JSON.stringify(url)}, json=${pythonLiteral(body)}).json()`;
    case "url":
    default:
      // A bare URL alone would read as "GET this" (the existing convention
      // for every no-body row) -- misleading for a POST, so the method is
      // spelled out instead of silently omitting the body this URL needs.
      return `POST ${url}`;
  }
}

export interface EndpointSnippetRow {
  label: string;
  path: string;
  /** JSON POST body; omit for the default GET form. */
  body?: unknown;
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
        // eslint-disable-next-line no-restricted-syntax -- this is a segmented language switcher (role="tablist"), not a card shell; <Panel> would impose card padding/semantics. The rule's rounded+border+bg-card matcher is a false positive here
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
              "rounded px-2.5 py-1 mg-type-label uppercase transition-colors",
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
            value={apiSnippet(lang, `${API_BASE}${r.path}`, { body: r.body })}
            truncate={false}
            className="w-full"
          />
        ))}
      </div>
      {lang === "python" ? (
        <p className="mt-2 mg-type-data-sm text-ink-muted">
          requires <code className="text-ink-strong">pip install requests</code>
        </p>
      ) : null}
    </>
  );
}
