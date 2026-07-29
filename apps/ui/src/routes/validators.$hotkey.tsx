import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";
import { fallback, zodValidator } from "@tanstack/zod-adapter";
import { AppShell } from "@/components/metagraphed/app-shell";
import { EmptyState, PageHeading } from "@/components/metagraphed/states";
import { isValidSs58 } from "@/lib/metagraphed/accounts";
import { resolveAddress } from "@/lib/metagraphed/resolve-address";
import { entityNotFoundMeta } from "@/lib/metagraphed/entity-not-found-meta";
import { formatTao } from "@/lib/metagraphed/format";
import { ogImageMeta } from "@/lib/metagraphed/og-card";
import { validatorDetailQuery } from "@/lib/metagraphed/queries";
import { ValidatorDetailPage } from "./-validators-hotkey-page";

const validatorDetailSearchSchema = z.object({
  // #8251: which detail tab is active (Per-subnet performance / Nominators /
  // History) — same `tab` convention subnets.$netuid.tsx uses.
  tab: fallback(z.string(), "subnets").default("subnets"),
  window: fallback(z.enum(["7d", "30d", "90d"]), "30d").default("30d"),
  sort: fallback(z.enum(["net_staked", "gross_staked", "last_activity"]), "net_staked").default(
    "net_staked",
  ),
  limit: fallback(z.number().int().min(1).max(100), 20).default(20),
  offset: fallback(z.number().int().min(0), 0).default(0),
  coldkey: fallback(z.string(), "").default(""),
});

export const Route = createFileRoute("/validators/$hotkey")({
  validateSearch: zodValidator(validatorDetailSearchSchema),
  // #6429: validate the hotkey at the router level, matching blocks.$ref.tsx
  // (#3422) and subnets.$netuid.tsx. parseParams runs before head()/the loader,
  // so an invalid hotkey renders the real not-found boundary instead of a
  // fully-formed page whose metadata interpolates the bad param.
  parseParams: ({ hotkey }) => {
    if (!isValidSs58(hotkey)) throw notFound();
    return { hotkey };
  },
  // #8489: primes the SAME query the page's own useSuspenseQuery reads
  // (validatorDetailQuery), so head() can put real stake/subnet-count figures
  // on the OG card. Shared react-query cache means this is the request moving
  // earlier, not a second one -- the exact pattern subnets.$netuid.tsx already
  // uses. Non-fatal: any failure returns null and the card falls back to the
  // truncated-hotkey form.
  loader: async ({ context, params }) => {
    try {
      const { data } = await context.queryClient.ensureQueryData(
        validatorDetailQuery(params.hotkey),
      );
      return {
        name: data.coldkey_identity?.name ?? null,
        totalStakeTao:
          typeof data.total_stake_tao === "number" && Number.isFinite(data.total_stake_tao)
            ? data.total_stake_tao
            : null,
        subnetCount:
          typeof data.subnet_count === "number" && Number.isFinite(data.subnet_count)
            ? data.subnet_count
            : null,
      };
    } catch {
      return null;
    }
  },
  head: ({ params, loaderData }) => {
    // See accounts.$ss58.tsx: parseParams rejects a malformed hotkey, but head()
    // still runs with the raw param (the already-validating /blocks and /subnets
    // routes title invalid ids the same way today), so the not-found metadata is
    // guarded here too (#6429).
    if (!isValidSs58(params.hotkey)) {
      return entityNotFoundMeta(
        "Validator",
        "This validator identifier is not a valid Bittensor ss58 hotkey.",
      );
    }
    const label = resolveAddress(params.hotkey).display;
    return {
      meta: [
        { title: `Validator ${label} — Metagraphed` },
        {
          name: "description",
          content: `Cross-subnet performance, nominators, and staking history for Bittensor validator ${label}.`,
        },
        { property: "og:title", content: `Validator ${label} — Metagraphed` },
        {
          property: "og:description",
          content: "Cross-subnet validator performance, nominators, and staking history.",
        },
        // #8489: route-owned card (server.ts skips these paths). Prefers the
        // on-chain identity name over the truncated hotkey, and shows stake +
        // reach rather than an anonymous address.
        ...ogImageMeta({
          title: loaderData?.name || label,
          subtitle: "Cross-subnet performance, nominators, and staking history.",
          eyebrow: "Validator",
          stats: [
            ...(loaderData?.totalStakeTao != null
              ? [{ label: "Total stake", value: formatTao(loaderData.totalStakeTao) }]
              : []),
            ...(loaderData?.subnetCount != null
              ? [{ label: "Subnets", value: String(loaderData.subnetCount) }]
              : []),
          ],
        }),
      ],
    };
  },
  notFoundComponent: () => (
    <AppShell>
      <PageHeading
        eyebrow="Explorer"
        title="Invalid hotkey"
        description="Validator hotkeys must be a valid ss58 (base58) string."
      />
      <EmptyState
        title="Invalid hotkey"
        description="Use a valid validator hotkey ss58 address."
        action={{ label: "Back to validators", href: "/validators" }}
      />
    </AppShell>
  ),
  component: ValidatorDetailPage,
});
