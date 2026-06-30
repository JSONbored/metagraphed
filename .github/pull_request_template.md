## Pick The Right Template

Use the matching PR template so the submission gate can classify your PR
correctly:

- [Subnet surface](?template=surface.md): one `registry/subnets/<slug>.json`
  file — a community surface added with `npm run surface:add`; for a missing
  subnet manifest, scaffold it first with `npm run subnet:new` in the same file
  (optionally plus one `registry/providers/*.json` for a debut provider).
- [Provider/operator profile](?template=provider-profile.md): one
  `registry/providers/*.json` file only.
- [Backend/code change](?template=backend-code.md): scripts, schemas,
  contracts, workflows, or registry generator logic.
- [Docs-only change](?template=docs-only.md): README or docs edits only.

For data submissions, do not edit generated `public/metagraph/**` artifacts,
native snapshots, scripts, workflows, or package files.

## Summary

-

## Template Used

-
