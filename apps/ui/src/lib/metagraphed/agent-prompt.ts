// #8249: shared between /agents and the home page's compact "For agents"
// module -- a single definition so the pre-prompt and its derived Claude/
// ChatGPT deep links can't drift into two different wordings.
export const AGENT_PROMPT =
  "Use the metagraphed Bittensor registry. First read https://api.metagraph.sh/llms.txt for the available machine surfaces, then help me find and call the right Bittensor subnet for a task. It exposes an MCP server, an agent capability catalog, semantic search, and grounded Q&A over ~129 subnets.";
export const CLAUDE_URL = `https://claude.ai/new?q=${encodeURIComponent(AGENT_PROMPT)}`;
export const CHATGPT_URL = `https://chatgpt.com/?q=${encodeURIComponent(AGENT_PROMPT)}`;

/**
 * #8382: /agents' post-connect "first prompt" walkthrough -- three of the
 * four playbooks in agent-playbook-grid.tsx (content/docs/playbooks/),
 * rephrased as a literal prompt to paste into an already-connected agent
 * rather than a link to the executed-transcript doc page. Deliberately three,
 * not all four (the issue's own number) -- "audit an account's history" is
 * the least generically demonstrable of the four without a specific address
 * already in hand, so it's left for the playbook grid itself to surface.
 */
export interface FirstPrompt {
  prompt: string;
  whatYouGet: string;
}

export const FIRST_PROMPTS: readonly FirstPrompt[] = [
  {
    prompt:
      "Evaluate subnet 7 before I stake into it — health, economics, and stake concentration.",
    whatYouGet:
      "A read on whether a subnet is healthy and how concentrated its stake is, before you commit.",
  },
  {
    prompt:
      "How is validator hotkey 5FHneW... doing? Current standing, 30-day trend, and who's staking to it.",
    whatYouGet: "A validator's current standing and trend, plus its nominator breakdown.",
  },
  {
    prompt:
      "I need a subnet that does image generation over an HTTP API — find one and show me how to call it.",
    whatYouGet:
      "A specific callable service matched to your task, with the actual request to make.",
  },
] as const;
