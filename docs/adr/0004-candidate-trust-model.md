# ADR 0004 — Candidate → verified-surface trust model

Status: accepted (2026-06-12)

## Context

metagraphed hands agents **base URLs to call**. The highest-consequence failure
for an integration developer is a malicious `base_url` served as "callable" — the
agent calls it and leaks credentials, gets injected, or reaches internal infra.

URLs enter the system from progressively less-trusted sources:

1. **Native chain identity** (`SubnetIdentitiesV3`: `subnet_url`, `github_repo`,
   `discord`, `logo_url`) — set by whoever controls the subnet's hotkey.
   Permissionless and attacker-controllable, on both mainnet and testnet.
2. **Public discovery** (`scripts/discover-candidates.mjs`) — harvested from the
   chain identity above plus README links and third-party directories
   (taostats, taomarketcap, subnetradar, tensorplex docs).
3. **Community intake** — UGC submissions under `registry/candidates/community/`.
4. **Curated overlays** — maintainer-reviewed, the only tier the product treats
   as a verified surface.

Everything in tiers 1–3 is a **candidate**: explicitly "not verified by
Metagraphed; requires safe probe verification and maintainer review before
promotion." The trust boundary is **promotion to a curated overlay**.

## Decision

**Auto-harvested base URLs are never served as `callable` without crossing the
promotion boundary.** Callability (`eligibility.callable` in the agent-catalog,
`public_safe` surfaces) is derived only from curated-overlay surfaces — not from
raw candidates. Candidates surface under explicitly-labelled
`*/candidates/*` artifacts, never under `/agent-catalog`, `/surfaces`, or as a
`how_do_i_call` answer.

Three guards defend the path from attacker-controlled text to a callable URL:

### 1. Prompt-injection sanitization (ADR 0003 / #339)

All chain text is run through `sanitizeChainText` before it reaches an LLM, and
the profile carries `injection_scrubbed`. The MCP tools + `llms.txt` additionally
warn that field values are untrusted data (#340).

### 2. SSRF protection (DNS-resolving)

`isUnsafeUrl` / `isUnsafeResolvedUrl` (`scripts/lib.mjs`) reject URLs that target
internal infrastructure, checking against `unsafeIpBlocks`:
loopback (`127.0.0.0/8`, `::1`), RFC-1918 private (`10/8`, `172.16/12`,
`192.168/16`), CGNAT (`100.64/10`), **link-local + cloud metadata
(`169.254.0.0/16`, e.g. `169.254.169.254`)**, the unspecified range, multicast,
and the IPv6 equivalents (`fc00::/7`, `fe80::/10`, NAT64).

- **Intake** (`normalizePublicUrl`) applies the synchronous literal-IP filter
  `isUnsafeUrl` so obviously-internal targets never enter the bundle.
- **Probe + promotion** (`fetchWithSafeRedirects`, `generated-overlays.mjs`)
  apply `isUnsafeResolvedUrl`, which **resolves DNS and re-checks every resolved
  address** — defeating DNS-rebinding and redirect-to-internal.
- Known limitation: intake is hostname-based; the authoritative resolve-time
  check is what gates anything that gets probed or promoted.

### 3. Brand-impersonation guard (#341)

`isBrandImpersonationUrl` rejects candidate URLs that impersonate metagraphed's
own domain (`metagraph.sh.evil.com`, `metagraphsh.com`, `metagraph-sh.io`). These
pass the SSRF guard — they resolve to public IPs — but a `base_url` reading as
"metagraph.sh" could get an agent to trust and call it. The real `metagraph.sh`
and its subdomains are exempt; the rule targets squats of the exact domain, not
the generic "metagraph" Bittensor term.

## Consequences

- Before **broadening auto-promotion** (auto-probing candidates into callable
  surfaces), revisit this ADR: at minimum keep the resolve-time SSRF check, the
  impersonation guard, and a maintainer-review step in the promotion path; add
  per-source trust weighting (chain-identity < README < curated) before any
  candidate is auto-promoted.
- The guards are best-effort against a determined attacker who controls a benign
  public domain that later turns malicious — promotion review remains the
  backstop.
- New trusted-infra domains worth impersonation protection (beyond
  `metagraph.sh`) can be added to `isBrandImpersonationUrl` as the surface grows.
