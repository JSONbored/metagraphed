import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { RawCode } from "@jsonbored/ui-kit";
import { ApiError } from "@/lib/metagraphed/client";
import { extrinsicRawUrl, fetchExtrinsicRaw } from "@/lib/metagraphed/extrinsic-raw";

export function ExtrinsicRawRecord({ reference }: { reference: string }) {
  const url = extrinsicRawUrl(reference);
  // API base and network are part of the identity, as well as the extrinsic ref.
  return <ExactResponse key={url} url={url} />;
}

function ExactResponse({ url }: { url: string }) {
  const [requested, setRequested] = useState(false);
  const record = useQuery({
    queryKey: ["extrinsic-exact-api-response", url],
    queryFn: ({ signal }) => fetchExtrinsicRaw(url, signal),
    enabled: requested,
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <div className="min-w-0 space-y-2">
      <p>
        Load the exact API response text on demand, up to 1 MiB. This preserves the returned JSON
        text; it does not recover arguments missing from the index or provide original chain bytes.
      </p>
      <button
        type="button"
        className="underline underline-offset-4"
        disabled={record.isFetching}
        onClick={() => {
          if (requested) void record.refetch();
          else setRequested(true);
        }}
      >
        {!requested
          ? "Load exact API response"
          : record.isError
            ? "Retry exact API response"
            : "Reload exact API response"}
      </button>
      {requested && record.isPending ? <p role="status">Loading exact API response…</p> : null}
      {requested && record.isError ? (
        <p role="alert">
          Exact API response unavailable
          {record.error instanceof ApiError
            ? ` (${record.error.status} · ${record.error.code ?? "request failed"})`
            : ""}
          : {record.error.message}
        </p>
      ) : null}
      {requested && record.isSuccess && !record.isFetching ? (
        <RawCode label="exact API response text">{record.data}</RawCode>
      ) : null}
    </div>
  );
}
