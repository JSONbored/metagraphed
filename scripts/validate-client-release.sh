#!/usr/bin/env bash
# Gate the @jsonbored/metagraphed npm release: run from main, read the version from
# packages/client/package.json, require strict semver, and refuse if the git tag
# or the npm version already exists. Mirrors the awesome-claude MCP release gate.
set -euo pipefail

if [ "${GITHUB_REF:-}" != "refs/heads/main" ]; then
  echo "::error::@jsonbored/metagraphed releases must run from main."
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
release_tag_commit=""
if release_tag_commit="$(git rev-parse "$release_tag^{commit}" 2>/dev/null)"; then
  if [ "${RELEASE_PLEASE_TRIGGERED:-}" != "true" ]; then
    echo "::error::Release tag already exists: $release_tag"
    exit 1
  fi

  if [ -z "${GITHUB_SHA:-}" ]; then
    echo "::error::GITHUB_SHA is required for release-please-triggered releases."
    exit 1
  fi
  if [ "$release_tag_commit" != "$GITHUB_SHA" ]; then
    echo "::error::Release tag $release_tag points to $release_tag_commit, not the workflow commit $GITHUB_SHA."
    exit 1
  fi
  echo "Tag $release_tag exists and points to the workflow commit; continuing."
elif [ "${RELEASE_PLEASE_TRIGGERED:-}" = "true" ]; then
  echo "::error::Release tag is required for release-please-triggered releases: $release_tag"
  exit 1
fi
if npm view "@jsonbored/metagraphed@$release_version" version >/dev/null 2>&1; then
  echo "::error::npm version already exists: @jsonbored/metagraphed@$release_version"
  exit 1
fi

{
  echo "version=$release_version"
  echo "tag=$release_tag"
} >> "$GITHUB_OUTPUT"
echo "Releasing @jsonbored/metagraphed@$release_version (tag $release_tag)."
