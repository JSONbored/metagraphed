# High Score — Update PR Overlap Checks

This file is a **supplement** to the canonical workflow in:

- `AGENTS.md`
- `.claude/skills/metagraphed/SKILL.md`
- `.claude/skills/metagraphed/reference.md`

Use these commands only for duplicate-surface overlap detection before submitting an update PR.

## Duplicate-path pre-flight (open PRs)

```bash
for pr in $(gh api 'repos/JSONbored/metagraphed/pulls?state=open' --paginate --jq '.[].number'); do
  echo "#${pr}"
  gh api repos/JSONbored/metagraphed/pulls/$pr/files --paginate --jq '.[].filename'
  echo
done
```

## Scoped subnet overlap check

If your target is `registry/subnets/<slug>.json`, confirm no open PR touches that same file:

```bash
TARGET="registry/subnets/<slug>.json"
for pr in $(gh api 'repos/JSONbored/metagraphed/pulls?state=open' --paginate --jq '.[].number'); do
  if gh api repos/JSONbored/metagraphed/pulls/$pr/files --paginate --jq ".[].filename" | grep -Fxq "$TARGET"; then
    echo "Overlap detected: PR #$pr touches $TARGET"
  fi
done
```
