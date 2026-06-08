// Metagraphed API client
// Live calls only; default base https://metagraph.sh, configurable via env.

const env = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env;

export const API_BASE =
  (env?.VITE_METAGRAPH_API_BASE ||
    env?.VITE_METAGRAPHED_API_BASE ||
    "https://metagraph.sh"
  ).replace(/\/$/, "");

export const GITHUB_REPO =
  env?.VITE_METAGRAPHED_REPO || "https://github.com/metagraphed/metagraphed";
