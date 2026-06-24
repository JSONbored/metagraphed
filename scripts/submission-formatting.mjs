import { formatRepositoryJson } from "./lib.mjs";

export async function submissionFormattingErrors(entries = []) {
  const errors = [];
  for (const entry of entries) {
    if (!entry?.file || !entry.document || typeof entry.raw !== "string") {
      continue;
    }
    const formatted = await formatRepositoryJson(entry.document);
    if (entry.raw !== formatted) {
      errors.push(
        `${entry.file} is not formatted with the repository JSON style; run Prettier or regenerate it with npm run surface:add/provider:new`,
      );
    }
  }
  return errors;
}
