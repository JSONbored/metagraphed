import { ExternalLink } from "@/components/metagraphed/external-link";
import { CopyableCode } from "@/components/metagraphed/copyable-code";
import { API_BASE } from "@/lib/metagraphed/config";

/**
 * Cosmos-directory-style footer: surfaces the canonical JSON endpoint(s)
 * powering the current view so developers can copy/share them.
 */
export function ApiSourceFooter({
  paths,
  artifacts,
}: {
  paths: string[];
  artifacts?: string[];
}) {
  return (
    <footer className="mt-10 border-t border-border pt-4 text-[11px] text-ink-muted">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <span className="font-mono uppercase tracking-widest text-[10px]">data sources</span>
        {paths.map((p) => (
          <div key={p} className="flex items-center gap-1.5">
            <ExternalLink href={`${API_BASE}${p}`} className="hover:text-ink-strong">
              {p}
            </ExternalLink>
            <CopyableCode value={`${API_BASE}${p}`} label="copy" className="px-1.5 py-0.5" />
          </div>
        ))}
      </div>
      {artifacts && artifacts.length > 0 ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="font-mono uppercase tracking-widest text-[10px]">artifacts</span>
          {artifacts.map((p) => (
            <ExternalLink key={p} href={`${API_BASE}${p}`} className="hover:text-ink-strong">
              {p}
            </ExternalLink>
          ))}
        </div>
      ) : null}
    </footer>
  );
}
