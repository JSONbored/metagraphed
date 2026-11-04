const MINUTE = 60_000;
const DAY = 1440 * MINUTE;

export interface NativeCronWindow {
  count: number;
  first: number | null;
  last: number | null;
  previous: number | null;
}

function field(source: string, size: number): number[] {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    if (item === "*") {
      for (let value = 0; value < size; value++) values.add(value);
    } else if (/^\*\/[1-9]\d*$/.test(item)) {
      const step = Number(item.slice(2));
      if (step > size) throw new RangeError("Unsupported native cron step");
      for (let value = 0; value < size; value += step) values.add(value);
    } else if (/^\d+$/.test(item) && Number(item) < size) {
      values.add(Number(item));
    } else throw new RangeError("Unsupported native cron field");
  }
  return [...values].sort((a, b) => a - b);
}

/** Current UTC grid only; new calendar syntax must be implemented explicitly. */
export function parseNativeCron(cron: string) {
  const fields = cron.split(" ");
  if (fields.length !== 5 || fields.slice(2).some((value) => value !== "*"))
    throw new RangeError("Native cron requires wildcard calendar fields");
  const minutes = field(fields[0]!, 60);
  const hours = field(fields[1]!, 24);
  const offsets = hours.flatMap((hour) =>
    minutes.map((minute) => hour * 60 + minute),
  );
  const countThrough = (time: number): number => {
    if (time === -1) return 0;
    const days = Math.floor(time / DAY);
    const minute = Math.floor((time - days * DAY) / MINUTE);
    return (
      days * offsets.length +
      offsets.filter((offset) => offset <= minute).length
    );
  };
  const occurrence = (index: number): number =>
    Math.floor(index / offsets.length) * DAY +
    offsets[index % offsets.length]! * MINUTE;
  return {
    cron,
    window(afterExclusive: number, throughInclusive: number): NativeCronWindow {
      if (
        !Number.isSafeInteger(afterExclusive) ||
        afterExclusive < -1 ||
        !Number.isSafeInteger(throughInclusive) ||
        throughInclusive < 0 ||
        afterExclusive > throughInclusive
      )
        throw new RangeError(
          "Native cron window requires ordered safe timestamps",
        );
      const before = countThrough(afterExclusive);
      const through = countThrough(throughInclusive);
      const count = through - before;
      return {
        count,
        first: count ? occurrence(before) : null,
        last: count ? occurrence(through - 1) : null,
        previous: count > 1 ? occurrence(through - 2) : null,
      };
    },
  };
}
