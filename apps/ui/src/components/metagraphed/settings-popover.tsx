import { Settings, Sun, Moon, Monitor, Rows3, Rows4 } from "lucide-react";
import { Popover, PopoverTrigger } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { useDensity, type Density } from "@/lib/density";
import { useHealthPalette, HEALTH_PALETTES, type HealthPaletteId } from "@/lib/health-palette";
import { classNames } from "@/lib/metagraphed/format";

const THEMES: Array<{ id: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "system", label: "System", Icon: Monitor },
];

const DENSITIES: Array<{ id: Density; label: string; Icon: typeof Rows3; hint: string }> = [
  { id: "comfortable", label: "Comfortable", Icon: Rows3, hint: "Default spacing" },
  { id: "compact", label: "Compact", Icon: Rows4, hint: "More rows per screen" },
];

/**
 * Single header gear button. Opens a popover with theme + density + health
 * color preset. State persists to localStorage via the underlying hooks.
 */
export function SettingsPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className="inline-flex items-center justify-center rounded border border-border bg-card p-1.5 min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-ink/30 transition-colors"
        >
          <Settings className="size-3.5" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <ClampedPopoverContent align="end" className="w-72 p-3">
        <SettingsPanel />
      </ClampedPopoverContent>
    </Popover>
  );
}

/**
 * The theme + density + health-color controls, without the popover chrome, so
 * they can be reused wherever settings need to be surfaced — the header gear
 * popover on wide viewports, and the consolidated overflow menu on the mid
 * desktop range where the standalone gear is folded away to fit the header.
 */
export function SettingsPanel() {
  const { choice, setChoice } = useTheme();
  const { density, setDensity } = useDensity();
  const { paletteId, setPalette } = useHealthPalette();

  return (
    <div className="space-y-4">
      <Section label="Theme">
        <SegmentedRow>
          {THEMES.map(({ id, label, Icon }) => (
            <SegmentBtn
              key={id}
              active={choice === id}
              onClick={() => setChoice(id)}
              label={label}
              title={`${label} theme`}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span>{label}</span>
            </SegmentBtn>
          ))}
        </SegmentedRow>
      </Section>

      <Section label="Density" sub="Affects health KPIs and list tables.">
        <SegmentedRow>
          {DENSITIES.map(({ id, label, Icon, hint }) => (
            <SegmentBtn
              key={id}
              active={density === id}
              onClick={() => setDensity(id)}
              label={hint}
              title={hint}
            >
              <Icon className="size-3.5" aria-hidden="true" />
              <span>{label}</span>
            </SegmentBtn>
          ))}
        </SegmentedRow>
      </Section>

      <Section label="Health colors" sub="Preset for ok / warn / down / unknown dots.">
        <ul className="space-y-1">
          {HEALTH_PALETTES.map((p) => (
            <PaletteRow
              key={p.id}
              id={p.id}
              label={p.label}
              description={p.description}
              swatches={[p.swatch.ok, p.swatch.warn, p.swatch.down, p.swatch.unknown]}
              active={paletteId === p.id}
              onSelect={() => setPalette(p.id)}
            />
          ))}
        </ul>
        <p className="mt-2 text-[10px] text-ink-muted">
          All presets verified for perceptible contrast in light and dark.
        </p>
      </Section>
    </div>
  );
}

function Section({
  label,
  sub,
  children,
}: {
  label: string;
  sub?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="mg-type-micro text-ink-muted mb-1.5">{label}</div>
      {children}
      {sub ? <p className="mt-1 text-[10px] text-ink-muted">{sub}</p> : null}
    </div>
  );
}

function SegmentedRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex w-full items-center rounded border border-border bg-surface/40 p-0.5">
      {children}
    </div>
  );
}

function SegmentBtn({
  active,
  onClick,
  label,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={title ?? label}
      className={classNames(
        "flex-1 inline-flex items-center justify-center gap-1.5 rounded-sm px-2 py-1.5 text-[11px] font-medium transition-colors min-h-8",
        active ? "bg-card text-ink-strong shadow-sm" : "text-ink-muted hover:text-ink-strong",
      )}
    >
      {children}
    </button>
  );
}

function PaletteRow({
  id,
  label,
  description,
  swatches,
  active,
  onSelect,
}: {
  id: HealthPaletteId;
  label: string;
  description: string;
  swatches: string[];
  active: boolean;
  onSelect: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={active}
        className={classNames(
          "w-full flex items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors min-h-9",
          active
            ? "border-ink-strong/40 bg-surface/60"
            : "border-border bg-card hover:border-ink/30",
        )}
      >
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {swatches.map((c, i) => (
            <span
              key={`${id}-${i}`}
              className="block size-2.5 rounded-full"
              style={{ backgroundColor: c }}
            />
          ))}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[12px] font-medium text-ink-strong">{label}</span>
          <span className="block text-[10px] text-ink-muted truncate">{description}</span>
        </span>
      </button>
    </li>
  );
}
