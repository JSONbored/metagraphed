import { isUnsafeResolvedUrl } from "./lib.mjs";

// SSRF-safe GitHub API GET for candidate verification. Mirrors probeUrl /
// snapshot-adapters fetchJson: `redirect: "manual"` plus an explicit hop loop so
// a public github.com URL cannot auto-follow into a private redirect target.
export async function fetchGithubJson(url, headers = {}, redirectCount = 0) {
  if (await isUnsafeResolvedUrl(url)) {
    return {
      ok: false,
      error: "unsafe URL",
      unsafe_url: true,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "metagraphed-candidate-verifier/0.0",
        ...headers,
      },
      redirect: "manual",
      signal: controller.signal,
    });
    const location = response.headers.get("location");
    if (
      [301, 302, 303, 307, 308].includes(response.status) &&
      location &&
      redirectCount < 5
    ) {
      const redirectTarget = new URL(location, url).toString();
      if (await isUnsafeResolvedUrl(redirectTarget)) {
        await response.body?.cancel();
        return {
          ok: false,
          error: "redirect target is unsafe",
          private_redirect_blocked: true,
          status_code: response.status,
        };
      }
      await response.body?.cancel();
      return fetchGithubJson(redirectTarget, headers, redirectCount + 1);
    }

    const text = await response.text();
    return {
      ok: response.ok,
      body: text ? JSON.parse(text) : null,
      status_code: response.status,
    };
  } catch (error) {
    return {
      ok: false,
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}
