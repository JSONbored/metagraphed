import type { NeuronMirrorInput } from "./neurons-neon-write.ts";

/** One commit owns current state, both history families and the pass receipt. */
export interface NeuronCaptureStore {
  write(input: NeuronMirrorInput, signal?: AbortSignal): Promise<number>;
}

export function selectedNeuronCaptureStore(
  env: unknown,
): NeuronCaptureStore | undefined {
  if (!env || typeof env !== "object") return;
  const selected = (env as { NEURON_CAPTURE_STORE?: NeuronCaptureStore })
    .NEURON_CAPTURE_STORE;
  if (selected === undefined) return;
  if (!selected || typeof selected.write !== "function")
    throw new TypeError("Selected neuron capture store is invalid");
  return selected;
}
