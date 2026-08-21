import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SankeyMini } from "@jsonbored/ui-kit";
import { ChartCard } from "@/components/metagraphed/primitives";
import { buildStakeFlowSankeyData } from "@/lib/metagraphed/chain-analytics";
import { formatTao } from "@/lib/metagraphed/format";
import type { ChainStakeFlow, GlobalValidators } from "@/lib/metagraphed/types";

const MOBILE_QUERY = "(max-width: 640px)";
const DESKTOP_SANKEY_LIMIT = 7;
const MOBILE_SANKEY_LIMIT = 5;

// SSR-safe viewport check, same shape as use-coarse-pointer.ts: default false
// on the server, corrected on the client after mount. A narrow-viewport
// class-toggle can't drive this — the sankey's orientation is a render prop
// (horizontal vs. vertical layout math), not a CSS visibility switch.
function useNarrowViewport(): boolean {
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const media = window.matchMedia(MOBILE_QUERY);
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return narrow;
}

function resolveSankeyNode(nodeId: string): { to: string; params: Record<string, unknown> } | null {
  if (nodeId.startsWith("subnet:") && nodeId !== "subnet:other") {
    const netuid = Number(nodeId.slice("subnet:".length));
    if (Number.isFinite(netuid)) return { to: "/subnets/$netuid", params: { netuid } };
  }
  if (nodeId.startsWith("validator:") && nodeId !== "validator:other") {
    const hotkey = nodeId.slice("validator:".length);
    return { to: "/validators/$hotkey", params: { hotkey } };
  }
  return null;
}

/**
 * The Analytics tab's centerpiece (#8378): root -> top subnets (a real
 * windowed flow, from stake-flow) -> top validators within those subnets
 * (their CURRENT stake, from the global validator leaderboard — no endpoint
 * gives windowed flow at validator granularity). The caption below says so;
 * this component doesn't pretend both columns are the same kind of number.
 */
export function ChainStakeFlowSankey({
  stakeFlow,
  validators,
  window,
}: {
  stakeFlow: ChainStakeFlow;
  validators: GlobalValidators;
  window: "7d" | "30d";
}) {
  const navigate = useNavigate();
  const isMobile = useNarrowViewport();
  // A sankey can be technically complete and still fail as a reading surface.
  // Seven desktop paths preserve comparison without a tangle of labels; the
  // vertical mobile layout narrows that to five so each path stays tappable.
  const { nodes, links, shownNetuids } = buildStakeFlowSankeyData(
    stakeFlow,
    validators,
    isMobile ? MOBILE_SANKEY_LIMIT : DESKTOP_SANKEY_LIMIT,
    isMobile ? MOBILE_SANKEY_LIMIT : DESKTOP_SANKEY_LIMIT,
  );
  const empty = shownNetuids.length === 0;

  return (
    <ChartCard
      variant="data"
      className="mg-data-module--stake-flow"
      title="Stake movement"
      caption={`Flow over ${window}, then current validator stake in the ${shownNetuids.length || 0} most active subnets. Select a node to inspect it.`}
      footer={
        <span>
          Mint and red links show movement direction; prism links keep each subnet traceable into
          its validator holdings.
        </span>
      }
      height={isMobile ? 420 : 404}
      empty={empty}
      emptyLabel="No stake movement in this window"
    >
      <div className="mg-data-plot-grid h-full">
        <SankeyMini
          nodes={nodes}
          links={links}
          className="h-full"
          orientation={isMobile ? "vertical" : "horizontal"}
          columnExtent={isMobile ? 380 : 920}
          stackExtent={isMobile ? 340 : 384}
          formatValue={(v) => formatTao(v)}
          ariaLabel="Stake movement from root through active subnets into validator holdings"
          onNodeSelect={(nodeId) => {
            const target = resolveSankeyNode(nodeId);
            if (target) navigate({ to: target.to, params: target.params });
          }}
        />
      </div>
    </ChartCard>
  );
}
