// Lists the registered provider slugs to use as `--provider <slug>` for
// `npm run surface:add`. Slugs (the left column) print to stdout; the summary
// goes to stderr so the list can be piped/grepped cleanly. Pass `--json` for
// machine-readable output.
import { loadProviders } from "./lib.mjs";

type Row = Record<string, unknown>;

const providers: Row[] = (await loadProviders())
  .slice()
  .sort((a: Row, b: Row) => String(a.id).localeCompare(String(b.id)));

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
      "`--provider <slug>` for `npm run surface:add` " +
      "(or pass --provider-name + --provider-url to surface:add to debut a new one).",
  );
}
