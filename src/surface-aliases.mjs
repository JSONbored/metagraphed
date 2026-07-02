export const SURFACE_ALIASES_RELATIVE_PATH = "surface-aliases.json";
export const SURFACE_ALIASES_PATH = `/metagraph/${SURFACE_ALIASES_RELATIVE_PATH}`;

function surfaceId(surface) {
  return typeof surface?.surface_id === "string"
    ? surface.surface_id
    : typeof surface?.id === "string"
      ? surface.id
      : null;
}

function surfaceKey(surface) {
  return typeof surface?.surface_key === "string"
    ? surface.surface_key
    : typeof surface?.key === "string"
      ? surface.key
      : null;
}

function nullableString(value) {
  return typeof value === "string" && value ? value : null;
}

function nullableInteger(value) {
  return Number.isInteger(value) ? value : null;
}

function buildCurrentSurfaceMap(surfaces = []) {
  const byKey = new Map();
  for (const surface of Array.isArray(surfaces) ? surfaces : []) {
    const key = surfaceKey(surface);
    const id = surfaceId(surface);
    if (!key || !id) continue;
    byKey.set(key, { ...surface, id, key });
  }
  return byKey;
}

function aliasEntry({ current, deprecatedId, previous, surfaceKey: key }) {
  if (!current || !deprecatedId || deprecatedId === current.id) return null;
  return {
    deprecated_id: deprecatedId,
    surface_key: key,
    current_id: current.id,
    netuid:
      nullableInteger(current.netuid) ?? nullableInteger(previous?.netuid),
    kind: nullableString(current.kind) ?? nullableString(previous?.kind),
    url: nullableString(current.url) ?? nullableString(previous?.url),
  };
}

export function resolveSurfaceAlias(aliasArtifact, surfaceIdValue) {
  if (typeof surfaceIdValue !== "string" || !surfaceIdValue) return null;
  const aliases = Array.isArray(aliasArtifact?.aliases)
    ? aliasArtifact.aliases
    : [];
  return (
    aliases.find((entry) => entry?.deprecated_id === surfaceIdValue) || null
  );
}

export function buildSurfaceAliasArtifact({
  contractVersion,
  currentSurfaces,
  generatedAt,
  previousAliases,
  previousSurfaces,
} = {}) {
  const currentByKey = buildCurrentSurfaceMap(currentSurfaces);
  const aliasesByDeprecatedId = new Map();
  let carriedAliasCount = 0;
  let newAliasCount = 0;

  for (const previousAlias of Array.isArray(previousAliases?.aliases)
    ? previousAliases.aliases
    : []) {
    const deprecatedId = nullableString(previousAlias?.deprecated_id);
    const key = nullableString(previousAlias?.surface_key);
    if (!deprecatedId || !key) continue;
    const entry = aliasEntry({
      current: currentByKey.get(key),
      deprecatedId,
      previous: previousAlias,
      surfaceKey: key,
    });
    if (!entry) continue;
    aliasesByDeprecatedId.set(deprecatedId, entry);
    carriedAliasCount += 1;
  }

  for (const previousSurface of Array.isArray(previousSurfaces)
    ? previousSurfaces
    : []) {
    const deprecatedId = surfaceId(previousSurface);
    const key = surfaceKey(previousSurface);
    if (!deprecatedId || !key) continue;
    const entry = aliasEntry({
      current: currentByKey.get(key),
      deprecatedId,
      previous: previousSurface,
      surfaceKey: key,
    });
    if (!entry) continue;
    if (!aliasesByDeprecatedId.has(deprecatedId)) {
      newAliasCount += 1;
    }
    aliasesByDeprecatedId.set(deprecatedId, entry);
  }

  const aliases = [...aliasesByDeprecatedId.values()].sort((a, b) =>
    a.deprecated_id.localeCompare(b.deprecated_id),
  );

  return {
    schema_version: 1,
    contract_version: contractVersion || null,
    generated_at: generatedAt || null,
    source: "generated-surface-rename-aliases",
    summary: {
      alias_count: aliases.length,
      carried_alias_count: carriedAliasCount,
      new_alias_count: newAliasCount,
      previous_surface_count: Array.isArray(previousSurfaces)
        ? previousSurfaces.length
        : 0,
      current_surface_count: Array.isArray(currentSurfaces)
        ? currentSurfaces.length
        : 0,
    },
    aliases,
  };
}
