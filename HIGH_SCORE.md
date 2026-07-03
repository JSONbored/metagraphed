# HIGH_SCORE

This file is a small overlap-check supplement to the canonical contributor flow:

- `AGENTS.md`
- `.claude/skills/metagraphed/SKILL.md`
- `.claude/skills/metagraphed/reference.md`

Use only the commands below to detect overlapping edits before opening or updating a PR.

## Duplicate-path overlap (open PRs)

```bash
for pr in $(gh api "repos/JSONbored/metagraphed/pulls?state=open" --paginate --jq ".[].number"); do
  echo "#${pr}"
  gh api "repos/JSONbored/metagraphed/pulls/${pr}/files" --paginate --jq ".[].filename"
  echo
done
```

## Scoped subnet overlap (single-file subnet updates)

If your target is `registry/subnets/<slug>.json`, confirm no open PR touches that same file:

```bash
TARGET="registry/subnets/<slug>.json"
for pr in $(gh api "repos/JSONbored/metagraphed/pulls?state=open" --paginate --jq ".[].number"); do
  if gh api "repos/JSONbored/metagraphed/pulls/${pr}/files" --paginate --jq ".[].filename" \
    | grep -Fxq "$TARGET"; then
    echo "Overlap detected: PR #${pr} touches ${TARGET}"
  fi
done
```

## OpenPR limit awareness

The maintainer gate enforces strict close/review rules (including open-PR limits), so always check the active queue before starting or refreshing a PR.

```bash
gh pr list --state open --json number,title,updatedAt
```
