import base from "../vitest.config.ts";

// The initial diagnostic run does not enable coverage. The canonical provider,
// include/exclude sets and all floors remain inherited for later qualification.
export default {
  ...base,
  test: {
    ...base.test,
  },
};
