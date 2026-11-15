import { z } from "zod";
import { AccountProxiesArtifactSchema } from "../routes/account-proxies.ts";
import { ss58Schema } from "./shared.ts";

export const GetAccountProxiesInputSchema = z
  .object({
    ss58: ss58Schema(),
  })
  .strict();

export const GetAccountProxiesOutputSchema = AccountProxiesArtifactSchema;
