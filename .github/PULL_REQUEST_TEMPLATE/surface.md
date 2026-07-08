## Add or update a subnet surface

This PR appends or updates surface(s) on exactly one subnet manifest —
`registry/subnets/<slug>.json`. If the manifest did not exist on the base
branch, this PR may include the required `subnet:new` scaffold fields in that
same new file.

## Surface

- Netuid:
- Kind:
- Public URL:
- Source URL (proves the claim):
- Provider slug:

## Checklist

- [ ] Changes exactly one `registry/subnets/<slug>.json` file: append-only for an
      existing manifest, or a `subnet:new` scaffold plus surface(s) for a missing
      manifest (optionally plus one `registry/providers/*.json` for a debut
      provider).
- [ ] Generated with `npm run surface:add` — lands `authority: community` and
      `review.state: community-submitted`.
- [ ] The `url` is public and safe for read-only probes; the `source_url`
      independently proves the subnet publishes it.
- [ ] Public-safe: no auth-only/credentialed flows, secrets, wallet/PAT data,
      private URLs, private dashboards, validator internals, or generated
      `public/metagraph/**` artifacts.
- [ ] Does not duplicate an existing Metagraphed surface.
- [ ] Links a tracked issue that is still OPEN (`Closes #<n>`) — a closed or missing link is an automatic close.

## Gate Expectations

Public-safe surfaces can be AI-reviewed by the private Metagraphed gate and may be
merged automatically after public checks pass. Base-layer RPC/WSS/archive,
authenticated surfaces, unknown providers, and identity disputes route to manual
review.

## Validation

- [ ] `npm run validate:surface -- registry/subnets/<slug>.json`
- [ ] `npm run scan:public-safety`
