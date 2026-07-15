# ADR 0019 — Native staking origin: path on the main domain, not a dedicated subdomain; CSP forward-compat note

- **Status:** Accepted
- **Date:** 2026-07-15
- **Relates to:** #5249 (the issue this ADR resolves), #5229 (native staking &
  delegation epic), ADR 0018 (wallet standard + broadcast path this decision
  builds on)

## Context

#5249 asked two questions before the staking surface is considered
launch-ready:

1. Should staking live at a dedicated, bookmarkable origin (e.g.
   `stake.metagraph.sh`) instead of a path on the main app (`metagraph.sh`)?
   Typosquatting of Web3/DeFi brands is a real, active attack pattern, and a
   distinct origin is the standard mitigation several comparable protocols
   use (`app.uniswap.org`, `stake.lido.fi`).
2. Does metagraphed's Content-Security-Policy need anything special for
   wallet-extension (`@polkadot/extension-dapp`) communication to keep
   working?

Checked the live production response headers (`metagraph.sh`, 2026-07-14) to
answer both from what's actually deployed, not assumption:

```
$ curl -sI https://metagraph.sh/
x-frame-options: DENY
strict-transport-security: max-age=15552000; includeSubDomains
x-content-type-options: nosniff
permissions-policy: geolocation=(), microphone=(), camera=()
referrer-policy: strict-origin-when-cross-origin
```

**No `Content-Security-Policy` header is deployed at all today** — confirmed
by both this response and a repo-wide search (no CSP directive anywhere in
`apps/ui/`, `workers/`, or `wrangler.jsonc`). Question 2 is therefore not
"review an existing CSP" — it's "there is nothing to conflict with today; make
sure a future CSP doesn't quietly break staking."

## Decision

### 1. Origin: a path on the main domain (`metagraph.sh/validators/$hotkey`), not a dedicated subdomain

The deciding factor is `@polkadot/extension-dapp`'s trust model, not ops
overhead (a new Cloudflare custom-domain route to the same Worker would be
cheap either way). Wallet-extension access is granted **per origin** — an
extension asks the user to approve a specific site, and `window.injectedWeb3`
is only populated on origins the user has approved. Splitting staking onto
`stake.metagraph.sh` would force every user to grant wallet access **twice**:
once for whatever origin they first connect on, and again the first time they
reach the staking subdomain — a real, concrete UX tax with no corresponding
security gain, since:

- The stake/unstake and take-management flows are Sheet **overlays** on an
  existing page (`validators.$hotkey.tsx`), not a standalone app — moving
  just the overlay to another origin means either a jarring full-page
  navigation away from the validator context, or a cross-origin iframe (which
  itself would need to separately negotiate extension access and adds new
  `postMessage`/framing complexity this repo doesn't need).
- A distinct origin doesn't meaningfully raise the bar against the
  typosquatting risk that motivated this issue: an attacker cloning
  `metagraph.sh` can equally well clone `stake.metagraph.sh`, or register a
  lookalike domain like `metagraph-stake.sh`. Users still have to verify the
  root domain either way; a second legitimate-looking origin doesn't reduce
  that burden, and training users to trust "a second domain near the one I
  know" is the exact pattern typosquatting exploits.
- The origin-isolation benefit a subdomain would buy (a compromised script
  elsewhere on the site can't touch the signing surface's `localStorage`/JS
  context) is real but achievable more cheaply via CSP scoping (§2) without
  the wallet-reapproval cost.

This is revisitable if native staking ever becomes a large enough standalone
product to justify its own origin and its own wallet-connect flow from
scratch — not a decision to treat as permanent.

### 2. CSP forward-compatibility: `connect-src` must include every RPC endpoint if a CSP is ever added

No CSP exists today, so nothing is broken right now. But if a future,
unrelated hardening effort adds one (a reasonable step — `x-frame-options`,
HSTS, and `permissions-policy` are already in place; CSP is the natural next
one), it must not silently break native staking. Two concrete requirements
for whoever writes that CSP:

- **`connect-src` must include every entry in
  `TRUSTED_RPC_UPSTREAM_ORIGINS`** (`workers/config.mjs:425-440`) — both the
  `https://` and `wss://` forms. `@polkadot/api`'s `WsProvider`
  (`chain-connection.ts`'s `getApi()`) opens a genuine WebSocket connection
  **from the page's own JS**, which `connect-src` does govern. Omitting even
  one entry doesn't break staking outright (only one origin is used per
  connection, `DEFAULT_RPC_ENDPOINT`), but it would silently break the
  documented fallback path if `getApi()` is ever extended to try alternate
  endpoints.
- **No special allowance is needed for the wallet extension's own
  `postMessage` communication.** Browser extension content scripts run in an
  isolated JS world per the WebExtensions spec — they are not subject to the
  host page's CSP at all, and `window.postMessage` between same-window
  contexts isn't a `connect-src`-governed "connection" in the CSP sense
  either way. This was the open question §2 of #5249 asked; the answer is
  that CSP and extension-injection are simply orthogonal, not that CSP needs
  a wallet-specific carve-out.

## Consequences

- No code or infrastructure change ships with this ADR — it's a decision
  record for #5249's two deliverables, both of which turned out to resolve
  to "no action needed now, but here's the constraint for later."
- If/when a CSP is added to `metagraph.sh` (tracked as future, unscoped
  hardening work, not part of this epic), its `connect-src` must be checked
  against `TRUSTED_RPC_UPSTREAM_ORIGINS` before shipping, or native staking
  breaks silently (a hung "Connecting…" state, not an obvious error, since a
  blocked WebSocket handshake doesn't throw a catchable JS error the way a
  blocked `fetch` does).
- The dedicated-subdomain question is closed for v1 but not permanently —
  revisit if the wallet-extension per-origin friction argument no longer
  holds (e.g. if native staking becomes a standalone product with its own
  connect flow) or if a real phishing incident targeting metagraphed
  specifically occurs.

## Links/resources

- `workers/config.mjs:425-440` (`TRUSTED_RPC_UPSTREAM_ORIGINS`, the exact set
  any future CSP's `connect-src` must cover)
- `apps/ui/src/lib/metagraphed/chain-connection.ts` (`getApi()`'s `WsProvider`
  connection — the CSP-governed surface)
- MDN, "Content scripts" (WebExtensions) — isolated-world execution model,
  the basis for §2's "no special CSP carve-out needed" conclusion
- ADR 0018 §2 (broadcast path this ADR's origin decision sits alongside)
