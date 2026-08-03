// Serve the committed emission fixture (tests/fixtures/emission-pipeline.json)
// as a fake chain RPC. The fixture is the shared ground truth of the emission
// harness -- tests/emission-pipeline.test.ts pins the arithmetic against it,
// and the live drift check must reproduce a clean bill of health when the
// "chain" answers with exactly its raw hex. Header at the fixture block, maps
// answered per-key (null for absent netuids, exactly as the real RPC answers
// a queried-but-unset key), values answered by item hash.
import fixture from "../fixtures/emission-pipeline.json" with { type: "json" };

type HexMap = Record<string, string>;
const maps = fixture.maps as unknown as Record<string, HexMap>;
const values = fixture.values as unknown as Record<string, string | null>;
const itemHashes = fixture.item_hashes as Record<string, string>;

export interface RpcCall {
  method: string;
  params: unknown[];
}

/** `override(method, params)` may tamper with any answer; returning
 * `undefined` falls through to the fixture. */
export function fixtureFetch(
  override?: (method: string, params: unknown[]) => unknown | undefined,
): { impl: typeof fetch; calls: RpcCall[] } {
  const calls: RpcCall[] = [];
  const itemByHash = new Map<string, HexMap>(
    Object.entries(itemHashes)
      .filter(([name]) => name in maps)
      .map(([name, hash]) => [hash, maps[name]]),
  );
  const valueByHash = new Map<string, string | null>(
    Object.entries(itemHashes)
      .filter(([name]) => name in values)
      .map(([name, hash]) => [hash, values[name]]),
  );
  const prefix = (fixture.storage_prefix as string).slice(2);

  function answer(method: string, params: unknown[]): unknown {
    const overridden = override?.(method, params);
    if (overridden !== undefined) return overridden;
    if (method === "chain_getHeader")
      return { number: "0x" + fixture.block_number.toString(16) };
    if (method === "chain_getBlockHash") return fixture.block_hash;
    if (method === "state_queryStorageAt") {
      const keys = params[0] as string[];
      const changes = keys.map((key) => {
        const itemHash = key.slice(2 + prefix.length, -4);
        const suffix = key.slice(-4);
        const netuid =
          Number.parseInt(suffix.slice(0, 2), 16) +
          Number.parseInt(suffix.slice(2, 4), 16) * 256;
        return [key, itemByHash.get(itemHash)?.[String(netuid)] ?? null];
      });
      return [{ changes }];
    }
    if (method === "state_getStorage") {
      const key = params[0] as string;
      return valueByHash.get(key.slice(2 + prefix.length)) ?? null;
    }
    throw new Error(`unexpected method ${method}`);
  }

  const impl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: unknown[];
    };
    calls.push({ method: body.method, params: body.params });
    return {
      ok: true,
      json: async () => ({ result: answer(body.method, body.params) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}
