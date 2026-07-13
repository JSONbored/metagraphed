import {
  BookOpen,
  ExternalLink as ExternalLinkIcon,
  Github,
  Globe,
  LayoutDashboard,
} from "lucide-react";
import { safeExternalUrl } from "@/components/metagraphed/external-link";

type LinkSpec = {
  label: string;
  href?: string;
  icon: typeof Globe;
};

function host(url?: string): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export interface PrimaryLinksRailProps {
  website?: string;
  docs?: string;
  repo?: string;
  dashboard?: string;
  extras?: Array<{ label: string; href: string; icon?: typeof Globe }>;
}

/**
 * Pill rail of the most-used public resources for an entity profile page.
 * Missing links are silently skipped — never renders a "—" placeholder.
 */
export function PrimaryLinksRail({
  website,
  docs,
  repo,
  dashboard,
  extras,
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

  return (
    <div className="flex flex-wrap items-center gap-2">
      {items.map((it) => {
        const Icon = it.icon;
        const href = safeExternalUrl(it.href)!;
        return (
          <a
            key={it.label + href}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="group inline-flex items-center gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-ink-strong hover:border-ink/30 transition-colors"
          >
            <Icon className="size-3.5 text-ink-muted" />
            <span>{it.label}</span>
            <span className="hidden sm:inline font-mono text-[10px] text-ink-muted">
              {host(href)}
            </span>
            <ExternalLinkIcon className="size-3 text-ink-muted opacity-60 group-hover:opacity-100" />
          </a>
        );
      })}
    </div>
  );
}
