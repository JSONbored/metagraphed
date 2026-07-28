import { useState, type ComponentType } from "react";
import { Code2, Plug } from "lucide-react";
import { CopyButton, ClaudeIcon, OpenAIIcon } from "@jsonbored/ui-kit";
import { TabStrip } from "@/components/metagraphed/primitives";
import { classNames } from "@/lib/metagraphed/format";
import { captureEvent } from "@/lib/analytics";
import { buildHarnessConfig, HARNESSES, type HarnessId } from "@/lib/metagraphed/agent-harness";
import type { AgentResources } from "@/lib/metagraphed/types";

// ClaudeIcon/OpenAIIcon are plain SVG components, not lucide's
// ForwardRefExoticComponent -- widen to the common shape both families
// actually accept rather than typing this against either one specifically.
const HARNESS_ICON: Record<
  HarnessId,
  ComponentType<{ className?: string; "aria-hidden"?: boolean }>
> = {
  "claude-code": ClaudeIcon,
  "claude-desktop": ClaudeIcon,
  cursor: Code2,
  chatgpt: OpenAIIcon,
  "generic-mcp": Plug,
};

/**
 * #8382: replaces the single hardcoded `mcp.install` command with a picker
 * across every harness the issue names. Every tab's config is derived from
 * the same `mcp` the page already fetches (buildHarnessConfig) — switching
 * tabs never re-fetches anything, it's a pure render of already-live data.
 */
export function AgentHarnessPicker({ mcp }: { mcp: AgentResources["mcp"] }) {
  const [harness, setHarness] = useState<HarnessId>("claude-code");
  const active = HARNESSES.find((h) => h.id === harness);
  const config = buildHarnessConfig(harness, mcp);

  return (
    <div>
      <TabStrip
        ariaLabel="MCP client"
        size="sm"
        className="overflow-x-auto"
        value={harness}
        onChange={(id) => {
          setHarness(id);
          captureEvent("agent_harness_selected", { harness: id });
        }}
        items={HARNESSES.map((h) => {
          const Icon = HARNESS_ICON[h.id];
          return {
            id: h.id,
            label: (
              <span className="inline-flex items-center gap-1.5">
                <Icon className="size-3.5" aria-hidden />
                {h.label}
              </span>
            ),
          };
        })}
      />

      <p className="mt-3 mg-type-caption text-ink-muted">{active?.blurb}</p>

      <div className="mt-3">
        {config.kind === "steps" ? (
          <ol className="list-inside list-decimal space-y-1.5 mg-type-caption text-ink-muted">
            {config.steps?.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        ) : (
          <div className="rounded-md border border-accent/30 bg-accent-surface p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="mg-type-caption text-ink-muted">{config.label}</span>
              <div
                onClick={() => captureEvent("agent_harness_config_copied", { harness })}
                className="shrink-0"
              >
                <CopyButton value={config.content ?? ""} label={`${config.label} config`} compact />
              </div>
            </div>
            <pre
              className={classNames(
                "mt-1 overflow-x-auto whitespace-pre font-mono mg-type-caption text-ink-strong",
                config.kind === "json" && "whitespace-pre-wrap break-all",
              )}
            >
              {config.content}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
