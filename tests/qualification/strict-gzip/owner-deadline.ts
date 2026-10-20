// Reporting a deadline does not claim native event cancellation. Callers must
// still dispose the owned runtime and close their controller connections.
export async function withinOwnerDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 120_000
  )
    throw new Error("Invalid owner deadline");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Owner operation deadline exceeded")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
