## Summary

-

## What changed

-

## Registry safety

- [ ] No secrets, PATs, wallet data, private dashboards, private URLs, or validator-local state.
- [ ] Generated artifacts came from repo scripts, not hand-edited public JSON.
- [ ] Direct community submissions change exactly one `registry/candidates/community/*.json` or `registry/providers/community/*.json` file and no generated artifacts.
- [ ] Community-submitted interfaces pass public preflight before private gate review.
- [ ] Direct community submission files were generated with `npm run candidate:new` / `npm run provider:new` or match `docs/examples/submissions/direct-candidate.json` / `docs/examples/submissions/direct-provider-profile.json`.

## Validation

- [ ] `npm run validate`
- [ ] `npm run validate:schemas`
- [ ] `npm run validate:api`
- [ ] `npm run validate:openapi`
- [ ] `npm run validate:types`
- [ ] `npm run validate:artifact-budgets`
- [ ] `npm run validate:docs`
- [ ] `npm run validate:intake`
- [ ] `npm run validate:workflows`
- [ ] `npm run submission:pr -- --changed-files <changed-files.txt>` for direct UGC submissions
- [ ] `npm run worker:test`
- [ ] `npm run test:coverage`
- [ ] `npm run scan:public-safety`
- [ ] `git diff --check`
