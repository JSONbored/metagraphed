import { CopyButton } from "@jsonbored/ui-kit";
import { Panel } from "@/components/metagraphed/primitives";
import { captureEvent } from "@/lib/analytics";
import { FIRST_PROMPTS } from "@/lib/metagraphed/agent-prompt";

/**
 * Step 4 of /agents: the post-connect payoff — a prompt to paste into the
 * client just wired up in step 2, not another link to read. Renders the
 * prompt as normally-wrapping prose rather than reusing CopyableCode, whose
 * `break-all` wrap is meant for unbreakable strings (URLs, commands) and
 * mid-word-breaks a real sentence. Copying is the whole interaction, so the
 * click is tracked on the wrapper (fires regardless of clipboard outcome,
 * same as agent-harness-picker's copy tracking — the intent to copy is the
 * signal worth counting).
 */
export function FirstPromptWalkthrough() {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {FIRST_PROMPTS.map((p, i) => (
        <Panel key={i} flush className="flex min-w-0 flex-col">
          <div className="flex flex-1 items-start justify-between gap-2 p-4">
            <p className="min-w-0 mg-type-caption-lg leading-relaxed text-ink-strong">
              &ldquo;{p.prompt}&rdquo;
            </p>
            <div
              className="shrink-0"
              onClick={() => captureEvent("agent_first_prompt_copied", { index: i })}
            >
              <CopyButton value={p.prompt} label="Prompt" compact />
            </div>
          </div>
          <p className="border-t border-border/70 px-4 py-3 mg-type-caption text-ink-muted">
            {p.whatYouGet}
          </p>
        </Panel>
      ))}
    </div>
  );
}
