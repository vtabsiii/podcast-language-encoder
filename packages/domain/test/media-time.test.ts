import { describe, expect, test } from 'vitest';
import fc from 'fast-check';
import {
  fromMilliseconds,
  fromRational,
  fromSeconds,
  micros,
  overlapDuration,
  overlaps,
  range,
  toSeconds,
  toSrtTimestamp,
  toVttTimestamp,
} from '../src/index.js';

describe('media time', () => {
  test('rejects negative and non-integer values', () => {
    expect(() => micros(-1)).toThrow(RangeError);
    expect(() => micros(1.5)).toThrow(RangeError);
    expect(() => micros(Number.MAX_SAFE_INTEGER + 2)).toThrow(RangeError);
  });

  test('rational conversion is exact for common time bases', () => {
    // 90 kHz MPEG-TS clock: pts 90000 == 1 s
    expect(fromRational(90000, 1, 90000)).toBe(1_000_000);
    // 29.97 fps frame 1001 at 1/30000 base == 0.0333667 s → rounds to 33367 µs
    expect(fromRational(1001, 1, 30000)).toBe(33367);
    // 48 kHz audio sample 48000 == 1 s
    expect(fromRational(48000, 1, 48000)).toBe(1_000_000);
  });

  test('property: fromSeconds/toSeconds round-trips within one microsecond', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), (s) => {
        const back = toSeconds(fromSeconds(s));
        expect(Math.abs(back - s)).toBeLessThanOrEqual(5e-7);
      }),
    );
  });

  test('property: overlapDuration is symmetric and bounded by the shorter range', () => {
    const r = fc
      .tuple(fc.nat(10_000_000), fc.nat(10_000_000))
      .map(([a, b]) => range(micros(Math.min(a, b)), micros(Math.max(a, b))));
    fc.assert(
      fc.property(r, r, (a, b) => {
        const o = overlapDuration(a, b);
        expect(o).toBe(overlapDuration(b, a));
        expect(o).toBeLessThanOrEqual(Math.min(a.end - a.start, b.end - b.start));
        expect(o > 0).toBe(overlaps(a, b));
      }),
    );
  });

  test('caption timestamps', () => {
    expect(toSrtTimestamp(fromMilliseconds(3_723_456))).toBe('01:02:03,456');
    expect(toVttTimestamp(fromMilliseconds(3_723_456))).toBe('01:02:03.456');
    expect(toSrtTimestamp(micros(999_500))).toBe('00:00:01,000'); // rounds to nearest ms
  });
});
