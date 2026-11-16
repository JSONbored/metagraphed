import type { AccountKind } from "./account-kind.ts";
import type { BlockVerdict } from "./api-key-abuse.ts";

export interface AccountBlockStore {
  read(accountId: number, accountKind: AccountKind): Promise<BlockVerdict>;
}

export function selectedAccountBlockStore(
  env: unknown,
): AccountBlockStore | null {
  if (!env || typeof env !== "object" || !("ACCOUNT_BLOCK_STORE" in env))
    return null;
  const store = env.ACCOUNT_BLOCK_STORE;
  if (!store || typeof (store as AccountBlockStore).read !== "function")
    throw new TypeError("Native account block capability is incomplete");
  return store as AccountBlockStore;
}
