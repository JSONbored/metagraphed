import { Check, Globe2, Settings, Sun, Moon, Monitor } from "lucide-react";
import { Popover, PopoverTrigger } from "@jsonbored/ui-kit";
import { ClampedPopoverContent } from "./clamped-popover-content";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { useNetwork } from "@/hooks/use-api-base";
import { CHAIN_NETWORKS } from "@/lib/metagraphed/config";
import { useHealthPalette, HEALTH_PALETTES, type HealthPaletteId } from "@/lib/health-palette";
import { classNames } from "@/lib/metagraphed/format";

const THEMES: Array<{ id: ThemeChoice; label: string; Icon: typeof Sun }> = [
  { id: "light", label: "Light", Icon: Sun },
  { id: "dark", label: "Dark", Icon: Moon },
  { id: "system", label: "System", Icon: Monitor },
];

/**
 * Single header gear button. Opens a popover with theme, chain network and the
 * health colour preset. State persists to localStorage via the underlying hooks.
 */
export function SettingsPopover() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Settings"
          title="Settings"
          className="inline-flex items-center justify-center rounded border border-border min-h-11 min-w-11 text-ink-muted hover:text-ink-strong hover:border-rule-strong transition-colors"
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
 * The theme + network + health-colour controls, without the popover chrome, so
 * they can be reused in the mobile navigation sheet.
 */
export function SettingsPanel() {
  const { choice, setChoice } = useTheme();
  const { network, change: changeNetwork } = useNetwork();
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

      <Section label="Network" sub="Which Bittensor network's data the app shows.">
        <ul className="space-y-1">
          {CHAIN_NETWORKS.map((n) => {
            const active = n.id === network.id;
            return (
              <li key={n.id}>
                <button
                  type="button"
                  onClick={() => changeNetwork(n.id)}
                  aria-pressed={active}
                  className={classNames(
                    "w-full flex items-center gap-2 rounded border px-2 py-1.5 text-left transition-colors min-h-9",
                    active
                      ? "border-rule-strong bg-layer"
                      : "border-border hover:border-rule-strong",
                  )}
                >
                  <Globe2 className="size-3.5 text-ink-muted shrink-0" aria-hidden="true" />
                  <span className="flex-1 min-w-0 text-13 font-medium text-ink-strong">
                    {n.label}
                  </span>
                  {active ? <Check className="size-3 text-health-ok" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
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
      <div className="text-13 text-ink-muted mb-1.5">{label}</div>
      {children}
      {sub ? <p className="mt-1 text-11 text-ink-muted">{sub}</p> : null}
    </div>
  );
}

function SegmentedRow({ children }: { children: React.ReactNode }) {
  return (
    <div className="inline-flex w-full items-center rounded border border-border bg-layer p-0.5">
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
        "flex-1 inline-flex items-center justify-center gap-1.5 rounded px-2 py-1.5 text-13 font-medium transition-colors min-h-8",
        active ? "bg-raised text-ink-strong" : "text-ink-muted hover:text-ink-strong",
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
          active ? "border-rule-strong bg-layer" : "border-border hover:border-rule-strong",
        )}
      >
        <span className="flex shrink-0 items-center gap-1" aria-hidden>
          {swatches.map((c, i) => (
            <span key={`${id}-${i}`} className="mg-dot" style={{ backgroundColor: c }} />
          ))}
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-13 font-medium text-ink-strong">{label}</span>
          <span className="block text-11 text-ink-muted truncate">{description}</span>
        </span>
      </button>
    </li>
  );
}
