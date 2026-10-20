import base from "../vitest.config.ts";

export default {
  ...base,
  test: {
    ...base.test,
    coverage: {
      ...base.test?.coverage,
      include: [
        "src/raw-capture-d1.ts",
        "src/raw-chain-capture.ts",
        "src/raw-capture-retry-intent.ts",
        "src/raw-capture-retry-store.ts",
      ],
      exclude: [],
    },
  },
};

