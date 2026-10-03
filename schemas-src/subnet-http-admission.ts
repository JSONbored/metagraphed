import { z } from "zod";
import { QUERY_ENUMS } from "./query-enums.ts";

/** Source-reviewed HTTP calls. This declaration never enables health probes. */
export const HttpSurfaceAdmissionSchema = z
  .object({
    operations: z
      .array(
        z
          .object({
            method: z.enum(QUERY_ENUMS.surfaceMethod),
            path: z
              .string()
              .min(1)
              .max(2048)
              .regex(/^\/(?!\/)[^?#\\]*$/),
            request_content_types: z
              .array(z.string().min(1).max(128))
              .min(1)
              .max(16)
              .optional(),
            request_body_required: z.boolean().optional(),
          })
          .strict()
          .refine(
            (operation) =>
              !operation.request_body_required ||
              operation.request_content_types !== undefined,
            "A required HTTP request body must declare its content types.",
          ),
      )
      .min(1)
      .max(512)
      .refine(
        (operations) =>
          new Set(operations.map(({ method, path }) => `${method} ${path}`))
            .size === operations.length,
        "HTTP operation admissions must be unique.",
      ),
  })
  .strict();

export type HttpSurfaceAdmission = z.infer<typeof HttpSurfaceAdmissionSchema>;
