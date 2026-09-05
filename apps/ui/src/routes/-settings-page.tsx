import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation } from "@tanstack/react-router";
import {
  AnalyticsSection,
  EntityHero,
  FactSentence,
  RangeControl,
  RankGrid,
  Raw,
  SectionNav,
  type SectionNavLink,
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

import { useHydrated } from "@/hooks/use-hydrated";
import { SettingsGroupActiveContext } from "@/lib/metagraphed/settings-group-context";
import {
  settingsGroupForHash,
  settingsNavigation,
  type SettingsGroupId,
} from "@/lib/metagraphed/settings-navigation";

const API_PATHS = ["/api/v1/keys", "/api/v1/watch/triggers", "/api/v1/webhooks/subscriptions"];

/** Registers the page's sources from INSIDE `AppShell`, which owns the provider. */
function ApiSources() {
  useRegisterApiSource(API_PATHS);
  return null;
}

export function SettingsPage() {
  const hydrated = useHydrated();
  const hash = useLocation({ select: (location) => location.hash });
  const group = settingsGroupForHash(hydrated ? hash : "");
  const [visited, setVisited] = useState<SettingsGroupId[]>(["appearance"]);
  useEffect(() => {
    setVisited((current) => (current.includes(group) ? current : [...current, group]));
  }, [group]);
  // A fragment is absent from the server request. Reveal its group after
  // hydration before scrolling, including on browser Back and Forward.
  useEffect(() => {
    if (!hydrated || !hash) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(hash)?.scrollIntoView({ block: "start", behavior: "instant" });
    });
    return () => cancelAnimationFrame(frame);
  }, [hash, hydrated]);
  const { choice, setChoice } = useTheme();
  const { paletteId, setPalette } = useHealthPalette();
  const { unit, setUnit } = useValueUnit();
  const subnets = useWatchlist("subnet");
  const validators = useWatchlist("validator");
  const accounts = useWatchlist("account");

  const watchedCount = subnets.ids.size + validators.ids.size + accounts.ids.size;

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
        className="mg-hero--settings"
        name="Settings"
        sentence={
          <FactSentence>Appearance, saved items, notifications and developer access.</FactSentence>
        }
      />
      <SectionNav
        items={settingsNavigation(group)}
        link={SettingsNavLink}
        className="[&_.mg-section-nav-scroll]:overflow-visible [&_ul]:grid [&_ul]:grid-cols-3 [&_ul]:gap-0 [&_ul]:whitespace-normal md:[&_ul]:flex md:[&_ul]:gap-6 [&_a]:flex [&_a]:h-full [&_a]:min-h-11 [&_a]:items-center [&_a]:justify-center [&_a]:px-2 [&_a]:text-center [&_a]:text-13"
      />
      <div className="mg-settings-groups">
        <SettingsGroup id="appearance" current={group} visited={visited}>
          <InstallAppRow />
          <AnalyticsSection
            className="mg-settings-preferences"
            id="preferences"
            name="Appearance"
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
        </SettingsGroup>
        <SettingsGroup id="watchlists" current={group} visited={visited}>
          <AnalyticsSection
            id="wallet"
            name="Watchlists"
            question="Saved in this browser."
            visual={
              <div className="space-y-6">
                {watched.length > 0 ? (
                  <RankGrid items={watched} cols={4} ariaLabel="Saved items" source="watched" />
                ) : (
                  <div className="space-y-2 text-13 text-ink-muted">
                    <p>
                      Star a subnet, validator or account to save it here. No wallet connection is
                      needed.
                    </p>
                    <div className="flex flex-wrap gap-x-6 gap-y-2">
                      <Link
                        to="/subnets"
                        className="mg-section-more min-h-11 inline-flex items-center"
                      >
                        Browse subnets
                      </Link>
                      <Link
                        to="/validators"
                        className="mg-section-more min-h-11 inline-flex items-center"
                      >
                        Browse validators
                      </Link>
                      <Link
                        to="/accounts"
                        className="mg-section-more min-h-11 inline-flex items-center"
                      >
                        Browse accounts
                      </Link>
                    </div>
                  </div>
                )}
                <div className="border-t border-rule pt-6 space-y-3">
                  <h3 className="text-13 font-medium text-ink-strong">Wallet connection</h3>
                  <WalletConnectPanel />
                </div>
              </div>
            }
            footnote={
              watchedCount > watched.length
                ? `showing ${watched.length} of ${watchedCount} saved items · export includes all saved items`
                : `${watchedCount} saved items · this browser only`
            }
          />
          <AnalyticsSection
            id="portability"
            name="Import and export"
            question="Move stars and address labels between browsers."
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
          <AnalyticsSection
            id="alerts"
            name="Alerts"
            question="Manage notifications and review delivery."
            visual={
              <>
                <AlertsManager />
                <AlertTriggerLookup />
              </>
            }
            footnote="verified with your wallet · read scope only, never a transaction"
          />
        </SettingsGroup>
        <SettingsGroup id="developer" current={group} visited={visited}>
          <AnalyticsSection
            id="keys"
            name="API keys"
            visual={<ApiKeysManager />}
            footnote="public API access remains available without a key"
          />
          <AnalyticsSection
            id="webhooks"
            name="Webhooks"
            question="Manage change-feed subscriptions."
            visual={<WebhookSubscriptionManager />}
            footnote="keep your subscription token to manage or remove a webhook"
          />
          <Raw rows={rawRows} />
        </SettingsGroup>
      </div>
    </AppShell>
  );
}

const SettingsNavLink: SectionNavLink = ({ href, children, ...rest }) => (
  <Link
    to="/settings"
    hash={href.split("#")[1]}
    resetScroll={false}
    activeOptions={{ includeHash: true }}
    {...rest}
  >
    {children}
  </Link>
);

/** Retain visited forms and one-time values while removing inactive groups
 * from layout, keyboard navigation and assistive technology. Unvisited
 * authenticated panels do not mount or start their queries.
 */
function SettingsGroup({
  id,
  current,
  visited,
  children,
}: {
  id: SettingsGroupId;
  current: SettingsGroupId;
  visited: SettingsGroupId[];
  children: ReactNode;
}) {
  if (id !== current && !visited.includes(id)) return null;
  const inactive = id !== current;
  return (
    <SettingsGroupActiveContext value={!inactive}>
      <div data-settings-group={id} hidden={inactive} inert={inactive}>
        {children}
      </div>
    </SettingsGroupActiveContext>
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
