import type { HttpSurfaceAdmission } from "../schemas-src/subnet-http-admission.ts";
import { matchSchemaOperation } from "./call-subnet-surface.ts";

/** Reuse the existing OpenAPI path matcher and body/media gate without inventing
 * an upstream OpenAPI document or fetching a provider during request admission. */
export function matchReviewedHttpOperation(
  admission: HttpSurfaceAdmission,
  path: string,
  method: string,
) {
  if (
    new URL(path, "https://admission.invalid").pathname !== path ||
    /%(?:2f|5c)/i.test(path)
  )
    return null;
  const paths: Record<string, Record<string, object>> = {};
  for (const operation of admission.operations) {
    const item = (paths[operation.path] ??= {});
    item[operation.method.toLowerCase()] = {
      ...(operation.parameters ? { parameters: operation.parameters } : {}),
      ...(operation.request_content_types
        ? {
            requestBody: {
              required: operation.request_body_required === true,
              content: Object.fromEntries(
                operation.request_content_types.map((type) => [type, {}]),
              ),
            },
          }
        : {}),
    };
  }
  return matchSchemaOperation({ paths }, path, method);
}
