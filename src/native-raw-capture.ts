import type { RawCaptureStore, WatermarkStore } from "./raw-chain-capture.ts";
import { recordOrNull } from "./read-store.ts";

export interface NativeRawCapture {
  readonly store: RawCaptureStore;
  watermark(network: string): WatermarkStore;
}

/** Storage and frontier move together; a selected native owner never falls
 * through to another database when incomplete or invalid. */
export function selectedNativeRawCapture(
  env: unknown,
): NativeRawCapture | undefined {
  const values = recordOrNull(env);
  const selected = values?.NATIVE_RAW_CAPTURE;
  if (selected === undefined) {
    if (values?.RAW_CAPTURE_STORAGE === "postgresql")
      throw new TypeError("Selected native raw capture is unavailable");
    return undefined;
  }
  const binding = recordOrNull(selected);
  const store = recordOrNull(binding?.store);
  if (
    values?.RAW_CAPTURE_STORAGE !== "postgresql" ||
    typeof store?.put !== "function" ||
    typeof binding?.watermark !== "function"
  )
    throw new TypeError("Selected native raw capture is invalid");
  return selected as NativeRawCapture;
}
