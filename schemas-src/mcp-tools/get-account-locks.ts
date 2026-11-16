import { z } from "zod";
import { AccountLocksArtifactSchema } from "../routes/account-locks.ts";
import { ss58Schema } from "./shared.ts";

export const GetAccountLocksInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();

export const GetAccountLocksOutputSchema = AccountLocksArtifactSchema;
