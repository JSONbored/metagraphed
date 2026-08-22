import { Link } from "@tanstack/react-router";
import { useQuery, type QueryKey } from "@tanstack/react-query";
import { BookOpen, Code2, Github, Globe, LayoutDashboard, Star } from "lucide-react";
import {
  BrandIcon,
  CurationChip,
  DataPageHero,
  DataPageSignalRail,
  ExternalLink,
  HealthPill,
  TimeAgo,
  safeExternalUrl,
} from "@jsonbored/ui-kit";
import { StaleBanner } from "@/components/metagraphed/states";
import { useApiSourceCtx, useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { subnetUptimeQuery } from "@/lib/metagraphed/queries";
import { useSubnetProbeHealth } from "@/hooks/use-subnet-probe-health";
import type { SubnetProfile } from "@/lib/metagraphed/types";

interface Props {
  netuid: number;
  profile?: SubnetProfile;
  generatedAt?: string;
  stale?: boolean;
  refreshQueryKeys?: QueryKey[];
  refreshLabel?: string;
  banner?: React.ReactNode;
  uptimePct?: number | null;
  evidenceCount?: number;
}

interface LinkItem {
  label: string;
  href?: string;
  icon: typeof Globe;
}

/** A succinct identity fallback when a subnet has not supplied a description. */
export function kindDomainSummary(
  subnetType: string | null | undefined,
  categories: string[],
): string | null {
  const parts = [
    subnetType ? `${subnetType} subnet` : null,
    categories.length > 0 ? categories.join(", ") : null,
  ].filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" — ") : null;
}

/**
 * The subnet identity field is deliberately small in what it promises:
 * purpose, trust, freshness, and one next path. Economics and raw metagraph
 * depth belong to their own intentional views instead of a mixed KPI wall.
 */
export function SubnetMasthead({
  netuid,
  profile,
  generatedAt,
  stale,
  refreshQueryKeys,
  refreshLabel,
  banner,
  uptimePct,
  evidenceCount = 0,
}: Props) {
  const name = profile?.name ?? `Subnet ${netuid}`;
  const categories = (profile?.categories ?? []).slice(0, profile?.subnet_type ? 2 : 3);
  const lede = profile?.description || kindDomainSummary(profile?.subnet_type, categories);
  const probeHealth = useSubnetProbeHealth(netuid);
  const { data: uptimeResult } = useQuery(subnetUptimeQuery(netuid));
  const uptime =
    uptimePct ??
    (uptimeResult?.data?.reliability?.uptime_ratio != null
      ? uptimeResult.data.reliability.uptime_ratio * 100
      : null);
  // Probe freshness and profile freshness are different records. Never borrow
  // the latter just to make a probe-derived signal look timestamped.
  const uptimeAt = uptimeResult?.meta?.generated_at;
  const readiness = profile?.integration_readiness ?? profile?.readiness?.score ?? null;
  const sourceCount = Math.min(Math.max(evidenceCount, 0), 4);

  useRegisterApiSource(
    [
      `/api/v1/subnets/${netuid}/profile`,
      `/api/v1/subnets/${netuid}/overview`,
      `/api/v1/subnets/${netuid}/surfaces`,
      `/api/v1/subnets/${netuid}/endpoints`,
      `/api/v1/subnets/${netuid}/candidates`,
      `/api/v1/subnets/${netuid}/gaps`,
      `/api/v1/subnets/${netuid}/identity-history`,
      `/api/v1/subnets/${netuid}/hyperparameters/history`,
      `/api/v1/subnets/${netuid}/volume`,
      `/api/v1/subnets/${netuid}/stake-quote?amount=100&direction=stake`,
      `/api/v1/subnets/${netuid}/lease`,
      `/api/v1/subnets/${netuid}/lease/history`,
      `/api/v1/subnets/${netuid}/holders`,
      `/api/v1/agent-catalog/${netuid}`,
    ],
    [`/metagraph/subnets/${netuid}.json`],
  );
  const { open: openApiDrawer } = useApiSourceCtx();

  const links: LinkItem[] = [
    { label: "Website", href: profile?.website ?? profile?.homepage, icon: Globe },
    { label: "Docs", href: profile?.docs, icon: BookOpen },
    { label: "Repository", href: profile?.repo, icon: Github },
    { label: "Dashboard", href: profile?.dashboard, icon: LayoutDashboard },
  ].filter((link) => Boolean(safeExternalUrl(link.href))) as LinkItem[];

  return (
    <DataPageHero
      id={`subnet-${netuid}-title`}
      variant="profile"
      eyebrow={`Subnet ${String(netuid).padStart(3, "0")} · registry dossier`}
      live={probeHealth !== "unknown"}
      identity={
        <BrandIcon
          url={profile?.website ?? profile?.homepage}
          repoUrl={profile?.repo}
          iconUrl={profile?.icon_url}
          netuid={netuid}
          subnetSlug={profile?.slug}
          name={profile?.name}
          fallback={netuid}
          size={52}
        />
      }
      title={name}
      description={
        lede ??
        "A Bittensor subnet record. Review its public interfaces, market context, and participation data."
      }
      banner={banner}
      summary={
        <div className="flex flex-wrap items-center gap-2">
          <HealthPill state={probeHealth} />
          <CurationChip level={profile?.curation_level} />
          <StaleBanner
            generatedAt={generatedAt}
            refreshQueryKeys={stale ? refreshQueryKeys : undefined}
            refreshLabel={refreshLabel}
            compact
            bare
          />
        </div>
      }
      primaryActions={
        <>
          <Link
            to="/subnets/$netuid"
            params={{ netuid }}
            search={{ tab: "build" }}
            className="mg-page-primary-action mg-focus-ring"
          >
            {profile?.endpoint_count ? "Explore integration" : "Check build readiness"} →
          </Link>
          <Link
            to="/subnets/$netuid"
            params={{ netuid }}
            search={{ tab: "research" }}
            className="mg-page-quiet-action mg-focus-ring"
          >
            Research economics
          </Link>
          <Link
            to="/subnets/$netuid"
            params={{ netuid }}
            search={{ tab: "participate" }}
            className="mg-page-quiet-action mg-focus-ring"
          >
            Participate
          </Link>
        </>
      }
      aside={
        <DataPageSignalRail
          label="Current subnet trust signals"
          signals={[
            {
              label: "Availability",
              value: uptime != null ? `${uptime.toFixed(2)}%` : "Unmeasured",
              detail: "mean endpoint uptime · 24h",
              freshness: uptimeAt ? (
                <>
                  Probe record · <TimeAgo at={uptimeAt} />
                </>
              ) : uptime != null ? (
                "Probe timestamp unavailable"
              ) : (
                "No probe window yet"
              ),
              level: uptime != null ? uptime / 100 : null,
              // #11521: all three rails encode MAGNITUDE and nothing else.
              // They used three different colour rules — availability by
              // reliability threshold, readiness always brand, source coverage
              // always neutral — so colour meant three things at once and a
              // perfect 4/4 source coverage rendered grey beside a 96/100 in
              // mint, reading as the weakest of the three. Availability's
              // verdict is already carried by the health chip next to the
              // title, which is where a semantic colour belongs.
              tone: "neutral",
            },
            {
              label: "Build readiness",
              value: readiness != null ? `${readiness} / 100` : "Not scored",
              detail: "public interface and documentation evidence",
              freshness: generatedAt ? (
                <>
                  Profile record · <TimeAgo at={generatedAt} />
                </>
              ) : (
                "Profile record unavailable"
              ),
              level: readiness != null ? readiness / 100 : null,
              tone: "neutral",
            },
            {
              label: "Source coverage",
              value: `${sourceCount} / 4`,
              detail: "website, docs, repository, dashboard",
              freshness: generatedAt ? (
                <>
                  Profile record · <TimeAgo at={generatedAt} />
                </>
              ) : (
                "Profile record unavailable"
              ),
              level: sourceCount / 4,
              tone: "neutral",
            },
          ]}
        />
      }
      footer={
        <>
          {/* #11521: icons, not icon-plus-label. Six labelled links plus two
              actions made the row read as a paragraph of navigation under a
              hero that already carries three primary actions. The name lives
              in the accessible name and the tooltip, so nothing is lost to a
              screen reader or a hover — only the visual noise. */}
          {links.map((link) => {
            const Icon = link.icon;
            const href = safeExternalUrl(link.href);
            if (!href) return null;
            return (
              <ExternalLink
                key={link.label}
                bare
                href={href}
                aria-label={link.label}
                title={link.label}
                className="mg-hero-link mg-focus-ring"
              >
                <Icon className="size-4" aria-hidden="true" />
              </ExternalLink>
            );
          })}
          <button
            type="button"
            onClick={openApiDrawer}
            aria-label="API record"
            title="API record"
            className="mg-hero-link mg-focus-ring"
          >
            <Code2 className="size-4" aria-hidden="true" />
          </button>
          <Link
            to="/subnets/$netuid"
            params={{ netuid }}
            search={{ tab: "records" }}
            hash="watch"
            aria-label="Watch, compare and share"
            title="Watch, compare & share"
            className="mg-hero-link mg-focus-ring"
          >
            <Star className="size-4" aria-hidden="true" />
          </Link>
        </>
      }
    />
  );
}
