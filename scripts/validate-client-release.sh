#!/usr/bin/env bash
# Gate the @metagraphed/client npm release: run from main, read the version from
# packages/client/package.json, require strict semver, and refuse if the git tag
# or the npm version already exists. Mirrors the awesome-claude MCP release gate.
set -euo pipefail

if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::@metagraphed/client releases must run from main."
  exit 1
fi
if [ -z "${GITHUB_OUTPUT:-}" ]; then
  echo "::error::GITHUB_OUTPUT is required."
  exit 1
fi

release_version="$(node -p "require('./packages/client/package.json').version")"
if ! printf '%s' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "::error::packages/client/package.json version must be strict semver without a v prefix."
  exit 1
fi

release_tag="client-v$release_version"
if git rev-parse "$release_tag" >/dev/null 2>&1; then
  echo "::error::Release tag already exists: $release_tag"
  exit 1
fi
if npm view "@metagraphed/client@$release_version" version >/dev/null 2>&1; then
  echo "::error::npm version already exists: @metagraphed/client@$release_version"
  exit 1
fi

{
  echo "version=$release_version"
  echo "tag=$release_tag"
} >> "$GITHUB_OUTPUT"
echo "Releasing @metagraphed/client@$release_version (tag $release_tag)."
