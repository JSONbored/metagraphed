import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { DefinitionList, Panel } from "@/components/metagraphed/primitives";
import { emissionPipelineQuery } from "@/lib/metagraphed/queries";
import {
  emissionRowState,
  gateDirection,
  ineligibleReasonLabel,
  taoChannelMix,
} from "@/lib/metagraphed/emission-pipeline";
import { formatNumber } from "@/lib/metagraphed/format";
import type { EmissionPipeline } from "@/lib/metagraphed/types";

const share = (value: number | null, digits = 3) =>
  value == null ? "—" : `${(value * 100).toFixed(digits)}%`;

const signedShare = (value: number | null) =>
  value == null ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(3)}%`;

const tao = (value: number | null) => (value == null ? "—" : `${value.toFixed(6)} τ`);

/**
 * One subnet's emission decomposition, for /subnets/{netuid} (#8745).
 *
 * The network view answers "how is block emission divided"; this answers the
 * question a subnet's own operator actually has — "how much TAO am I getting,
 * where in the pipeline did my share move, and is it arriving as pool
 * liquidity or as chain buys" — and links back to the network page for the
 * context that makes those numbers comparable.
 *
 * Renders nothing when the pipeline has no row for this netuid: a subnet the
 * capture does not cover is better represented by the panel's absence than by
 * a panel full of dashes.
 */
export function SubnetEmissionPanel({ netuid }: { netuid: number }) {
  // useQuery, not useSuspenseQuery: this panel sits inside an existing tab
  // alongside several independently-loading modules, and one shared capture
  // failing must not blank the rest of the tab. Nothing rendered while it
  // loads or fails, same as the other optional modules here.
  const { data: res } = useQuery(emissionPipelineQuery());
  if (!res) return null;
  return <SubnetEmissionPanelView pipeline={res.data} netuid={netuid} />;
}

/** The view, separated from the fetch so the rendering rules above can be
 * exercised against a fixture rather than a live capture. */
export function SubnetEmissionPanelView({
  pipeline,
  netuid,
}: {
  pipeline: EmissionPipeline;
  netuid: number;
}) {
  const subnet = pipeline.subnets.find((row) => row.netuid === netuid);
  if (!subnet) return null;

  const state = emissionRowState(subnet);
  const direction = gateDirection(subnet);
  const mix = taoChannelMix(subnet);
  const blockLabel =
    pipeline.chain_state.block == null
      ? "an unpinned capture"
      : `block ${formatNumber(pipeline.chain_state.block)}`;

  return (
    <Panel as="div">
      {/* No heading of its own: the enclosing SectionAnchor on
          /subnets/{netuid} already titles this module, and repeating it here
          rendered "Emission pipeline" twice. Only the provenance line, which
          the section subtitle does not carry, belongs at the top. */}
      <p className="mg-type-caption text-ink-muted">
        Point sample at {blockLabel} — not a window average.
      </p>

      {state === "ineligible" ? (
        <p className="mt-3 text-sm text-ink">
          This subnet is outside the emission pipeline
          {subnet.ineligible_reason
            ? ` (${ineligibleReasonLabel(subnet.ineligible_reason).toLowerCase()})`
            : ""}
          , so it has no share to compute — that is why the figures below are blank rather than
          zero.
        </p>
      ) : null}

      {state === "disabled" ? (
        <p className="mt-3 text-sm text-ink">
          Emission is <strong>disabled</strong> for this subnet on chain (
          <code className="mg-type-data">SubnetEmissionEnabled</code> is false). It receives no TAO
          by configuration — which is a different fact from competing for a share and receiving
          little.
        </p>
      ) : null}

      <DefinitionList
        className="mt-3"
        items={[
          {
            term: "Price share (stage 1)",
            detail: share(subnet.emission_share),
            title: "The published emission_share, before any gate — a price signal, not a payout.",
          },
          {
            term: "Miner burn",
            detail: share(subnet.miner_burned, 1),
          },
          {
            term: "Post-burn weighted share",
            detail: share(subnet.weighted_share),
          },
          {
            term: "Post-gate share",
            detail: share(subnet.gated_share),
          },
          {
            term: "Final share of block emission",
            detail: share(subnet.final_share),
          },
          {
            term:
              direction === "gained"
                ? "Share gained by the pipeline"
                : direction === "lost"
                  ? "Share lost to the pipeline"
                  : "Share moved by the pipeline",
            detail: signedShare(subnet.gate_delta),
            title: "Final share minus price share.",
          },
          {
            term: "Distance to the gate bar",
            detail: subnet.distance_to_bar == null ? "—" : `${subnet.distance_to_bar.toFixed(3)}×`,
          },
        ]}
      />

      <div className="mt-4">
        <h3 className="mg-type-label text-ink-muted">Where the TAO arrives</h3>
        <DefinitionList
          className="mt-2"
          items={[
            { term: "Pool liquidity injection", detail: tao(subnet.tao_in_emission) },
            { term: "Chain buys", detail: tao(subnet.excess_tao) },
            { term: "Total per block", detail: tao(subnet.tao_total) },
            {
              term: "Pool fraction",
              detail:
                mix === "chain-buys-only"
                  ? "0% — all of it arrives as chain buys"
                  : share(subnet.liquidity_fraction, 1),
            },
          ]}
        />
        {/* The presentation rule that motivated this panel: zero on the pool
            channel with a positive excess is a subnet RECEIVING TAO, and must
            never read as receiving nothing. */}
        {mix === "chain-buys-only" ? (
          <p className="mt-2 mg-type-caption text-ink-muted">
            No pool liquidity injection at this block — the TAO above is still being received, as
            chain buys.
          </p>
        ) : null}
      </div>

      <p className="mt-4 mg-type-caption text-ink-muted">
        Every share here is reconstructed from chain storage rather than read directly; the chain
        publishes the pipeline&apos;s inputs, not its output.{" "}
        <Link to="/chain/emissions" className="text-accent hover:underline mg-focus-ring">
          See the network-wide decomposition
        </Link>{" "}
        for the gate parameters and how this subnet compares.
      </p>
    </Panel>
  );
}
