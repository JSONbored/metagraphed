import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ReleaseBudget, createReleaseStore } from "./artifact-release-store.ts";
import { readReleaseJournal } from "./artifact-release-commit.ts";
import { readImageRender, readImageSource } from "./og-image-release-files.ts";
import { planImageRelease, verifyPng } from "./og-image-release-plan.ts";
import { hashJson, sha256Hex, stableStringify } from "./lib.ts";
import { OG_IMAGE_ARTIFACT_PATH } from "../src/og-card-version.ts";
import type { ImageRenderReceipt } from "./og-image-release-plan.ts";

export function currentImageDigest(receipt: ImageRenderReceipt): string {
  const image = receipt.artifacts.find(
    (entry) => entry.path === OG_IMAGE_ARTIFACT_PATH,
  );
  if (!image)
    throw new Error("Current image path is missing from the render receipt.");
  return image.sha256;
}

export async function observeImageResponse(
  response: Response,
  expectedSha: string,
  fallbackSha: string,
  budget = new ReleaseBudget(),
) {
  const base = {
    http_status: response.status,
    cache_control: response.headers.get("cache-control"),
    cache_status: response.headers.get("cf-cache-status"),
  };
  if (
    !response.ok ||
    response.headers.get("content-type")?.split(";")[0] !== "image/png"
  ) {
    await response.body?.cancel();
    return {
      ...base,
      status: "serving-pending",
      reason: "http-or-mime",
      sha256: null,
    };
  }
  try {
    const png = await budget.read(response, 2 * 1024 * 1024);
    verifyPng(png);
    const sha256 = sha256Hex(png);
    return {
      ...base,
      status: sha256 === expectedSha ? "served" : "serving-pending",
      reason:
        sha256 === expectedSha
          ? "expected-bytes"
          : sha256 === fallbackSha
            ? "fallback"
            : "different-bytes",
      sha256,
    };
  } catch {
    return {
      ...base,
      status: "serving-pending",
      reason: "invalid-or-incomplete-png",
      sha256: null,
    };
  }
}

// One ordinary GET per invocation; a later invocation resumes the same bounded
// observation window without holding the write owner or manufacturing a new URL.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const directory = process.argv[2];
  if (!directory) throw new Error("Release bundle directory required.");
  const source = await readImageSource(directory);
  const { receipt, pngs } = await readImageRender(directory);
  const operation = planImageRelease(source, receipt, pngs);
  const observationsPath = path.join(directory, "serving.json");
  const previous = await readFile(observationsPath, "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return "[]";
    },
  );
  const observations = JSON.parse(previous) as Array<Record<string, unknown>>;
  if (
    observations.length >= 12 ||
    (observations.length &&
      Date.now() - Date.parse(String(observations[0].observed_at)) >=
        75 * 60_000)
  )
    throw new Error(
      "Serving observation budget exhausted; retained observations remain serving-pending.",
    );
  const budget = new ReleaseBudget();
  const journal = await readReleaseJournal(createReleaseStore(false, budget));
  if (journal.state !== "committed")
    throw new Error(
      "Release binding remains unresolved; resume the durable intent first.",
    );
  const fallback = await readFile(
    new URL("../public/brand/og-fallback.png", import.meta.url),
  );
  const url = "https://api.metagraph.sh/og.png";
  const response = await budget.request(url);
  const result = {
    ...(await observeImageResponse(
      response,
      currentImageDigest(receipt),
      sha256Hex(fallback),
      budget,
    )),
    url,
    observed_at: new Date().toISOString(),
    release_id: operation.id,
    binding:
      hashJson(journal.head) === hashJson(operation.target)
        ? "release-bound"
        : "superseded",
  };
  observations.push(result);
  await writeFile(observationsPath, stableStringify(observations) + "\n");
  console.log(stableStringify(result));
}
