import { useMemo } from "react";
import {
  AnalyticsSection,
  EntityHero,
  Fact,
  FactSentence,
  RangeControl,
  RankGrid,
  Raw,
  type RankGridItem,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { WebhookSubscriptionManager } from "@/components/metagraphed/webhook-subscription-manager";
import { ApiKeysManager } from "@/components/metagraphed/api-keys-manager";
import { AlertsManager } from "@/components/metagraphed/alerts-manager";
import { AlertTriggerLookup } from "@/components/metagraphed/alert-trigger-lookup";
import { WatchlistPortability } from "@/components/metagraphed/watchlist-portability";
import { AddressLabelPortability } from "@/components/metagraphed/address-label-portability";
import { InstallAppRow } from "@/components/metagraphed/install-app-row";
import { WalletConnectPanel } from "@/components/metagraphed/wallet-connect";
import { API_BASE } from "@/lib/metagraphed/config";
import { HEALTH_PALETTES, useHealthPalette } from "@/lib/health-palette";
import { useTheme, type ThemeChoice } from "@/lib/theme";
import { useValueUnit } from "@/lib/metagraphed/value-unit-helpers";
import { useWatchlist } from "@/lib/metagraphed/watchlist";

const API_PATHS = ["/api/v1/keys", "/api/v1/watch/triggers", "/api/v1/webhooks/subscriptions"];

/** Registers the page's sources from INSIDE `AppShell`, which owns the provider. */
function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

/**
 * Settings (#11627) — six sections and nothing loose between them.
 *
 * Every manager on this page used to render its own `SectionHead` inside its
 * own `<section>`, so the page was a stack of components that each decided
 * how loud its own heading was. The page owns the headings now and each
 * manager renders only its content, which is the whole of what "adopt v2 with
 * no new structure" means here.
 *
 * Preferences is new: the theme switch, the health-colour palette and the
 * value unit were three controls behind the header's gear popover, discovered
 * by accident or not at all. A preference the reader is meant to set belongs
 * on the page called Settings.
 */
export function SettingsPage() {
  const { choice, setChoice } = useTheme();
  const { paletteId, setPalette } = useHealthPalette();
  const { unit, setUnit } = useValueUnit();
  const subnets = useWatchlist("subnet");
  const validators = useWatchlist("validator");
  const accounts = useWatchlist("account");

  const watched: RankGridItem[] = useMemo(() => {
    const rows = [
      ...[...subnets.ids].map((id) => ({ kind: "subnet" as const, id })),
      ...[...validators.ids].map((id) => ({ kind: "validator" as const, id })),
      ...[...accounts.ids].map((id) => ({ kind: "account" as const, id })),
    ];
    return rows.slice(0, 24).map((row, i) => ({
      key: `${row.kind}-${row.id}`,
      rank: i + 1,
      label: row.kind === "subnet" ? `SN${row.id}` : row.id,
      value: row.kind,
      href:
        row.kind === "subnet"
          ? `/subnets/${row.id}`
          : row.kind === "validator"
            ? `/validators/${row.id}`
            : `/accounts/${row.id}`,
    }));
  }, [subnets.ids, validators.ids, accounts.ids]);

  const rawRows: RawRow[] = API_PATHS.map((path) => ({
    label: path.replace("/api/v1/", ""),
    value: `${API_BASE}${path}`,
    href: `${API_BASE}${path}`,
  }));

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        name="Settings"
        sentence={
          <FactSentence>
            Everything this browser remembers about you, and the keys you have minted.{" "}
            <Fact>watched {watched.length}</Fact>
            <Fact>theme {choice}</Fact>
            <Fact>health colours {paletteId}</Fact>
            <Fact>values {unit}</Fact>
          </FactSentence>
        }
      />

      {/* #8384: renders nothing when there is nothing to offer (already
          installed, dismissed, unsupported browser). */}
      <InstallAppRow />

      <AnalyticsSection
        id="preferences"
        name="Preferences"
        question="How this browser draws the site."
        visual={
          <div className="flex flex-col gap-3">
            {/* `RangeControl` carries its label as an `aria-label` only — on a
                chart the control's meaning is the section it sits in. Three of
                them stacked need the label on screen too, so each gets one;
                the control keeps its own for assistive tech. */}
            <Preference label="Theme">
              <RangeControl
                label="Theme"
                options={[
                  { value: "system", label: "System" },
                  { value: "light", label: "Light" },
                  { value: "dark", label: "Dark" },
                ]}
                value={choice}
                onChange={(next) => setChoice(next as ThemeChoice)}
              />
            </Preference>
            <Preference label="Health colours">
              <RangeControl
                label="Health colours"
                options={HEALTH_PALETTES.map((palette) => ({
                  value: palette.id,
                  label: palette.label,
                }))}
                value={paletteId}
                onChange={(next) => setPalette(next as (typeof HEALTH_PALETTES)[number]["id"])}
              />
            </Preference>
            <Preference label="Values">
              <RangeControl
                label="Values"
                options={[
                  { value: "tao", label: "TAO" },
                  { value: "usd", label: "USD" },
                  { value: "both", label: "Both" },
                ]}
                value={unit}
                onChange={(next) => setUnit(next as typeof unit)}
              />
            </Preference>
          </div>
        }
        // Three presets, not the four the issue named: the palette module
        // ships traffic-light, colorblind-safe and muted. `colorblind-safe` is
        // Okabe-Ito, which is the one preset that covers deuteranopia and
        // protanopia together -- naming three vision types as three presets
        // would promise a distinction the palettes do not make.
        footnote="stored in this browser · no account, no sync"
      />

      <AnalyticsSection
        id="keys"
        name="API keys"
        question="Fullnode RPC access and a higher rate-limit tier, minted against a wallet signature."
        visual={<ApiKeysManager />}
        footnote="the keyless API keeps working exactly as-is — a key buys headroom, it never gates the base"
      />

      <AnalyticsSection
        id="alerts"
        name="Alerts"
        question="What you asked to be told about, and whether it was delivered."
        visual={
          <>
            <AlertsManager />
            <AlertTriggerLookup />
          </>
        }
        footnote="verified with your wallet · read scope only, never a transaction"
      />

      <AnalyticsSection
        id="webhooks"
        name="Webhooks"
        question="Where the change feed is posted."
        visual={<WebhookSubscriptionManager />}
        footnote="self-service against the public subscription API · no account model"
      />

      <AnalyticsSection
        id="wallet"
        name="Wallet"
        question="A read-only connection, and what you are watching."
        visual={<WalletConnectPanel />}
        legend={
          watched.length > 0 ? (
            <RankGrid
              items={watched}
              cols={4}
              ariaLabel="Everything you are watching"
              source="watched"
            />
          ) : null
        }
        // /portfolio redirects here (#11627): a whole route for a
        // wallet-connect prompt was the near-empty page this redesign exists
        // to remove, and the stars it would have shown live in this browser.
        footnote={`${watched.length} watched · read-only · this browser only`}
      />

      <AnalyticsSection
        id="portability"
        name="Portability"
        question="Taking your stars and your labels somewhere else."
        visual={
          <>
            {/* #8256: no account model means stars live in one browser. A JSON
                file is the whole portability story — no server, no sync. */}
            <WatchlistPortability />
            {/* #8484: private, local-first labels for your own addresses —
                distinct store from the watchlist, same portability posture. */}
            <AddressLabelPortability />
          </>
        }
        footnote="export writes a file · import merges into what is already here"
      />

      <Raw rows={rawRows} />
    </AppShell>
  );
}

/** A visible label above one `RangeControl`. */
function Preference({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-10 text-ink-muted">{label}</span>
      {children}
    </div>
  );
}
