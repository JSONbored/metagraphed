# Candidate Surfaces (machine-generated only)

This directory holds **machine-generated** candidate data only. The old direct-PR
candidate lane — where a contributor ran a helper to create one
`registry/candidates/community/*.json` file per surface — is **retired and rejected by
CI**. Recreating `registry/candidates/community/*.json` fails validation; there is no
`community/` subdirectory here anymore.

`generated/public-sources.json` is the only file in this directory. It's produced by the
build pipeline from on-chain identity data (`SubnetIdentitiesV3`) and other public
sources — never hand-authored, never edited in a PR.

## Where community surface submissions go now

Surfaces live in **one file per subnet**: `registry/subnets/<slug>.json` → its
`surfaces[]` array. A community contribution appends a surface to that one file with
`npm run surface:add`, which sets `authority: "community"` and
`review.state: "community-submitted"` for you. If the subnet has no manifest yet,
scaffold it first with `npm run subnet:new`, then add the surface to that same new file.

```bash
npm run surface:add -- \
  --netuid 43 --kind subnet-api \
  --url https://api.example.com/v1 \
  --source-url https://github.com/example/project/blob/main/README.md \
  --provider <provider-slug> --submitted-by <github-login> --write
```

See [`CONTRIBUTING.md`](../../CONTRIBUTING.md)'s "Community submissions" section and
[`docs/curation-playbook.md`](../../docs/curation-playbook.md) for the full model,
allowed surface `kind`s, and validation steps
(`npm run validate:surface -- registry/subnets/<slug>.json`).

## Allowed states (generated data only)

The generated candidate entries in `generated/public-sources.json` carry one of:

- `schema-invalid`
- `schema-valid`
- `maintainer-review`
- `verified`
- `stale`
- `rejected`

Only `verified` candidates are eligible for promotion into subnet overlays under
`registry/subnets/`, and that promotion is build/maintainer-owned, not a contributor
action.
