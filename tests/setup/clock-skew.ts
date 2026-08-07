// Run the suite as if it were N days from now, to make time bombs go off on
// demand instead of on whatever morning they expire (#9689).
//
// ## What this is for
//
// On 2026-08-07 three tests in tests/tao-usd-series.test.ts started failing
// and would have failed every day after. Nothing about them had changed: the
// file pinned an absolute `NOW`, seeded rows at `NOW - offset`, and then asked
// a SERVED handler — which has no clock injection point — to select them
// relative to real `Date.now()`. Those two drift apart one second per second,
// and once the gap passed the route's 24h window every seeded row fell outside
// it.
//
// That class of defect is invisible to a normal run, because a normal run
// happens today, and today the calendar still cooperates. A sweep found 53
// hardcoded epoch constants under tests/, 41 of them minted within 120 days of
// when they were written — i.e. written to mean "now". Most inject a clock and
// are fine. Which ones is not something anyone should be inferring by hand.
//
// So: set TEST_CLOCK_SKEW_DAYS and the whole suite runs in the future. A test
// that only passes because of what the wall clock says today fails there.
//
// ## Why a Date subclass rather than vi.useFakeTimers()
//
// Fake timers replace setTimeout/setInterval/queueMicrotask as well, which
// this suite genuinely uses — several files await real timers, and the MCP
// notification drain in src/mcp-sdk-adapter.ts depends on real microtask
// ordering. Freezing or virtualising those would fail tests for reasons that
// have nothing to do with the calendar, which is the opposite of what a
// time-bomb detector is worth having. Shifting the CLOCK while leaving timers
// alone is the narrow change: `Date.now()` and `new Date()` move, everything
// about scheduling stays exactly as it was.
//
// ## Unset means untouched
//
// With no TEST_CLOCK_SKEW_DAYS this file installs nothing and returns before
// touching a global. The normal suite is byte-for-byte unaffected — a guard
// that perturbs the run it is guarding is worse than no guard.
const raw = process.env.TEST_CLOCK_SKEW_DAYS;

if (raw) {
  const days = Number(raw);
  if (!Number.isFinite(days)) {
    throw new Error(
      `TEST_CLOCK_SKEW_DAYS must be a number, got ${JSON.stringify(raw)}.`,
    );
  }

  const offsetMs = days * 86_400_000;
  const RealDate = Date;
  const realNow = RealDate.now;

  // Subclassed rather than patched in place: `new Date()` with no arguments
  // must shift, while every explicit form (`new Date(ms)`, `new Date(iso)`,
  // `new Date(y, m, d)`) must not. A test that pins an expected ISO string
  // builds it explicitly, and rewriting those would make the guard report
  // failures it had itself caused.
  class SkewedDate extends RealDate {
    constructor(...args: ConstructorParameters<typeof Date> | []) {
      if (args.length === 0) {
        super(realNow() + offsetMs);
      } else {
        super(...args);
      }
    }

    static now(): number {
      return realNow() + offsetMs;
    }
  }

  globalThis.Date = SkewedDate as unknown as DateConstructor;

  // Announced once per worker. A run whose whole purpose is "pretend it is
  // later" must say so in its output, or a failure it surfaces reads as a
  // mystery regression rather than an expiry.
  console.log(
    `[clock-skew] running as if ${days} day(s) from now — ` +
      `${new RealDate(realNow() + offsetMs).toISOString()}`,
  );
}
