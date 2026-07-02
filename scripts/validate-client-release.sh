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
  # The publish workflow is dispatched on --ref main, so main may have
  # advanced after release-please created the tag. Accept that only when the
  # package sources being built are byte-for-byte identical to the tagged
  # release tree; otherwise an older release tag/version could publish newer,
  # untagged code.
  if ! git merge-base --is-ancestor "$release_tag_commit" "$GITHUB_SHA" 2>/dev/null; then
    echo "::error::Release tag $release_tag ($release_tag_commit) is not an ancestor of the workflow commit $GITHUB_SHA — refusing a tag that is not on this branch's history."
    exit 1
  fi
  if ! git diff --quiet "$release_tag_commit" "$GITHUB_SHA" -- packages/client; then
    echo "::error::Release tag $release_tag ($release_tag_commit) does not match the @jsonbored/metagraphed sources at workflow commit $GITHUB_SHA; refusing to publish untagged package contents."
    exit 1
  fi
  echo "Tag $release_tag is on the workflow commit's history and package sources match; continuing."
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
