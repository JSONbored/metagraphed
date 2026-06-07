## Summary

-

## What Changed

-

## Registry Safety

- [ ] No secrets, PATs, wallet data, private dashboards, private URLs, or
      validator-local state.
- [ ] Generated artifacts were produced by repo scripts, not hand-edited.
- [ ] R2-only/high-churn detail artifacts are not committed.
- [ ] Public API/OpenAPI/schema changes are intentional and documented.

## Validation

- [ ] `npm run check`
- [ ] `npm run validate`
- [ ] `npm run validate:schemas`
- [ ] `npm run validate:api`
- [ ] `npm run validate:openapi`
- [ ] `npm run validate:types`
- [ ] `npm run validate:artifact-budgets`
- [ ] `npm run validate:docs`
- [ ] `npm run validate:intake`
- [ ] `npm run validate:workflows`
- [ ] `npm run worker:test`
- [ ] `npm run test:coverage`
- [ ] `npm run scan:public-safety`
- [ ] `git diff --check`
