import { FactCell } from "@jsonbored/ui-kit";
import {
  buildSettingsSummaryTiles,
  type SettingsSummaryTile,
} from "@/lib/metagraphed/settings-summary";

export interface SettingsSummaryStripProps {
  /** Optional override for tests/previews — defaults to the live action set. */
  tiles?: SettingsSummaryTile[];
}

/**
 * Light KPI/status strip above the webhook forms (#5346) so Settings opens
 * with the same visual weight as sibling utility pages (health / status /
 * endpoints).
 */
export function SettingsSummaryStrip({
  tiles = buildSettingsSummaryTiles(),
}: SettingsSummaryStripProps) {
  return (
    <div
      className="mb-8 grid grid-cols-1 gap-3 sm:grid-cols-3"
      data-testid="settings-summary-strip"
      aria-label="Webhook subscription actions at a glance"
    >
      {tiles.map((tile) => {
        return <FactCell key={tile.id} label={tile.eyebrow} value={tile.value} hint={tile.hint} />;
      })}
    </div>
  );
}
