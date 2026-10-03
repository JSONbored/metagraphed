/** Shared public artifact origin/identity policy. No caller credentials or
 * mutable branch, redirect, query or fragment participates in the source. */
export function publicCommitArtifactUrl(value: string, message: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "raw.githubusercontent.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !/^\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\/[0-9a-f]{40}\/[^%?#\\]+$/.test(url.pathname)
  ) throw new Error(message);
  return url.href;
}
