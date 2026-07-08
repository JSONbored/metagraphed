## Docs Change

## Summary

-

## Checklist

- [ ] Links a tracked, currently-open issue (`Closes #<n>`) — required.
- [ ] This PR changes docs/templates only.
- [ ] No generated `public/metagraph/**` artifacts are included.
- [ ] No private research notes, local paths, secrets, wallet/PAT data, private
      URLs, or validator internals are included.
- [ ] Any referenced API route or artifact path exists in the current backend
      contracts.

## Validation

- [ ] `npm run validate:docs`
- [ ] `npm run validate:intake`
- [ ] `npm run scan:public-safety`
- [ ] `git diff --check`
