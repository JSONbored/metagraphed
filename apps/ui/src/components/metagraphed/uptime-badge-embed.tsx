import { useState } from "react";
import { CopyableCode, SectionAnchor } from "@jsonbored/ui-kit";
import { API_BASE } from "@/lib/metagraphed/config";
import { classNames } from "@/lib/metagraphed/format";
import { SITE_ORIGIN } from "@/lib/metagraphed/identity";

// #8329: the subnet-team flywheel. A subnet that puts a live uptime badge in
// its own README advertises the registry to exactly the audience we want, for
// free and permanently -- and the badge is honest in a way a self-reported one
// can't be, because the number is probe-derived and we don't accept an uptime
// value from anyone.
//
// The endpoint already existed; nothing pointed a subnet team at it.
//
// #11351: generalised from subnets to any registry entity, because the same
// endpoint has always served /api/v1/providers/{slug}/badge.svg and no provider
// page offered it -- 138 pages whose operators are exactly the audience #8329
// describes, with no way to find the thing built for them.
//
// This is now the ONLY mechanism by which this project earns inbound links:
// measured 2026-08-15, 0 of 115 reachable subnet READMEs mention metagraph.sh,
// and outreach is deliberately not being done. So it has to be self-serve and
// impossible to miss on the page an operator already visits -- their own.

// The canonical public origin. A README badge links somewhere permanent, so
// this is the production site rather than window.location.origin -- a snippet
// copied from a preview deploy or localhost would otherwise carry that host
// into someone else's repo.

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

/**
 * Which registry entity the badge describes.
 *
 * The API and the site use the same plural segment for both, so one value
 * drives the badge URL and the link target and they cannot drift apart.
 */
export type BadgeEntity = "subnets" | "providers";

export function UptimeBadgeEmbed({
  entity = "subnets",
  id,
  name,
}: {
  entity?: BadgeEntity;
  /** netuid for a subnet, slug for a provider. */
  id: string | number;
  name?: string;
}) {
  const [format, setFormat] = useState<Format>("markdown");
  const [metric, setMetric] = useState<(typeof METRICS)[number]["id"]>("uptime");

  const segment = encodeURIComponent(String(id));
  const badgeUrl = `${API_BASE}/api/v1/${entity}/${segment}/badge.svg?metric=${metric}`;
  const linkUrl = `${SITE_ORIGIN}/${entity}/${segment}`;
  // A provider has no netuid to fall back on, so the fallback is the entity's
  // own identifier rather than a subnet-shaped label.
  const alt = `${name ?? (entity === "subnets" ? `SN${id}` : String(id))} ${metric} on Metagraphed`;

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
                "min-h-9 rounded border px-2.5 py-1 text-13 transition-colors",
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
                  "min-h-9 rounded px-2 py-1 text-13 transition-colors",
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
