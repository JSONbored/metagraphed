// #8249: shared between /agents and the home page's compact "For agents"
// module -- a single definition so the pre-prompt and its derived Claude/
// ChatGPT deep links can't drift into two different wordings.
export const AGENT_PROMPT =
  "Use the metagraphed Bittensor registry. First read https://api.metagraph.sh/llms.txt for the available machine surfaces, then help me find and call the right Bittensor subnet for a task. It exposes an MCP server, an agent capability catalog, semantic search, and grounded Q&A over ~129 subnets.";
export const CLAUDE_URL = `https://claude.ai/new?q=${encodeURIComponent(AGENT_PROMPT)}`;
export const CHATGPT_URL = `https://chatgpt.com/?q=${encodeURIComponent(AGENT_PROMPT)}`;
