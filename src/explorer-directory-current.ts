import { AccountHolderDirectoryArtifactSchema } from "../schemas-src/routes/account-holder-directory.ts";
import { ValidatorOperatorDirectoryArtifactSchema } from "../schemas-src/routes/validator-operator-directory.ts";
import {
  KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
  KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
} from "./kv-keys.ts";
import type { ExplorerDirectoryMaterialization } from "./explorer-directory-materialization.ts";

type DirectoryKv = {
  get(key: string, type: "json"): Promise<unknown>;
};

type DirectorySchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

async function readCurrentDirectory<T>(
  kv: DirectoryKv | null | undefined,
  key: string,
  schema: DirectorySchema<T>,
  label: string,
): Promise<T | null> {
  if (!kv) return null;
  try {
    const parsed = schema.safeParse(await kv.get(key, "json"));
    return parsed.success ? parsed.data : null;
  } catch (error) {
    console.error(`${label} directory materialization read failed:`, error);
    return null;
  }
}

export function readCurrentAccountDirectory(
  kv: DirectoryKv | null | undefined,
): Promise<ExplorerDirectoryMaterialization["accounts"] | null> {
  return readCurrentDirectory(
    kv,
    KV_EXPLORER_ACCOUNT_DIRECTORY_CURRENT,
    AccountHolderDirectoryArtifactSchema,
    "account",
  );
}

export function readCurrentValidatorDirectory(
  kv: DirectoryKv | null | undefined,
): Promise<ExplorerDirectoryMaterialization["validators"] | null> {
  return readCurrentDirectory(
    kv,
    KV_EXPLORER_VALIDATOR_DIRECTORY_CURRENT,
    ValidatorOperatorDirectoryArtifactSchema,
    "validator",
  );
}
