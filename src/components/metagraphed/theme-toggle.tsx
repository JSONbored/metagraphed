import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { classNames } from "@/lib/metagraphed/format";

const ORDER: ThemeChoice[] = ["light", "dark", "system"];
const META: Record<ThemeChoice, { label: string; Icon: typeof Sun }> = {
  light: { label: "Light", Icon: Sun },
  dark: { label: "Dark", Icon: Moon },
  system: { label: "System", Icon: Monitor },
};

/**
 * Compact 3-state segmented toggle: light / dark / system. Persists choice
 * and listens to OS preference when in `system` mode.
 */
export function ThemeToggle() {
  const { choice, setChoice } = useTheme();
  return (
    <div
      role="group"
      aria-label="Color theme"
      className="inline-flex items-center rounded border border-border bg-card p-0.5"
    >
      {ORDER.map((c) => {
        const { Icon, label } = META[c];
        const active = choice === c;
        return (
          <button
            key={c}
            type="button"
            onClick={() => setChoice(c)}
            aria-pressed={active}
            aria-label={`${label} theme`}
            title={`${label} theme`}
            className={classNames(
              "inline-flex items-center justify-center rounded-sm px-1.5 py-1 min-h-7 min-w-7 transition-colors",
              active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong",
            )}
          >
            <Icon className="size-3.5" aria-hidden="true" />
          </button>
        );
      })}
    </div>
  );
}
