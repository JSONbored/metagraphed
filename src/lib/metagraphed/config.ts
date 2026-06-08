// Metagraphed API client
// Live calls only; default base https://metagraph.sh, configurable via env.

export const API_BASE =
  (import.meta.env?.VITE_METAGRAPHED_API_BASE as string | undefined)?.replace(/\/$/, "") ||
  "https://metagraph.sh";

export const GITHUB_REPO =
  (import.meta.env?.VITE_METAGRAPHED_REPO as string | undefined) ||
  "https://github.com/metagraphed/metagraphed";
