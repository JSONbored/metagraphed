import { useState } from "react";
import { CopyableCode, SectionLabel } from "@jsonbored/ui-kit";
import { Panel, TabStrip } from "@/components/metagraphed/primitives";
import { AskBox } from "@/components/metagraphed/ask-box";
import { SearchBox } from "@/components/metagraphed/search-box";

type LiveMode = "ask" | "search";

const CURL_BY_MODE: Record<LiveMode, string> = {
  ask: `curl -s -X POST https://api.metagraph.sh/api/v1/ask \\\n  -H 'content-type: application/json' \\\n  -d '{"question":"<your question>"}'`,
  search: `curl -s "https://api.metagraph.sh/api/v1/search/semantic?q=<your query>"`,
};

/**
 * Step 3 of /agents: the live counterpart to Allways' quote widget. Their
 * card proves one thing works (a rate quote from the live orderbook); ours
 * proves the registry is queryable at all — grounded Q&A and vector search
 * over every one of the 129 subnets' 2,292 callable services, run for real
 * against the live API, not a static example.
 *
 * Ask and Search shared a page section before this redesign as two
 * independently-headed, visually equal blocks; that read as two features
 * competing for attention rather than two modes of one capability. Tabbing
 * them collapses that to a single card, matching the graded weight (one hero
 * per step) the rest of the page now uses.
 */
export function AgentLiveCard() {
  const [mode, setMode] = useState<LiveMode>("ask");

  return (
    <Panel flush>
      <div className="border-b border-border/70 px-4 pt-4 md:px-6 md:pt-6">
        <SectionLabel>Query the registry live</SectionLabel>
        <p className="mt-1 mg-type-caption-lg leading-relaxed text-ink-muted">
          Grounded answers and vector search over all 129 subnets — the same data the MCP's 204
          tools and 2,292 callable services are built on. Run a real query below.
        </p>
        <p className="mt-1 mg-type-caption text-ink-subtle-text">
          This calls the live HTTP API directly, over the network from your browser — it proves the
          registry is reachable and answering, not that a specific MCP client's handshake works. The
          response time shown is round-trip from here, not from an MCP session.
        </p>
        <TabStrip
          className="mt-4 -mb-px"
          ariaLabel="Live query mode"
          value={mode}
          onChange={setMode}
          items={[
            { id: "ask", label: "Ask" },
            { id: "search", label: "Search" },
          ]}
        />
      </div>

      <div className="p-4 md:p-6">{mode === "ask" ? <AskBox /> : <SearchBox />}</div>

      <div className="border-t border-border/70 px-4 py-3 md:px-6">
        <span className="mg-label">Same call as</span>
        <div className="mt-1.5">
          <CopyableCode
            value={CURL_BY_MODE[mode]}
            label={mode === "ask" ? "ask curl" : "search curl"}
            truncate={false}
          />
        </div>
      </div>
    </Panel>
  );
}
