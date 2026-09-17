import { writeFile } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  bootstrapReleaseJournal,
  commitArtifactRelease,
  jsonBytes,
  releaseJournalActive,
  resumeArtifactRelease,
} from "./artifact-release-commit.ts";
import { createReleaseStore, ReleaseBudget } from "./artifact-release-store.ts";
import {
  captureImageSource,
  readImageRender,
  readImageSource,
  writeImageSource,
} from "./og-image-release-files.ts";
import { planImageRelease } from "./og-image-release-plan.ts";
import { renderImageRelease } from "./og-image-render.ts";
import { hashJson, repoRoot, stableStringify } from "./lib.ts";

const args = process.argv.slice(2);
const mode = args[0] ?? "plan";
const directory = args[1];
if (
  !["capture", "render", "plan", "publish", "bootstrap", "resume"].includes(
    mode,
  )
)
  throw new Error("Unknown image release mode.");
const budget = new ReleaseBudget();
if (mode === "bootstrap") {
  await bootstrapReleaseJournal(
    createReleaseStore(true, budget),
    directory ?? "",
  );
  console.log(
    stableStringify({
      status: "journal-activated",
      expected_pointer_hash: directory,
    }),
  );
} else if (mode === "resume") {
  const result = await resumeArtifactRelease(createReleaseStore(true, budget));
  console.log(stableStringify(result));
  if (result.status === "pointer-pending") process.exitCode = 2;
} else {
  if (!directory)
    throw new Error(
      "Explicit release bundle directory required (default plan mode never performs network requests).",
    );
  if (mode === "capture") {
    const source = await captureImageSource(createReleaseStore(false, budget));
    await writeImageSource(directory, source);
    console.log(
      stableStringify({
        status: "captured",
        pointer_hash: hashJson(source.pointer),
      }),
    );
  } else {
    const source = await readImageSource(directory);
    if (mode === "render") {
      const revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoRoot,
        encoding: "utf8",
      }).trim();
      const { receipt, pngs } = await renderImageRelease(
        source.summary,
        revision,
        budget,
      );
      for (const [imagePath, png] of Object.entries(pngs))
        await writeFile(path.join(directory, path.basename(imagePath)), png, {
          flag: "wx",
        });
      await writeFile(path.join(directory, "render.json"), jsonBytes(receipt), {
        flag: "wx",
      });
      console.log(stableStringify(receipt));
    } else {
      const { receipt, pngs } = await readImageRender(directory);
      const operation = planImageRelease(source, receipt, pngs);
      if (mode === "publish") {
        const revision = execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repoRoot,
          encoding: "utf8",
        }).trim();
        if (receipt.renderer_revision !== revision)
          throw new Error(
            "Reviewed bundle renderer differs from the publishing checkout.",
          );
        const store = createReleaseStore(true, budget);
        await releaseJournalActive(store, false);
        const result = await commitArtifactRelease(store, operation);
        await writeFile(
          path.join(directory, "publication.json"),
          jsonBytes(result),
        );
        console.log(stableStringify(result));
        if (result.status === "pointer-pending") process.exitCode = 2;
      } else {
        console.log(
          stableStringify({
            status: "planned",
            id: operation.id,
            base: operation.base,
            target: operation.target,
            objects: operation.objects.map((object) => ({
              key: object.key,
              content_type: object.contentType,
              size_bytes: object.bytes.length,
            })),
          }),
        );
      }
    }
  }
}
