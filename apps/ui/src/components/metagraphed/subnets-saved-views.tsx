import { useNavigate, useSearch } from "@tanstack/react-router";
import { ScrollShadow } from "@jsonbored/ui-kit";
import { classNames } from "@/lib/metagraphed/format";

type Patch = Record<string, string | number | undefined>;

type Preset = {
  id: string;
  label: string;
  patch: Patch;
  hint?: string;
};

/**
 * Saved views for /subnets.
 *
 * Redesign brief (user feedback: "chips look awful", site feels "spaceship-y"):
 *  - No icons, no header, no rule below — reads as toolbar chrome, not a section.
 *  - Text-first labels in the body typeface (not mono-uppercase) so they scan
 *    like navigation, not like log output.
 *  - Active state is a single accent underline; inactive is quiet ink-muted.
 *  - Horizontally scrollable on mobile with edge-fades (ScrollShadow).
 *
 * The "All" pseudo-preset (leftmost) clears every preset dimension so users
 * always have a visible way back to the unfiltered default.
 */
const PRESETS: Preset[] = [
  {
    id: "all",
    label: "All",
    patch: { sort: undefined, order: undefined, curation: undefined, health: undefined },
    hint: "Every subnet, default order",
  },
  {
    id: "top",
    label: "Top",
    patch: { sort: "participants", order: "desc", curation: undefined, health: undefined },
    hint: "Largest networks by participants",
  },
  {
    id: "fresh",
    label: "Recently updated",
    patch: { sort: "updated_at", order: "desc", curation: undefined, health: undefined },
    hint: "Freshest registry edits",
  },
  {
    id: "adapter",
    label: "Adapter-backed",
    patch: { curation: "adapter-backed", health: undefined, sort: "participants", order: "desc" },
    hint: "Pilots with maintained adapters",
  },
  {
    id: "verified",
    label: "Verified",
    patch: {
      curation: "maintainer-reviewed",
      health: undefined,
      sort: "surfaces_count",
      order: "desc",
    },
    hint: "Maintainer-reviewed surfaces",
  },
  {
    id: "unhealthy",
    label: "Unhealthy",
    patch: { health: "down", curation: undefined, sort: "updated_at", order: "desc" },
    hint: "Down or warn endpoints",
  },
  {
    id: "review",
    label: "Needs review",
    patch: {
      curation: "candidate-discovered",
      health: undefined,
      sort: "updated_at",
      order: "desc",
    },
    hint: "Unverified candidate leads",
  },
];

function matches(search: Record<string, unknown>, patch: Patch) {
  return Object.entries(patch).every(([k, v]) => {
    const sv = search[k];
    if (v === undefined) return !sv;
    return String(sv ?? "") === String(v);
  });
}

export function SubnetsSavedViews() {
  const search = useSearch({ from: "/subnets/" }) as Record<string, unknown>;
  const navigate = useNavigate({ from: "/subnets/" });

  // First matching preset wins — "All" is listed first so it lights up when
  // the URL has no preset dimensions set (the truly unfiltered default).
  const activeId = PRESETS.find((p) => matches(search, p.patch))?.id;

  const apply = (patch: Patch) =>
    navigate({
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, cursor: "" };
        for (const [k, v] of Object.entries(patch)) {
          if (v === undefined) delete next[k];
          else next[k] = v;
        }
        return next as never;
      },
      replace: true,
    });

  return (
    <nav className="-mx-1 mb-3" role="group" aria-label="Saved views">
      <ScrollShadow>
        <div className="flex items-center px-1">
          {PRESETS.map((p) => {
            const active = activeId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                title={p.hint}
                aria-pressed={active}
                onClick={() => apply(p.patch)}
                className={classNames(
                  "relative inline-flex shrink-0 items-center px-3 py-2 text-[13px] transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm",
                  active ? "text-ink-strong" : "text-ink-muted hover:text-ink-strong",
                )}
              >
                <span>{p.label}</span>
                {/* Underline — the only visual indicator of active state.
                   Sits inside the button so it tracks the label width. */}
                <span
                  aria-hidden
                  className={classNames(
                    "pointer-events-none absolute inset-x-3 -bottom-px h-[2px] transition-colors",
                    active ? "bg-accent" : "bg-transparent",
                  )}
                />
              </button>
            );
          })}
        </div>
      </ScrollShadow>
      {/* Hairline baseline the underline sits on — anchors the rail visually. */}
      <div aria-hidden className="h-px bg-border" />
    </nav>
  );
}
