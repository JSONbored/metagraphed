import { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SankeyMini } from "@jsonbored/ui-kit";
import { ChartCard } from "@/components/metagraphed/primitives";
import { buildStakeFlowSankeyData } from "@/lib/metagraphed/chain-analytics";
import { formatTao } from "@/lib/metagraphed/format";
import type { ChainStakeFlow, GlobalValidators } from "@/lib/metagraphed/types";

const MOBILE_QUERY = "(max-width: 640px)";

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
  // Fewer nodes on mobile: the vertical layout stacks nodes side by side
  // along a ~375px width, so 10 subnets read as illegible slivers even with
  // the primitive's own label-hiding threshold — 5 keeps every shown node
  // wide enough to label.
  const { nodes, links, shownNetuids } = buildStakeFlowSankeyData(
    stakeFlow,
    validators,
    isMobile ? 5 : undefined,
    isMobile ? 5 : undefined,
  );
  const empty = shownNetuids.length === 0;

  return (
    <ChartCard
      title="Stake flow"
      caption={`Root → top ${shownNetuids.length || 0} subnets by ${window} stake movement → top validators' current stake in those subnets. The two hops are different kinds of number — flow on the left, current holdings on the right.`}
      height={isMobile ? 420 : 320}
      empty={empty}
      emptyLabel="No stake movement in this window"
    >
      <SankeyMini
        nodes={nodes}
        links={links}
        orientation={isMobile ? "vertical" : "horizontal"}
        columnExtent={isMobile ? 380 : 720}
        stackExtent={isMobile ? 340 : 300}
        formatValue={(v) => formatTao(v)}
        onNodeSelect={(nodeId) => {
          const target = resolveSankeyNode(nodeId);
          if (target) navigate({ to: target.to as never, params: target.params as never });
        }}
      />
    </ChartCard>
  );
}
