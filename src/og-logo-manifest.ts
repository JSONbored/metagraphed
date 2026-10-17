import generatedManifest from "../apps/ui/public/logos/display/manifest.json" with { type: "json" };
import { isOgLogoSourcePath } from "./og-logo-path.ts";
export { isOgLogoSourcePath } from "./og-logo-path.ts";

const ORIGIN = "https://metagraph.sh";
const HASH = /^[a-f0-9]{64}$/;
const PNG = [137, 80, 78, 71, 13, 10, 26, 10];

export interface OgLogoAsset {
  intent: "expected";
  qualified: true;
  sourcePath: string;
  identity: string;
  path: string;
  url: string;
  sha256: string;
  bytes: number;
}

export type OgLogoResolution =
  | { intent: "absent" }
  | { intent: "expected"; qualified: false; sourcePath: string | null }
  | OgLogoAsset;

export type OgLogoManifest = ReadonlyMap<string, OgLogoAsset>;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Only complete sharing manifests can name an immutable rendered card. */
export function parseLogoManifest(value: unknown): OgLogoManifest | null {
  const manifest = record(value);
  const policy = record(manifest?.sharing);
  if (
    manifest?.version !== 2 ||
    policy?.version !== 1 ||
    policy.format !== "png" ||
    policy.max_dimension !== 256 ||
    policy.max_bytes !== 524288 ||
    !Array.isArray(manifest.entries)
  )
    return null;
  const entries = new Map<string, OgLogoAsset>();
  const sharingContracts = new Map<string, string>();
  for (const raw of manifest.entries) {
    const entry = record(raw);
    if (
      !entry ||
      typeof entry.source_path !== "string" ||
      !isOgLogoSourcePath(entry.source_path) ||
      typeof entry.source_sha256 !== "string" ||
      !HASH.test(entry.source_sha256) ||
      typeof entry.sharing_sha256 !== "string" ||
      !HASH.test(entry.sharing_sha256) ||
      entry.sharing_path !==
        `sharing/v1/${entry.source_sha256}-${entry.sharing_sha256}.png` ||
      !Number.isSafeInteger(entry.sharing_bytes) ||
      Number(entry.sharing_bytes) < PNG.length ||
      Number(entry.sharing_bytes) > policy.max_bytes ||
      !Number.isSafeInteger(entry.sharing_width) ||
      Number(entry.sharing_width) < 1 ||
      Number(entry.sharing_width) > policy.max_dimension ||
      !Number.isSafeInteger(entry.sharing_height) ||
      Number(entry.sharing_height) < 1 ||
      Number(entry.sharing_height) > policy.max_dimension
    )
      return null;
    const sourcePath = `/logos/${entry.source_path}`;
    if (entries.has(sourcePath)) return null;
    const path = `/logos/${entry.sharing_path}`;
    const contract = JSON.stringify([
      entry.sharing_bytes,
      entry.sharing_width,
      entry.sharing_height,
    ]);
    const prior = sharingContracts.get(path);
    if (prior !== undefined && prior !== contract) return null;
    sharingContracts.set(path, contract);
    const asset: OgLogoAsset = {
      intent: "expected",
      qualified: true,
      sourcePath,
      identity: path,
      path,
      url: ORIGIN + path,
      sha256: entry.sharing_sha256,
      bytes: Number(entry.sharing_bytes),
    };
    entries.set(sourcePath, asset);
    entries.set(path, asset);
  }
  return entries;
}

const generated = parseLogoManifest(generatedManifest);

/** Resolve before cache lookup. A declared but unavailable logo stays expected. */
export function resolveOgLogo(
  input: string | null | undefined,
  manifest: unknown = generatedManifest,
): OgLogoResolution {
  if (!input?.trim()) return { intent: "absent" };
  let sourcePath: string | null = null;
  try {
    const url = new URL(input, ORIGIN);
    if (
      url.origin !== ORIGIN ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return { intent: "expected", qualified: false, sourcePath };
    sourcePath = url.pathname;
  } catch {
    return { intent: "expected", qualified: false, sourcePath };
  }
  const entries =
    manifest === generatedManifest ? generated : parseLogoManifest(manifest);
  return (
    entries?.get(sourcePath) ?? {
      intent: "expected",
      qualified: false,
      sourcePath,
    }
  );
}

/** A valid MIME/header alone cannot complete a card with stale asset bytes. */
export async function verifyOgLogo(
  logo: { bytes: ArrayBuffer; contentType: string } | null,
  resolution: OgLogoResolution,
): Promise<boolean> {
  if (
    !logo ||
    resolution.intent !== "expected" ||
    !resolution.qualified ||
    logo.contentType.split(";")[0].trim().toLowerCase() !== "image/png" ||
    logo.bytes.byteLength !== resolution.bytes
  )
    return false;
  const bytes = new Uint8Array(logo.bytes);
  if (!PNG.every((value, index) => bytes[index] === value)) return false;
  try {
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const digest = Array.from(new Uint8Array(hash), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
    return digest === resolution.sha256;
  } catch {
    return false;
  }
}
