import { z } from "zod";

import { AccountHolderDirectoryArtifactSchema } from "../schemas-src/routes/account-holder-directory.ts";
import { ValidatorOperatorDirectoryArtifactSchema } from "../schemas-src/routes/validator-operator-directory.ts";
import {
  KV_EXPLORER_DIRECTORIES_CURRENT,
  explorerDirectoriesSnapshotKey,
} from "./kv-keys.ts";
import type { buildAccountHolderDirectory } from "./account-holder-directory.ts";
import type { buildValidatorOperatorDirectory } from "./validator-operator-directory.ts";

export type ExplorerDirectoryMaterialization = {
  schema_version: 1;
  captured_at: number;
  accounts: ReturnType<typeof buildAccountHolderDirectory>;
  validators: ReturnType<typeof buildValidatorOperatorDirectory>;
};

export type ExplorerDirectoryPointer = {
  schema_version: 1;
  captured_at: number;
  route_values_ready?: true;
};

type ExplorerDirectoryKv = Pick<KVNamespace, "get">;

const ExplorerDirectoryPointerSchema = z
  .object({
    schema_version: z.literal(1),
    captured_at: z.number().int().positive().max(8_640_000_000_000_000),
    route_values_ready: z.literal(true).optional(),
  })
  .strict();

const ExplorerDirectoryMaterializationSchema = z
  .object({
    schema_version: z.literal(1),
    captured_at: z.number().int().positive().max(8_640_000_000_000_000),
    accounts: AccountHolderDirectoryArtifactSchema,
    validators: ValidatorOperatorDirectoryArtifactSchema,
  })
  .strict()
  .superRefine((value, refinement) => {
    const capturedAt = new Date(value.captured_at).toISOString();
    if (
      value.accounts.captured_at !== capturedAt ||
      value.validators.captured_at !== capturedAt
    ) {
      refinement.addIssue({
        code: "custom",
        message: "directory snapshots do not match the materialization stamp",
      });
    }
  });

export function materializationFromUnknown(
  value: unknown,
): ExplorerDirectoryMaterialization | null {
  const parsed = ExplorerDirectoryMaterializationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function pointerFromUnknown(
  value: unknown,
): ExplorerDirectoryPointer | null {
  const parsed = ExplorerDirectoryPointerSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function readExplorerDirectoryPointer(
  kv: ExplorerDirectoryKv | null | undefined,
): Promise<ExplorerDirectoryPointer | null> {
  if (!kv) return null;
  try {
    return pointerFromUnknown(
      await kv.get(KV_EXPLORER_DIRECTORIES_CURRENT, "json"),
    );
  } catch (error) {
    console.error(
      "explorer directory materialization pointer read failed:",
      error,
    );
    return null;
  }
}

export async function readExplorerDirectoryMaterialization(
  kv: ExplorerDirectoryKv | null | undefined,
): Promise<ExplorerDirectoryMaterialization | null> {
  if (!kv) return null;
  try {
    const pointer = await readExplorerDirectoryPointer(kv);
    if (!pointer) return null;
    const raw = await kv.get(
      explorerDirectoriesSnapshotKey(pointer.captured_at),
      "json",
    );
    const materialization = materializationFromUnknown(raw);
    return materialization?.captured_at === pointer.captured_at
      ? materialization
      : null;
  } catch (error) {
    console.error("explorer directory materialization read failed:", error);
    return null;
  }
}
