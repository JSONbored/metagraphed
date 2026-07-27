import { useState } from "react";
import { CopyableCode, SectionAnchor } from "@jsonbored/ui-kit";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";

// #8329: the subnet-team flywheel. A subnet that puts a live uptime badge in
// its own README advertises the registry to exactly the audience we want, for
// free and permanently -- and the badge is honest in a way a self-reported one
// can't be, because the number is probe-derived and we don't accept an uptime
// value from anyone.
//
// The endpoint already existed; nothing pointed a subnet team at it.

// The canonical public origin. A README badge links somewhere permanent, so
// this is the production site rather than window.location.origin -- a snippet
// copied from a preview deploy or localhost would otherwise carry that host
// into someone else's repo.
const SITE_ORIGIN = "https://metagraph.sh";

const FORMATS = [
  { id: "markdown", label: "Markdown" },
  { id: "html", label: "HTML" },
  { id: "url", label: "URL" },
] as const;
type Format = (typeof FORMATS)[number]["id"];

/** Badge metrics worth putting in a README, in the order a team would want them. */
const METRICS = [
  { id: "uptime", label: "Uptime", hint: "probe-derived, 90-day window" },
  { id: "grade", label: "Grade", hint: "the A–F reliability letter" },
  { id: "apis", label: "APIs", hint: "callable API surfaces" },
] as const;

export function UptimeBadgeEmbed({ netuid, name }: { netuid: number; name?: string }) {
  const [format, setFormat] = useState<Format>("markdown");
  const [metric, setMetric] = useState<(typeof METRICS)[number]["id"]>("uptime");

  const badgeUrl = `${API_BASE}/api/v1/subnets/${netuid}/badge.svg?metric=${metric}`;
  const linkUrl = `${SITE_ORIGIN}/subnets/${netuid}`;
  const alt = `${name ?? `SN${netuid}`} ${metric} on Metagraphed`;

  const snippet =
    format === "markdown"
      ? `[![${alt}](${badgeUrl})](${linkUrl})`
      : format === "html"
        ? `<a href="${linkUrl}"><img src="${badgeUrl}" alt="${alt}"></a>`
        : badgeUrl;

  return (
    <SectionAnchor
      id="badge"
      title="Embeddable badge"
      subtitle="A live status badge for this subnet's README."
      info="Probe-derived only — the value comes from the same 2-minute prober that backs this page's uptime figures, and there is no way to supply your own number. Cached for an hour at the edge; GitHub re-fetches through its own image proxy."
    >
      <div className="space-y-3">
        <img
          src={badgeUrl}
          alt={alt}
          width={117}
          height={20}
          className="block"
          // The badge is the preview: showing the real endpoint's own output
          // means a broken badge is visible here rather than discovered in
          // someone else's README.
          loading="lazy"
        />

        <div className="flex flex-wrap gap-1.5">
          {METRICS.map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMetric(m.id)}
              aria-pressed={metric === m.id}
              title={m.hint}
              className={classNames(
                "min-h-9 rounded-full border px-2.5 py-1 mg-type-caption transition-colors",
                metric === m.id
                  ? "border-accent/40 bg-accent/10 text-accent-text"
                  : "border-border bg-card text-ink-muted hover:border-ink/30",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div>
          <div className="mb-1 flex flex-wrap items-center gap-1">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFormat(f.id)}
                className={classNames(
                  "min-h-9 rounded px-2 py-1 mg-type-caption transition-colors",
                  format === f.id
                    ? "bg-surface text-ink-strong"
                    : "text-ink-muted hover:text-ink-strong",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <CopyableCode label={format} value={snippet} className="min-w-0 max-w-full" />
        </div>
      </div>
    </SectionAnchor>
  );
}
