import { BookOpen, Github, Globe, LayoutDashboard } from "lucide-react";
import { safeExternalUrl } from "@/components/metagraphed/external-link";

type LinkSpec = {
  label: string;
  href?: string;
  icon: typeof Globe;
};

export interface PrimaryLinksRailProps {
  website?: string;
  docs?: string;
  repo?: string;
  dashboard?: string;
  extras?: Array<{ label: string; href: string; icon?: typeof Globe }>;
  /**
   * Skip the own connected-bar wrapper (border/divide/rounded) and render
   * just the bare icon segments — for composing into a shared bar alongside
   * other icon actions (e.g. a `connected` ShareButton), where the caller
   * provides the wrapping `divide-x` container instead.
   */
  bare?: boolean;
}

/**
 * Icon-only rail of the most-used public resources for an entity profile
 * page, styled as one connected segmented bar (matching SegmentedToggle /
 * ViewModeToggle's shared-border-and-divider look) rather than separately
 * spaced, individually-bordered icon boxes. Missing links are silently
 * skipped — never renders a "—" placeholder. No label/host text or trailing
 * external-link glyph — these icons (globe, book, github mark, dashboard)
 * are universally recognized, so a bare icon segment stays clean and minimal
 * rather than repeating what the icon already says. The full label is still
 * available via `title`/`aria-label` for a11y.
 */
export function PrimaryLinksRail({
  website,
  docs,
  repo,
  dashboard,
  extras,
  bare,
}: PrimaryLinksRailProps) {
  const items: LinkSpec[] = [
    { label: "Website", href: website, icon: Globe },
    { label: "Docs", href: docs, icon: BookOpen },
    { label: "Repository", href: repo, icon: Github },
    { label: "Dashboard", href: dashboard, icon: LayoutDashboard },
    ...(extras ?? []).map((e) => ({
      label: e.label,
      href: e.href,
      icon: e.icon ?? Globe,
    })),
  ].filter((i) => safeExternalUrl(i.href)) as LinkSpec[];

  if (items.length === 0) return null;

  const segments = items.map((it) => {
    const Icon = it.icon;
    const href = safeExternalUrl(it.href)!;
    return (
      <a
        key={it.label + href}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={it.label}
        aria-label={it.label}
        className="inline-flex size-8 items-center justify-center text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors"
      >
        <Icon className="size-4" />
      </a>
    );
  });

  if (bare) return <>{segments}</>;

  return (
    <div className="inline-flex items-center rounded-md border border-border bg-card divide-x divide-border overflow-hidden">
      {segments}
    </div>
  );
}
