/**
 * Historical standalone equivalence failures, preserved explicitly.
 * This is proposed resource policy, not an equivalence waiver or active route.
 */
export const strictGzipPolicyDifferences = [
  { name: "bad-crc", priorTest: "native error/expansion precedence: bad-crc" },
  {
    name: "bad-isize",
    priorTest: "native error/expansion precedence: bad-isize",
  },
  {
    name: "truncated",
    priorTest: "native error/expansion precedence: truncated",
  },
  {
    name: "trailing-zero",
    priorTest: "native error/expansion precedence: trailing-zero",
  },
] as const;

export const strictGzipPriorQualification = {
  sourceSha256:
    "ee7e96a9ea415685cd823819282eb7631911df8e73ced7d6ec28c810fe228d43",
  formattedSourceSha256:
    "35ecab0f350a22fc3b5e86a97aa04534ca5b8537fdaa46ca46468340191c95dd",
  currentSourceSha256:
    "5b7e858b87ab29fef86dc374c48a5ee105bb7c4d3af3a5f1fa603f46a4fd6dec",
  equivalenceGate: "failed-preserved",
  oldNativeDisposition: "malformed",
  boundedCandidateDisposition: "resource-refusal",
  scaledBudget: 32_768,
  decodedBytes: 65_537,
  inputConsumedAtRefusal: 62,
  acceptedBytesAtRefusal: 32_768,
  outputDrainedAtRefusal: 40_960,
  outputProducedAtRefusal: 49_152,
} as const;
