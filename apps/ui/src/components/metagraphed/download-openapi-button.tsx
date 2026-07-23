import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { downloadJsonFromUrl } from "@/lib/metagraphed/download-json";
import { classNames } from "@/lib/metagraphed/format";

export interface DownloadOpenApiButtonProps {
  /**
   * Full URL to the openapi.json to fetch and save. Pass the raw,
   * unwrapped spec (e.g. `${DEFAULT_API_BASE}/metagraph/openapi.json`),
   * not `/api/v1/openapi.json` — the latter wraps it in this app's usual
   * `{ok, schema_version, data}` API envelope, which isn't a valid OpenAPI
   * document a tool like Postman/Swagger could import directly.
   */
  url: string;
  className?: string;
}

/** Fetches the OpenAPI spec and saves it locally as `openapi.json` — see downloadJsonFromUrl for why this can't be a plain anchor. */
export function DownloadOpenApiButton({ url, className }: DownloadOpenApiButtonProps) {
  const [pending, setPending] = useState(false);

  async function handleClick() {
    setPending(true);
    try {
      await downloadJsonFromUrl(url, "openapi.json");
    } catch {
      toast.error("Couldn't download the OpenAPI spec — try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={pending}
      aria-label="Download OpenAPI spec"
      title="Download openapi.json"
      className={classNames(
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 mg-type-label uppercase text-ink transition-colors hover:border-ink/30 disabled:cursor-not-allowed disabled:opacity-60",
        className,
      )}
    >
      {pending ? (
        <Loader2 className="size-3 animate-spin" aria-hidden />
      ) : (
        <Download className="size-3" aria-hidden />
      )}
      Download spec
    </button>
  );
}
