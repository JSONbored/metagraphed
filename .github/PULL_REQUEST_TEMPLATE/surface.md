## Add or update a subnet surface

This PR appends or updates surface(s) on exactly one subnet's file —
`registry/subnets/<slug>.json`.

## Surface

- Netuid:
- Kind:
- Public URL:
- Source URLs (one or more, each must prove the claim):
- Provider slug:

## Checklist

- [ ] Changes exactly one `registry/subnets/<slug>.json` file (optionally plus one
      `registry/providers/*.json` for a debut provider).
- [ ] Generated with `npm run surface:add` — lands `authority: community` and
      `review.state: community-submitted`.
- [ ] The `url` is public and safe for read-only probes; the `source_urls`
      independently prove the subnet publishes it.
- [ ] Public-safe: no auth-only/credentialed flows, secrets, wallet/PAT data,
      private URLs, private dashboards, validator internals, or generated
      `public/metagraph/**` artifacts.
- [ ] Does not duplicate an existing Metagraphed surface.
- [ ] Links a tracked issue (`Closes #<n>`).

## Gate Expectations

Public-safe surfaces can be AI-reviewed by the private Metagraphed gate and may be
merged automatically after public checks pass. Base-layer RPC/WSS/archive,
authenticated surfaces, unknown providers, and identity disputes route to manual
review.

## Validation

- [ ] `npm run validate:surface -- registry/subnets/<slug>.json`
- [ ] `npm run scan:public-safety`
