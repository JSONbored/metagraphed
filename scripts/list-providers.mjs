// Lists the registered provider slugs to use as `--provider <slug>` for
// `npm run candidate:new`. Slugs (the left column) print to stdout; the summary
// goes to stderr so the list can be piped/grepped cleanly. Pass `--json` for
// machine-readable output.
import { loadProviders } from "./lib.mjs";

const providers = (await loadProviders())
  .slice()
  .sort((a, b) => String(a.id).localeCompare(String(b.id)));

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      providers.map((provider) => ({
        id: provider.id,
        name: provider.name,
        kind: provider.kind,
      })),
      null,
      2,
    ),
  );
} else {
  for (const provider of providers) {
    const suffix = provider.kind ? `  (${provider.kind})` : "";
    console.log(
      `${String(provider.id).padEnd(28)} ${provider.name || ""}${suffix}`,
    );
  }
  console.error(
    `\n${providers.length} providers. Use the left-column slug as ` +
      "`--provider <slug>` for `npm run candidate:new` " +
      "(or `npm run provider:new` to register a new one).",
  );
}
