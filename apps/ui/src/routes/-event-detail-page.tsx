import { useMemo } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  EntityHero,
  Fact,
  FactSentence,
  Raw,
  TimeAgo,
  type FactCells,
  type RawRow,
} from "@jsonbored/ui-kit";
import { AppShell } from "@/components/metagraphed/app-shell";
import { RouterLink } from "@/components/metagraphed/router-link";
import {
  eventArgRows,
  eventExtrinsicHref,
  eventLabel,
} from "@/components/metagraphed/chain-detail/chain-detail-logic";
import { useRegisterApiSource } from "@/lib/metagraphed/api-source-context";
import { API_BASE } from "@/lib/metagraphed/config";
import { formatNumber, normalizeTaoUnitSpacing } from "@/lib/metagraphed/format";
import { blockChainEventsQuery } from "@/lib/metagraphed/queries";
import type { ChainEvent } from "@/lib/metagraphed/types";
import { Route } from "./events.$block.$index";

const API_PATH = "/api/v1/blocks/{block}/chain-events";

function ApiSources() {
  useRegisterApiSource([API_PATH]);
  return null;
}

/** One addressable decoded runtime event, resolved from its block record. */
export function EventDetailPage() {
  const { block, index } = Route.useParams();
  const payload = useSuspenseQuery(blockChainEventsQuery(block)).data.data;
  const event = useMemo(
    () => payload.events.find((row) => row.event_index === Number(index)) ?? null,
    [payload.events, index],
  ) as ChainEvent | null;

  // The route loader proves this record exists before rendering and seeds the
  // same query cache. This fallback keeps the component null-safe if a caller
  // renders it outside the router in a test harness.
  const resolvedBlock = event?.block_number ?? payload.block_number ?? Number(block);
  const extrinsicHref = event ? eventExtrinsicHref(event) : null;
  const label = event ? eventLabel(event) : `Event #${formatNumber(Number(index))}`;
  const summary =
    typeof event?.summary === "string" && event.summary.trim()
      ? normalizeTaoUnitSpacing(event.summary.trim())
      : null;
  const cells: FactCells = [
    {
      label: "Block",
      value: (
        <RouterLink href={`/blocks/${resolvedBlock}`}>#{formatNumber(resolvedBlock)}</RouterLink>
      ),
    },
    { label: "Event index", value: formatNumber(Number(index)) },
    {
      label: "Extrinsic",
      value: extrinsicHref ? (
        <RouterLink href={extrinsicHref}>#{formatNumber(event?.extrinsic_index ?? 0)}</RouterLink>
      ) : (
        "None"
      ),
      kind: "text",
    },
  ];

  const endpoint = `${API_BASE}${API_PATH.replace("{block}", String(resolvedBlock))}`;
  const rawRows: RawRow[] = [
    { label: "block", value: String(resolvedBlock), href: `/blocks/${resolvedBlock}` },
    { label: "event index", value: String(index) },
    ...(event?.pallet ? [{ label: "pallet", value: event.pallet }] : []),
    ...(event?.method ? [{ label: "method", value: event.method }] : []),
    ...(event?.phase ? [{ label: "phase", value: event.phase }] : []),
    ...(event?.extrinsic_index != null
      ? [
          {
            label: "extrinsic",
            value: `${resolvedBlock}-${event.extrinsic_index}`,
            ...(extrinsicHref ? { href: extrinsicHref } : {}),
          },
        ]
      : []),
    ...eventArgRows(event?.args).map((row) => ({
      label: `arg.${row.name}`,
      value: row.value,
    })),
    { label: "chain events API", value: endpoint, href: endpoint },
  ];

  return (
    <AppShell>
      <ApiSources />
      <EntityHero
        className="mg-hero--entity"
        crumbs={[
          { label: "Chain", href: "/chain" },
          { label: "Events", href: "/chain/events" },
          { label: `Block #${formatNumber(resolvedBlock)}`, href: `/blocks/${resolvedBlock}` },
        ]}
        name={label}
        action={
          extrinsicHref ? (
            <RouterLink href={extrinsicHref} className="mg-hero-action">
              Open extrinsic
            </RouterLink>
          ) : undefined
        }
        sentence={
          <FactSentence>
            {summary ??
              `Decoded as event #${formatNumber(Number(index))} in block #${formatNumber(resolvedBlock)}.`}
            {event?.phase ? <Fact>phase {event.phase}</Fact> : null}
          </FactSentence>
        }
        cells={cells}
        live={{ updatedAt: event?.observed_at ?? null, source: "chain-direct" }}
      />

      <Raw title="Decoded arguments, identifiers and API" rows={rawRows} defaultOpen />
      {event?.observed_at ? (
        <p className="mg-provenance-line">
          Chain record observed <TimeAgo at={event.observed_at} />.
        </p>
      ) : null}
    </AppShell>
  );
}
