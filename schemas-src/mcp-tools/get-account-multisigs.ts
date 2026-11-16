import { z } from "zod";
import { AccountMultisigsArtifactSchema } from "../routes/account-multisigs.ts";
import { ss58Schema } from "./shared.ts";

export const GetAccountMultisigsInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();

export const GetAccountMultisigsOutputSchema = AccountMultisigsArtifactSchema;
