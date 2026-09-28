// Internal storage contract shared by the registry publisher and Worker.
import { z } from "zod";

export const RegistryDigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const RegistryArtifactSchema = z.object({
  path: z.string().regex(/^\/metagraph\/[A-Za-z0-9_./:-]+$/),
  sha256: RegistryDigestSchema,
  size_bytes: z
    .number()
    .int()
    .min(0)
    .max(25 * 1024 * 1024),
});
export const RegistryManifestSchema = z
  .object({
    version: z.literal(1),
    artifacts: z.array(RegistryArtifactSchema).min(1).max(20_000),
  })
  .superRefine((manifest, context) => {
    const paths = new Set<string>();
    for (const artifact of manifest.artifacts) {
      if (paths.has(artifact.path) || artifact.path.split("/").includes("..")) {
        context.addIssue({
          code: "custom",
          message: "Invalid or duplicate artifact path",
        });
      }
      paths.add(artifact.path);
    }
  });

export type RegistryArtifact = z.infer<typeof RegistryArtifactSchema>;
export type RegistryManifest = z.infer<typeof RegistryManifestSchema>;
