// Hermetic native transport fixture. The portable metadata comes from the
// pinned reference library's Substrate fixture; this is not a chain observation.
import metadata15 from "./native-metadata-v15.ts";
export async function withNativeRuntimeFixture<T>(
  run: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    const requests = JSON.parse(String(init?.body));
    const reply = (request: {
      id: unknown;
      method: string;
      params: unknown[];
    }) => {
      let result: unknown;
      switch (request.method) {
        case "chain_getFinalizedHead":
          result = `0x${"33".repeat(32)}`;
          break;
        case "chain_getHeader":
          result = { number: "0x1f4" };
          break;
        case "chain_getBlockHash":
          result = `0x${"44".repeat(32)}`;
          break;
        case "state_getRuntimeVersion":
          result = {
            specName: "node-subtensor",
            specVersion: 470,
            transactionVersion: 1,
          };
          break;
        case "state_call":
          if (request.params[0] !== "Metadata_metadata_at_version")
            throw new Error("Unexpected native fixture runtime call");
          result = metadata15;
          break;
        case "state_getStorage":
          result = "0xf4010000";
          break;
        default:
          throw new Error("Unexpected native fixture RPC method");
      }
      return { jsonrpc: "2.0", id: request.id, result };
    };
    return Response.json(
      Array.isArray(requests) ? requests.map(reply) : reply(requests),
    );
  };
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}
